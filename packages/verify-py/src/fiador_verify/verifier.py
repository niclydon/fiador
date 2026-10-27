"""The verifier: verify_address, verify_attestation, resolve_status,
and verify_signed_message (SPEC 3.1, 3.3, 3.5, 3.6).

The library never raises for an expected failure (bad input,
unregistered wallet, dead RPC): every error path returns a result
with a status and failure codes, and no error path returns
'verified'. It raises only for programmer error, such as a malformed
contract address at construction time (SPEC 3.0).
"""

from __future__ import annotations

import dataclasses
import inspect
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Optional

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak

from .addresses import checksum_address, is_address
from .canonical import (
    canonical_attestation_message,
    parse_iso8601_z_ms,
    validate_signed_attestation,
)
from .hashes import hash_human_id, truncate_address
from .reader import (
    AGENTBOOK_CONTRACT,
    DEFAULT_RPC_URL,
    JsonRpcClient,
    LiveReader,
    RpcRevert,
    RpcTimeout,
    assert_rpc_url_allowed,
)
from .types import (
    WORLD_CHAIN_ID,
    WORLD_CHAIN_NETWORK,
    AgentBookRef,
    AttestedSubject,
    AttestationSubjectInput,
    CheckEvidence,
    RegistrationLookupFact,
    SignedAttestation,
    SignedMessageResult,
    Subject,
    VerifyAttestationOptions,
    VerifyCoreOptions,
    VerifyResult,
)

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
ERC1271_MAGIC = "0x1626ba7e"
MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000
_IS_VALID_SIGNATURE_SELECTOR = "0x1626ba7e"  # isValidSignature(bytes32,bytes)
_ADDRESS_SHAPE = re.compile(r"^0x[0-9a-fA-F]{40}$")
# The canonical humanId shape (SPEC 3.1/3.5): 0x-prefixed 32-byte hex.
_HUMAN_ID_SHAPE = re.compile(r"0x[0-9a-fA-F]{64}")
_MAX_INFLIGHT_DEADLINE_CALLS = 8
_DEADLINE_SLOTS = threading.BoundedSemaphore(_MAX_INFLIGHT_DEADLINE_CALLS)


def eip191_digest(message: str) -> bytes:
    """The EIP-191 personal_sign digest of a message string."""
    data = message.encode("utf-8")
    prefix = b"\x19Ethereum Signed Message:\n" + str(len(data)).encode("ascii")
    return keccak(prefix + data)


def _is_valid_signature_calldata(digest: bytes, signature: bytes) -> str:
    offset = (64).to_bytes(32, "big")
    length = len(signature).to_bytes(32, "big")
    padded = signature + b"\x00" * ((-len(signature)) % 32)
    return _IS_VALID_SIGNATURE_SELECTOR + (digest + offset + length + padded).hex()


def _recover_message_address(message: str, signature: str) -> str:
    """EIP-191 recovery. Raises for an undecodable signature."""
    return Account.recover_message(encode_defunct(text=message), signature=signature)


def _signature_bytes(signature: str) -> bytes:
    raw = signature[2:] if signature.startswith("0x") else signature
    return bytes.fromhex(raw)


def _read_disclosure(attestation: Any) -> Optional[str]:
    """The payload's disclosure choice, when derivable from the raw
    input even before envelope validation (mirrors the TS core)."""
    payload: Any = None
    if isinstance(attestation, SignedAttestation):
        payload = attestation.payload
        disclosure = payload.human_id_disclosure
        return disclosure if disclosure in ("hash", "none") else None
    if isinstance(attestation, Mapping):
        payload = attestation.get("payload")
    if isinstance(payload, Mapping):
        disclosure = payload.get("humanIdDisclosure")
        if disclosure in ("hash", "none"):
            return disclosure
    return None


def _as_wire(attestation: Any) -> Any:
    if isinstance(attestation, SignedAttestation):
        return attestation.to_wire_dict()
    return attestation


def _as_utc(dt: datetime) -> datetime:
    """Injected clocks return datetimes; a naive one is read as UTC
    (the JS Date the TS core uses is always an absolute instant)."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _format_iso_z(dt: datetime) -> str:
    """JS Date.toISOString form: UTC, millisecond precision, 'Z'."""
    utc = _as_utc(dt).astimezone(timezone.utc)
    return f"{utc:%Y-%m-%dT%H:%M:%S}.{utc.microsecond // 1000:03d}Z"


def _call_resolver(resolver: Callable[..., Any], subject: Subject, signal: Any) -> Any:
    """Call a resolver with (subject), or (subject, signal) when it
    accepts a second positional argument — the Python form of the TS
    core passing the caller's AbortSignal (7.5 review M3)."""
    try:
        params = list(inspect.signature(resolver).parameters.values())
        positional = [
            p
            for p in params
            if p.kind
            in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
        ]
        varargs = any(p.kind == inspect.Parameter.VAR_POSITIONAL for p in params)
        arity = len(positional) + (2 if varargs else 0)
    except (TypeError, ValueError):
        arity = 1
    if arity >= 2:
        return resolver(subject, signal)
    return resolver(subject)


class _LookupOutcome:
    def __init__(
        self,
        state: str,
        latency_ms: int,
        human_id: Optional[str] = None,
        code: Optional[str] = None,
    ):
        self.state = state  # 'registered' | 'unregistered' | 'unknown'
        self.human_id = human_id
        self.code = code  # 'lookup_failed' | 'lookup_timeout'
        self.latency_ms = latency_ms


# Signature outcomes: ('match', None) | ('mismatch', None) |
# ('unknown', 'lookup_failed' | 'lookup_timeout').
_SignatureOutcome = tuple[str, Optional[str]]


class Verifier:
    def __init__(self, options: Optional[VerifyCoreOptions] = None):
        opts = options or VerifyCoreOptions()
        contract = opts.contract_address or AGENTBOOK_CONTRACT
        if not is_address(contract):
            # Programmer error, not an expected failure: the library
            # raises here and only here (SPEC 3.0). The message names
            # no value (7.5 review M14): configuration values are
            # operator material, not diagnostics.
            raise TypeError("create_verifier: malformed contract address")
        assert_rpc_url_allowed(opts.rpc_url)
        self._contract = contract
        self._reader = opts.reader or LiveReader(
            rpc_url=opts.rpc_url, contract_address=contract
        )
        self._timeout_ms = opts.timeout_ms
        self._now = opts.now or (lambda: datetime.now(timezone.utc))
        self._clock_skew_ms = opts.clock_skew_ms
        self._include_raw_human_id = opts.include_raw_human_id
        # The ERC-1271 client, over the same configured RPC (the chain's
        # public RPC when none is configured, as in the TS core). Its
        # HTTP timeout sits just past the verifier deadline; the
        # deadline race in _deadline_call is what bounds the check.
        self._rpc = JsonRpcClient(
            opts.rpc_url or DEFAULT_RPC_URL, timeout=self._timeout_ms / 1000.0 + 2.0
        )

    # -- internals -----------------------------------------------------

    def _safe_now(self) -> datetime:
        """Keep a faulty injected clock inside the result contract."""
        try:
            value = self._now()
            if isinstance(value, datetime):
                return _as_utc(value).astimezone(timezone.utc)
        except Exception:
            pass
        return datetime.now(timezone.utc)

    def _deadline_call(
        self, start: Callable[[], Any], signal: Any = None
    ) -> tuple[str, Any]:
        """Run an operation against the verifier's deadline and an
        optional caller abort event (a threading.Event). The operation
        is invoked INSIDE the guarded region (7.5 review M12): a
        collaborator that raises synchronously — before doing any
        work — is a 'failed' outcome, never an exception escaping a
        function whose contract is 'returns a result'.

        A Python parity adaptation: the operation runs on a daemon
        thread so a hung collaborator cannot hang the caller. A
        process-wide capacity bound prevents timed-out collaborators
        from spawning unbounded threads; their slot stays occupied
        until the underlying call actually ends. Saturation fails
        closed immediately. Returns (kind, value) with kind 'value' |
        'timeout' | 'aborted' | 'failed'."""
        if signal is not None and signal.is_set():
            return "aborted", None
        deadline = time.monotonic() + self._timeout_ms / 1000.0
        if self._timeout_ms <= 0:
            return "timeout", None
        if not _DEADLINE_SLOTS.acquire(blocking=False):
            return "failed", RuntimeError("deadline worker capacity exhausted")
        box: dict[str, Any] = {}

        def run() -> None:
            try:
                box["value"] = start()
            except BaseException as exc:  # collaborator contract: raise on failure
                box["error"] = exc
            finally:
                _DEADLINE_SLOTS.release()

        worker = threading.Thread(target=run, daemon=True)
        try:
            worker.start()
        except BaseException as exc:
            _DEADLINE_SLOTS.release()
            return "failed", exc
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return "timeout", None
            if signal is not None and signal.is_set():
                return "aborted", None
            worker.join(min(remaining, 0.005))
            if not worker.is_alive():
                break
        if "error" in box:
            return "failed", box["error"]
        return "value", box.get("value")

    def _evidence(self, latency_ms: Optional[int] = None) -> CheckEvidence:
        return CheckEvidence(
            checked_at=_format_iso_z(self._safe_now()),
            source=getattr(self._reader, "source", None) or "live",
            agent_book=AgentBookRef(network=WORLD_CHAIN_NETWORK, contract=self._contract),
            rpc_latency_ms=latency_ms,
        )

    def _build_result(
        self,
        status: str,
        address: str,
        failures: list[str],
        human_id: Optional[str] = None,
        latency_ms: Optional[int] = None,
        disclosure: Optional[str] = None,
        registration: Optional[RegistrationLookupFact] = None,
    ) -> VerifyResult:
        return VerifyResult(
            status=status,
            address=address,
            address_truncated=truncate_address(address),
            human_hash=(
                hash_human_id(human_id)
                if status == "verified" and human_id is not None
                else None
            ),
            failures=list(failures),
            evidence=self._evidence(latency_ms),
            human_id=human_id if (self._include_raw_human_id and human_id is not None) else None,
            disclosure=disclosure,
            registration=registration,
        )

    def _lookup(self, address: str, signal: Any = None) -> _LookupOutcome:
        start = time.monotonic()

        def latency_ms() -> int:
            return int(round((time.monotonic() - start) * 1000))

        kind, value = self._deadline_call(
            lambda: self._reader.lookup_human(address), signal
        )
        if kind == "value":
            # Fail closed on the VALUE (7.5 re-review N1): None is
            # the one unregistered signal; a string in the canonical
            # humanId shape is a registration; ANYTHING else a reader
            # resolves - a number, a malformed or unpadded string, a
            # mapping, raw bytes - is a lookup failure. A non-None
            # garbage value must never be hashed into a 'verified'
            # result. fullmatch, not a $-anchored match: in Python
            # '$' also matches before a trailing newline, which the
            # TS core's shape test rejects.
            if value is None:
                return _LookupOutcome("unregistered", latency_ms())
            if isinstance(value, str) and _HUMAN_ID_SHAPE.fullmatch(value):
                # The chain returns a uint256; hex letter case must not split its hash.
                return _LookupOutcome("registered", latency_ms(), human_id=value.lower())
            return _LookupOutcome("unknown", latency_ms(), code="lookup_failed")
        if kind == "timeout":
            return _LookupOutcome("unknown", latency_ms(), code="lookup_timeout")
        return _LookupOutcome("unknown", latency_ms(), code="lookup_failed")

    def _erc1271_check(
        self, wallet: str, message: str, signature: str, signal: Any = None
    ) -> _SignatureOutcome:
        """ERC-1271 validation for a smart-wallet signer, under the
        same deadline/abort race as the AgentBook lookup (7.5 review
        B1): a hanging eth_call must not hold verification open past
        timeout_ms. Three outcomes, honestly distinguished: the
        contract answered (match/mismatch), the read itself reverted
        or returned a non-magic value (mismatch — fail closed on the
        claim), or the network could not answer at all (unknown)."""

        def attempt() -> tuple[str, Optional[bool]]:
            # The configured RPC is the trust oracle for this answer
            # too; the chain-id call is a misconfiguration guard (it
            # catches an endpoint answering for another chain), not
            # an authentication of the RPC (7.5 review M17).
            if self._rpc.chain_id() != WORLD_CHAIN_ID:
                return "chain", None
            try:
                sig_bytes = _signature_bytes(signature)
            except ValueError:
                return "mismatch", None
            calldata = _is_valid_signature_calldata(eip191_digest(message), sig_bytes)
            try:
                result = self._rpc.eth_call(wallet, calldata)
            except RpcRevert:
                # A definitive contract revert rejects this signature.
                return "mismatch", None
            ok = isinstance(result, str) and result.lower()[:10] == ERC1271_MAGIC
            return "value", ok

        kind, value = self._deadline_call(attempt, signal)
        if kind == "timeout":
            return "unknown", "lookup_timeout"
        if kind == "failed" and isinstance(value, RpcTimeout):
            return "unknown", "lookup_timeout"
        if kind != "value":
            return "unknown", "lookup_failed"
        state, ok = value
        if state == "chain":
            return "unknown", "lookup_failed"
        if state == "mismatch":
            return "mismatch", None
        return ("match", None) if ok else ("mismatch", None)

    def _signature_check(
        self, attestation: SignedAttestation, message: str, signal: Any = None
    ) -> _SignatureOutcome:
        """The declared signature_type selects the ONE verification
        path (7.5 review B1): 'eip191' is pure local recovery and
        never touches the network; 'eip1271' never attempts
        recovery."""
        wallet = attestation.payload.agent_wallet_address
        if attestation.signature_type == "eip1271":
            return self._erc1271_check(wallet, message, attestation.signature, signal)
        try:
            recovered = _recover_message_address(message, attestation.signature)
        except Exception:
            return "mismatch", None
        return ("match", None) if recovered == wallet else ("mismatch", None)

    # -- public API ----------------------------------------------------

    def verify_address(self, address_input: Any, signal: Any = None) -> VerifyResult:
        if not is_address(address_input):
            return self._build_result("invalid", ZERO_ADDRESS, ["malformed_address"])
        try:
            address = checksum_address(address_input)
        except ValueError:
            return self._build_result("invalid", ZERO_ADDRESS, ["malformed_address"])
        outcome = self._lookup(address, signal)
        if outcome.state == "registered":
            return self._build_result(
                "verified", address, [], human_id=outcome.human_id, latency_ms=outcome.latency_ms
            )
        if outcome.state == "unregistered":
            return self._build_result(
                "unregistered", address, ["not_registered"], latency_ms=outcome.latency_ms
            )
        return self._build_result(
            "unknown", address, [outcome.code or "lookup_failed"], latency_ms=outcome.latency_ms
        )

    def verify_attestation(
        self,
        attestation: Any,
        options: Optional[VerifyAttestationOptions] = None,
        **overrides: Any,
    ) -> VerifyResult:
        opts = options or VerifyAttestationOptions()
        if overrides:
            opts = dataclasses.replace(opts, **overrides)
        disclosure = _read_disclosure(attestation)
        signed, failures, partial_wallet = validate_signed_attestation(_as_wire(attestation))
        if signed is None:
            return self._build_result(
                "invalid",
                partial_wallet or ZERO_ADDRESS,
                failures,
                disclosure=disclosure,
            )
        payload = signed.payload
        wallet = payload.agent_wallet_address
        failures = []
        # The step-6 lookup's fate, recorded for the SPEC 11.2
        # checks projection (TS fix pass 3, D6). Assigned when the
        # pipeline reaches step 6; stays None on earlier returns,
        # which is itself the fact that the lookup never ran.
        registration: Optional[RegistrationLookupFact] = None

        def finish(
            status: str,
            result_failures: Optional[list[str]] = None,
            human_id: Optional[str] = None,
            latency_ms: Optional[int] = None,
        ) -> VerifyResult:
            return self._build_result(
                status,
                wallet,
                failures if result_failures is None else result_failures,
                human_id=human_id,
                latency_ms=latency_ms,
                disclosure=disclosure,
                registration=registration,
            )

        # Step 2, binding (SPEC 3.3).
        if opts.expected_subject is not None and (
            opts.expected_subject.type != payload.subject.type
            or opts.expected_subject.id != payload.subject.id
        ):
            failures.append("subject_mismatch")
        if opts.expected_wallet is not None:
            # Expected-wallet comparison is on the normalised
            # (lowercased) forms (7.5 review m2): a differently-cased
            # or bad-checksum spelling of the same address is the
            # same wallet, and a non-string expectation is a
            # mismatch, never a throw.
            expected = opts.expected_wallet
            matches = (
                isinstance(expected, str)
                and _ADDRESS_SHAPE.match(expected) is not None
                and expected.lower() == wallet.lower()
            )
            if not matches:
                failures.append("wallet_mismatch")

        # Step 3, signature over the canonical form, on the declared path.
        message = canonical_attestation_message(payload)
        sig_kind, sig_code = self._signature_check(signed, message, opts.signal)

        # Step 4 facts (dates and the protocol lifetime cap) are
        # computed before any early return: they are established from
        # the payload alone, and per SPEC 3.3 precedence they outrank
        # 'unknown' — a network failure at the signature step must
        # not pre-empt an expiry or discard a binding failure (7.5
        # review B1). The skew applies to issued_at only, never to
        # expiry (SPEC 3.3, as built in TS).
        def current_ms() -> int:
            return int(self._safe_now().timestamp() * 1000)

        now_ms = current_ms()
        issued_ms = parse_iso8601_z_ms(payload.issued_at)
        expires_ms = parse_iso8601_z_ms(payload.expires_at)
        lifetime_invalid = (
            expires_ms <= issued_ms or expires_ms - issued_ms > MAX_LIFETIME_MS
        )
        not_yet_valid = issued_ms > now_ms + self._clock_skew_ms
        expired = expires_ms <= now_ms

        def date_failures() -> list[str]:
            out: list[str] = []
            if lifetime_invalid:
                out.append("attestation_lifetime_invalid")
            if not_yet_valid:
                out.append("not_yet_valid")
            if expired:
                out.append("expired")
            return out

        if sig_kind == "unknown":
            failures.extend(date_failures())
            invalid_class = any(f != "expired" for f in failures)
            if invalid_class:
                return finish("invalid", [*failures, sig_code or "lookup_failed"])
            if opts.nonce_store is not None:
                kind, replay = self._deadline_call(
                    lambda: opts.nonce_store.has(payload.nonce, wallet), opts.signal
                )
                if kind == "value" and replay is True:
                    # Keep the uncertain signature fact alongside established replay.
                    return finish(
                        "invalid", [*failures, sig_code or "lookup_failed", "replay_detected"]
                    )
            if expired:
                return finish("expired", [*failures, sig_code or "lookup_failed"])
            return finish("unknown", [sig_code or "lookup_failed"])
        if sig_kind == "mismatch":
            failures.append("signature_mismatch")
        failures.extend(date_failures())

        invalid_failures = [f for f in failures if f != "expired"]
        if invalid_failures:
            return finish("invalid")

        # Step 5, read-only replay check before expiry. This keeps an
        # existing claim's precedence without consuming a fresh nonce.
        # The atomic claim after registration decides concurrent races.
        if opts.nonce_store is not None:
            kind, replay = self._deadline_call(
                lambda: opts.nonce_store.has(payload.nonce, wallet), opts.signal
            )
            if kind != "value" or type(replay) is not bool:
                code = "lookup_failed"
                if expired:
                    return finish("expired", [*failures, code])
                return finish("unknown", [code])
            if replay is True:
                return finish("invalid", [*failures, "replay_detected"])

        if expired:
            # Expired outranks the lookup outcome (SPEC 3.3
            # precedence), so the network check is not run.
            return finish("expired")

        # Step 6, registration. Only a successful lookup (or an explicit
        # check_registration=False) may consume the nonce. Recheck the
        # verifier clock because the lookup can cross expires_at.
        outcome = self._lookup(wallet, opts.signal) if opts.check_registration else None
        registration = (
            RegistrationLookupFact(ran=False)
            if not opts.check_registration
            else RegistrationLookupFact(
                ran=True,
                outcome=(
                    "registered"
                    if outcome is not None and outcome.state == "registered"
                    else "unregistered"
                    if outcome is not None and outcome.state == "unregistered"
                    else "failed"
                ),
            )
        )
        if expires_ms <= current_ms():
            return finish("expired", ["expired"])
        if outcome is not None and outcome.state == "unknown":
            return finish(
                "unknown",
                [outcome.code or "lookup_failed"],
                latency_ms=outcome.latency_ms,
            )
        if outcome is not None and outcome.state == "unregistered":
            # A valid signature from an unregistered wallet attests nothing.
            return finish(
                "unregistered", ["not_registered"], latency_ms=outcome.latency_ms
            )
        if opts.nonce_store is not None:
            kind, claim = self._deadline_call(
                lambda: opts.nonce_store.claim(payload.nonce, wallet, payload.expires_at),
                opts.signal,
            )
            if kind == "timeout":
                return finish("unknown", ["lookup_failed"])
            if kind != "value":
                return finish("unknown", ["lookup_failed"])
            if claim == "replay":
                return finish("invalid", ["replay_detected"])
            if claim == "expired":
                return finish("expired", ["expired"])
            if claim != "claimed":
                return finish("unknown", ["lookup_failed"])
        if expires_ms <= current_ms():
            return finish("expired", ["expired"])
        return finish(
            "verified", [],
            human_id=outcome.human_id if outcome is not None else None,
            latency_ms=outcome.latency_ms if outcome is not None else None,
        )

    def resolve_status(self, subject: Any, signal: Any = None) -> VerifyResult:
        kind: Optional[str] = getattr(subject, "kind", None)
        if kind is None and isinstance(subject, Mapping):
            kind = subject.get("kind")
        if kind == "address":
            address = (
                subject.address if isinstance(subject, object) and hasattr(subject, "address")
                else subject["address"]
            )
            return self.verify_address(address, signal=signal)
        if kind == "attestation":
            attestation = subject.attestation if hasattr(subject, "attestation") else subject["attestation"]
            expected_subject = _subject_of(attestation)
            return self.verify_attestation(
                attestation,
                VerifyAttestationOptions(expected_subject=expected_subject, signal=signal),
            )
        if kind == "attested_subject":
            subj: Subject = subject.subject if hasattr(subject, "subject") else subject["subject"]
            if hasattr(subject, "resolve_attestation"):
                resolver = subject.resolve_attestation
            elif "resolveAttestation" in subject:
                resolver = subject["resolveAttestation"]
            else:
                resolver = subject["resolve_attestation"]
            # The resolver runs under the same deadline/abort race as
            # the AgentBook lookup and receives the caller's signal
            # (7.5 review M3): a hanging resolver must not hold
            # resolve_status open past timeout_ms.
            resolved_kind, resolved = self._deadline_call(
                lambda: _call_resolver(resolver, subj, signal), signal
            )
            if resolved_kind == "timeout":
                return self._build_result("unknown", ZERO_ADDRESS, ["lookup_timeout"])
            if resolved_kind != "value":
                return self._build_result("unknown", ZERO_ADDRESS, ["lookup_failed"])
            # A resolver returning None means no attestation for this
            # subject (7.5 review m1: the TS core's undefined == null).
            if resolved is None:
                return self._build_result(
                    "unknown", ZERO_ADDRESS, ["attestation_not_found"]
                )
            return self.verify_attestation(
                resolved,
                VerifyAttestationOptions(expected_subject=subj, signal=signal),
            )
        raise TypeError(f"resolve_status: unknown subject kind: {kind!r}")

    def verify_signed_message(
        self,
        message: str,
        signature: str,
        signature_type: str,
        expected_address: Optional[str] = None,
    ) -> SignedMessageResult:
        """Verify an arbitrary caller-canonicalised message (SPEC 3.6,
        D5 amendment). The caller declares the path: a contract address
        checked through the EOA path fails; it does not silently switch.
        No AgentBook lookup and no attestation semantics are performed;
        registration is composed by the caller through verify_address."""
        if signature_type == "eoa":
            expected: Optional[str] = None
            if expected_address is not None:
                if not is_address(expected_address):
                    return SignedMessageResult(False, None, ["malformed_address"])
                expected = checksum_address(expected_address)
            try:
                recovered = _recover_message_address(message, signature)
            except Exception:
                return SignedMessageResult(False, None, ["signature_mismatch"])
            if expected is not None and recovered != expected:
                return SignedMessageResult(False, recovered, ["subject_mismatch"])
            return SignedMessageResult(True, recovered, [])
        if signature_type == "erc1271":
            if expected_address is None:
                # No contract address to call: the declared path cannot
                # be verified, which fails closed as a signature failure.
                return SignedMessageResult(False, None, ["signature_mismatch"])
            if not is_address(expected_address):
                return SignedMessageResult(False, None, ["malformed_address"])
            contract = checksum_address(expected_address)
            kind, code = self._erc1271_check(contract, message, signature)
            if kind == "unknown":
                # The check itself could not run (RPC / chain
                # identity / deadline): an unchecked claim is not
                # reported either way.
                return SignedMessageResult(False, contract, [code or "lookup_failed"])
            if kind == "match":
                return SignedMessageResult(True, contract, [])
            return SignedMessageResult(False, contract, ["signature_mismatch"])
        return SignedMessageResult(False, None, ["signature_mismatch"])


def _subject_of(attestation: Any) -> Optional[Subject]:
    """The subject an attestation binds, when its fields are strings —
    used by resolve_status to take the expectation from the payload
    itself (SPEC 3.5), mirroring the TS core."""
    payload: Any = None
    if isinstance(attestation, SignedAttestation):
        payload = attestation.payload
        return Subject(type=payload.subject.type, id=payload.subject.id)
    if isinstance(attestation, Mapping):
        payload = attestation.get("payload")
    if isinstance(payload, Mapping):
        subject = payload.get("subject")
        if isinstance(subject, Mapping):
            stype, sid = subject.get("type"), subject.get("id")
            if isinstance(stype, str) and isinstance(sid, str):
                return Subject(type=stype, id=sid)
    return None


def create_verifier(
    options: Optional[VerifyCoreOptions] = None, **overrides: Any
) -> Verifier:
    """Build a Verifier. Options may be passed as a VerifyCoreOptions
    dataclass and/or as keyword overrides, e.g.
    ``create_verifier(reader=my_reader, timeout_ms=5000)``."""
    opts = options or VerifyCoreOptions()
    if overrides:
        opts = dataclasses.replace(opts, **overrides)
    return Verifier(opts)
