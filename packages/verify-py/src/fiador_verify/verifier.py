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
import threading
import time
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

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
from .reader import AGENTBOOK_CONTRACT, DEFAULT_RPC_URL, JsonRpcClient, LiveReader, RpcError
from .types import (
    WORLD_CHAIN_ID,
    WORLD_CHAIN_NETWORK,
    AgentBookRef,
    AttestedSubject,
    AttestationSubjectInput,
    CheckEvidence,
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


class Verifier:
    def __init__(self, options: Optional[VerifyCoreOptions] = None):
        opts = options or VerifyCoreOptions()
        contract = opts.contract_address or AGENTBOOK_CONTRACT
        if not is_address(contract):
            # Programmer error, not an expected failure: the library
            # raises here and only here (SPEC 3.0).
            raise TypeError(f"create_verifier: malformed contract address: {contract}")
        self._contract = contract
        self._reader = opts.reader or LiveReader(
            rpc_url=opts.rpc_url, contract_address=contract
        )
        self._timeout_ms = opts.timeout_ms
        self._now = opts.now or (lambda: datetime.now(timezone.utc))
        self._clock_skew_ms = opts.clock_skew_ms
        self._include_raw_human_id = opts.include_raw_human_id
        # The ERC-1271 client, over the same configured RPC (the chain's
        # public RPC when none is configured, as in the TS core).
        self._rpc = JsonRpcClient(opts.rpc_url or DEFAULT_RPC_URL)

    # -- internals -----------------------------------------------------

    def _evidence(self, latency_ms: Optional[int] = None) -> CheckEvidence:
        return CheckEvidence(
            checked_at=_format_iso_z(self._now()),
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
        )

    def _lookup(self, address: str, signal: Any = None) -> _LookupOutcome:
        """Run the reader under the deadline and the caller's abort
        event. A Python parity adaptation: the reader runs on a daemon
        thread so a hung reader cannot hang the caller (the TS core
        races promises the same way)."""
        start = time.monotonic()

        def latency_ms() -> int:
            return int(round((time.monotonic() - start) * 1000))

        box: dict[str, Any] = {}

        def run() -> None:
            try:
                box["value"] = self._reader.lookup_human(address)
            except BaseException as exc:  # reader contract: raise on failure
                box["error"] = exc

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        deadline = start + self._timeout_ms / 1000.0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return _LookupOutcome("unknown", latency_ms(), code="lookup_timeout")
            if signal is not None and signal.is_set():
                return _LookupOutcome("unknown", latency_ms(), code="lookup_failed")
            worker.join(min(remaining, 0.005))
            if not worker.is_alive():
                break
        if "error" in box:
            return _LookupOutcome("unknown", latency_ms(), code="lookup_failed")
        value = box.get("value")
        if value is None:
            return _LookupOutcome("unregistered", latency_ms())
        return _LookupOutcome("registered", latency_ms(), human_id=value)

    def _erc1271_valid(self, wallet: str, message: str, signature: str) -> bool:
        # An ERC-1271 magic value on another chain is not a signature
        # on World Chain. Chain identity failures raise, so they reach
        # the caller as an unknown check, not a false signature verdict.
        if self._rpc.chain_id() != WORLD_CHAIN_ID:
            raise RpcError("ERC-1271 RPC is not World Chain.")
        try:
            sig_bytes = _signature_bytes(signature)
        except ValueError:
            return False
        calldata = _is_valid_signature_calldata(eip191_digest(message), sig_bytes)
        try:
            result = self._rpc.eth_call(wallet, calldata)
        except Exception:
            # A wallet that is not a contract, or a failed read, is not
            # a valid ERC-1271 signature. Fail closed on the claim
            # (SPEC 3.0).
            return False
        return isinstance(result, str) and result.lower()[:10] == ERC1271_MAGIC

    def _signature_valid(self, attestation: SignedAttestation, message: str) -> bool:
        wallet = attestation.payload.agent_wallet_address
        try:
            recovered = _recover_message_address(message, attestation.signature)
            if recovered == wallet:
                return True
        except Exception:
            # Not an EOA-recoverable signature; fall through to ERC-1271.
            pass
        return self._erc1271_valid(wallet, message, attestation.signature)

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

        # Step 2, binding (SPEC 3.3).
        if opts.expected_subject is not None and (
            opts.expected_subject.type != payload.subject.type
            or opts.expected_subject.id != payload.subject.id
        ):
            failures.append("subject_mismatch")
        if opts.expected_wallet is not None:
            try:
                expected = checksum_address(opts.expected_wallet)
            except (ValueError, TypeError):
                expected = (
                    opts.expected_wallet.lower()
                    if isinstance(opts.expected_wallet, str)
                    else opts.expected_wallet
                )
            if expected != wallet:
                failures.append("wallet_mismatch")

        # Step 3, signature over the canonical form.
        message = canonical_attestation_message(payload)
        try:
            signature_matches = self._signature_valid(signed, message)
        except Exception:
            return self._build_result(
                "unknown", wallet, ["lookup_failed"], disclosure=disclosure
            )
        if not signature_matches:
            failures.append("signature_mismatch")

        # Step 4, dates and the protocol lifetime cap. The skew applies
        # to issuedAt only, never to expiry (SPEC 3.3, as built in TS).
        now_ms = int(_as_utc(self._now()).timestamp() * 1000)
        issued_ms = parse_iso8601_z_ms(payload.issued_at)
        expires_ms = parse_iso8601_z_ms(payload.expires_at)
        if expires_ms <= issued_ms or expires_ms - issued_ms > MAX_LIFETIME_MS:
            failures.append("malformed_attestation")
        if issued_ms > now_ms + self._clock_skew_ms:
            failures.append("not_yet_valid")
        expired = expires_ms <= now_ms
        if expired:
            failures.append("expired")

        invalid_failures = [f for f in failures if f != "expired"]
        if invalid_failures:
            return self._build_result("invalid", wallet, failures, disclosure=disclosure)
        if expired:
            # Expired outranks the lookup outcome (SPEC 3.3 precedence),
            # so the network check is not run.
            return self._build_result("expired", wallet, failures, disclosure=disclosure)

        # Step 5, replay. A supplied nonce store is caller
        # infrastructure; its own errors propagate as programmer/infra
        # errors, not verdicts (as in the TS core).
        if opts.nonce_store is not None and opts.nonce_store.has(payload.nonce, wallet):
            return self._build_result(
                "invalid", wallet, ["replay_detected"], disclosure=disclosure
            )

        # Step 6, registration.
        if not opts.check_registration:
            if opts.nonce_store is not None:
                opts.nonce_store.add(payload.nonce, wallet, payload.expires_at)
            return self._build_result("verified", wallet, [], disclosure=disclosure)
        outcome = self._lookup(wallet, opts.signal)
        if outcome.state == "unknown":
            return self._build_result(
                "unknown",
                wallet,
                [outcome.code or "lookup_failed"],
                latency_ms=outcome.latency_ms,
                disclosure=disclosure,
            )
        if outcome.state == "unregistered":
            # A valid signature from an unregistered wallet attests nothing.
            return self._build_result(
                "unregistered",
                wallet,
                ["not_registered"],
                latency_ms=outcome.latency_ms,
                disclosure=disclosure,
            )
        if opts.nonce_store is not None:
            opts.nonce_store.add(payload.nonce, wallet, payload.expires_at)
        return self._build_result(
            "verified",
            wallet,
            [],
            human_id=outcome.human_id,
            latency_ms=outcome.latency_ms,
            disclosure=disclosure,
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
            resolver = (
                subject.resolve_attestation
                if hasattr(subject, "resolve_attestation")
                else subject["resolveAttestation"]
            )
            try:
                attestation = resolver(subj)
            except Exception:
                return self._build_result("unknown", ZERO_ADDRESS, ["lookup_failed"])
            if attestation is None:
                return self._build_result(
                    "unknown", ZERO_ADDRESS, ["attestation_not_found"]
                )
            return self.verify_attestation(
                attestation,
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
            try:
                valid = self._erc1271_valid(contract, message, signature)
            except Exception:
                # The check itself could not run (RPC / chain identity):
                # an unchecked claim is not reported either way.
                return SignedMessageResult(False, contract, ["lookup_failed"])
            return SignedMessageResult(
                valid, contract, [] if valid else ["signature_mismatch"]
            )
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
