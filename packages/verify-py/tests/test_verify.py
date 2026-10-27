"""Library tests mirroring SPEC 7.2's named cases, as implemented by
the TypeScript suite. Python-side signing uses the same
deterministic synthetic-wallet pattern as the TS fixture generator
(labelled seed strings hashed at generation time; the keys control
nothing and hold nothing).
"""

from __future__ import annotations

import copy
import hashlib
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from typing import Any

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak

from fiador_verify import (
    canonical_attestation_message,
    create_verifier,
    hash_human_id,
    to_public_verify_result,
)
from fiador_verify.addresses import checksum_address
from fiador_verify.reader import LiveReader, StaticReader
from fiador_verify.types import (
    AddressSubject,
    AttestedSubject,
    AttestationPayloadV1,
    AttestationSubjectInput,
    SignedAttestation,
    Subject,
)

from conftest import (
    MAGIC_RESULT,
    POSITIVE_LOOKUP_RESULT,
    StubRpc,
    attestation_from_dict,
    fmt_z,
    load_vectors,
    make_verifier,
    parse_z,
)

V = load_vectors()
A = V["wallets"]["operatorA"]
B = V["wallets"]["operatorB"]
C = V["wallets"]["strangerC"]
HUMAN_1 = V["humans"]["human1"]
CONTRACT_WALLET = "0x00000000000000000000000000000000C0FFEE01"


def synthetic_account(index: int):
    """The TS fixture generator's wallet derivation, byte-for-byte."""
    key = keccak(text=f"fiador-verify-ts-synthetic-key-{index}")
    return Account.from_key(key)


def base_payload(fixed_now, **overrides: Any) -> AttestationPayloadV1:
    day = timedelta(days=1)
    payload = AttestationPayloadV1(
        version=1,
        subject=Subject(type="discord_application", id="111111111111111111"),
        agent_wallet_address=A,
        attestation_url="https://example.invalid/attestations/operator-a.json",
        operator_display_name="Synthetic Operator A",
        human_id_disclosure="hash",
        issued_at=fmt_z(fixed_now - day),
        expires_at=fmt_z(fixed_now + 30 * day),
        nonce="cd" * 32,
        extra={"discord_bot_user_id": "222222222222222222"},
    )
    for key, value in overrides.items():
        setattr(payload, key, value)
    return payload


def sign_payload(account, payload: AttestationPayloadV1) -> SignedAttestation:
    signed = account.sign_message(
        encode_defunct(text=canonical_attestation_message(payload))
    )
    return SignedAttestation(
        payload=payload,
        signature="0x" + bytes(signed.signature).hex(),
        signature_type="eip191",
    )


def sign_text(account, message: str) -> str:
    signed = account.sign_message(encode_defunct(text=message))
    return "0x" + bytes(signed.signature).hex()


class ThrowingReader:
    source = "live"

    def lookup_human(self, address):
        raise RuntimeError("RPC endpoint unreachable")


# -- hashing -----------------------------------------------------------


def test_hash_matches_plain_sha256_reference():
    for value in ["", "0x1234", "human-one", "世界 🌍"]:
        expected = hashlib.sha256(f"w0-human-v1:{value}".encode("utf-8")).hexdigest()
        assert hash_human_id(value) == expected


def test_synthetic_seed_derivation_matches_ts_generator(vectors):
    assert synthetic_account(0).address == vectors["wallets"]["operatorA"]
    assert synthetic_account(1).address == vectors["wallets"]["operatorB"]
    assert synthetic_account(3).address == vectors["wallets"]["strangerC"]


# -- verify_address ------------------------------------------------------


def test_registered_address_evidence_and_truncation(vectors, fixed_now):
    result = make_verifier(vectors, fixed_now).verify_address(A)
    assert result.status == "verified"
    assert result.evidence.source == "live"
    assert result.evidence.agent_book.contract == (
        "0xA23aB2712eA7BBa896930544C7d6636a96b944dA"
    )
    assert result.evidence.checked_at == vectors["fixedNow"]
    assert result.address_truncated == f"{A[:6]}…{A[-5:]}"


def test_malformed_addresses_never_throw(vectors, fixed_now):
    verifier = make_verifier(vectors, fixed_now)
    for bad in ["0x123", "not-an-address", "", "0xZZZZ567890abcdef1234567890abcdef12345678"]:
        result = verifier.verify_address(bad)
        assert result.status == "invalid"
        assert result.failures == ["malformed_address"]


def test_lowercase_input_output_checksummed(vectors, fixed_now):
    result = make_verifier(vectors, fixed_now).verify_address(A.lower())
    assert result.status == "verified"
    assert result.address == A


# -- lookup failure separation (the SDK regression test) -----------------


def test_reader_throw_is_unknown_never_unregistered(vectors, fixed_now):
    result = make_verifier(vectors, fixed_now, reader=ThrowingReader()).verify_address(A)
    assert result.status == "unknown"
    assert result.status != "unregistered"
    assert result.failures == ["lookup_failed"]


def test_hanging_reader_times_out(vectors, fixed_now):
    release = threading.Event()

    class HangingReader:
        source = "live"

        def lookup_human(self, address):
            release.wait(30)
            return None

    verifier = make_verifier(vectors, fixed_now, reader=HangingReader(), timeout_ms=40)
    try:
        result = verifier.verify_address(A)
    finally:
        release.set()
    assert result.status == "unknown"
    assert result.failures == ["lookup_timeout"]


def test_hung_collaborators_have_process_wide_capacity_bound(vectors, fixed_now):
    release = threading.Event()
    starts = 0
    guard = threading.Lock()

    class HangingReader:
        source = "live"

        def lookup_human(self, address):
            nonlocal starts
            with guard:
                starts += 1
            release.wait(30)
            return None

    verifier = make_verifier(vectors, fixed_now, reader=HangingReader(), timeout_ms=2)
    started_at = time.monotonic()
    try:
        results = [verifier.verify_address(A) for _ in range(25)]
        assert time.monotonic() - started_at < 1
        assert all(result.status == "unknown" for result in results)
        assert all(result.failures in (["lookup_timeout"], ["lookup_failed"]) for result in results)
        assert any(result.failures == ["lookup_failed"] for result in results)
        assert starts <= 8
    finally:
        release.set()

    # Slots are released by the underlying work, not by the callers'
    # timeouts. Once those calls finish, a new lookup can proceed.
    healthy = make_verifier(vectors, fixed_now, timeout_ms=100)
    until = time.monotonic() + 2
    while time.monotonic() < until:
        if healthy.verify_address(A).status == "verified":
            break
        time.sleep(0.01)
    else:
        pytest.fail("deadline capacity did not recover after readers completed")


def test_caller_abort_is_lookup_failed(vectors, fixed_now):
    class SlowReader:
        source = "live"

        def lookup_human(self, address):
            threading.Event().wait(0.25)
            return HUMAN_1

    signal = threading.Event()
    threading.Timer(0.02, signal.set).start()
    verifier = make_verifier(vectors, fixed_now, reader=SlowReader(), timeout_ms=5000)
    result = verifier.verify_address(A, signal=signal)
    assert result.status == "unknown"
    assert result.failures == ["lookup_failed"]


# -- verify_attestation ---------------------------------------------------


def test_check_registration_false_uses_no_lookup(vectors, fixed_now):
    verifier = make_verifier(vectors, fixed_now, reader=ThrowingReader())
    result = verifier.verify_attestation(
        attestation_from_dict(vectors["attestations"]["valid"]),
        check_registration=False,
    )
    assert result.status == "verified"
    assert result.human_hash is None


def test_unregistered_wallet_not_rescued_by_valid_signature(vectors, fixed_now):
    null_reader = StaticReader({A: None}, source="live")
    verifier = make_verifier(vectors, fixed_now, reader=null_reader)
    result = verifier.verify_attestation(
        attestation_from_dict(vectors["attestations"]["valid"])
    )
    assert result.status == "unregistered"
    assert result.failures == ["not_registered"]


def test_expired_outranks_failing_lookup(vectors, fixed_now):
    verifier = make_verifier(vectors, fixed_now, reader=ThrowingReader())
    result = verifier.verify_attestation(
        attestation_from_dict(vectors["attestations"]["expired"])
    )
    assert result.status == "expired"
    assert "expired" in result.failures


def test_tampering_with_any_signed_field_is_signature_mismatch(vectors, fixed_now):
    def mutate_subject(att):
        att["payload"]["subject"]["id"] = "999999999999999999"

    def mutate_wallet(att):
        att["payload"]["agentWalletAddress"] = B

    def mutate_expiry(att):
        att["payload"]["expiresAt"] = fmt_z(
            parse_z(att["payload"]["expiresAt"]) + timedelta(days=1)
        )

    def mutate_nonce(att):
        att["payload"]["nonce"] = "ff" * 32

    def mutate_extra(att):
        att["payload"]["extra"] = {"discord_bot_user_id": "333333333333333333"}

    def mutate_disclosure(att):
        att["payload"]["humanIdDisclosure"] = "none"

    mutations = [
        ("subject id", mutate_subject),
        ("wallet", mutate_wallet),
        ("expiresAt", mutate_expiry),
        ("nonce", mutate_nonce),
        ("extra field", mutate_extra),
        ("disclosure", mutate_disclosure),
    ]
    with StubRpc(chain_id="0x1e0", eth_call_error=True) as rpc:
        verifier = make_verifier(vectors, fixed_now, rpc_url=rpc.url)
        for name, mutate in mutations:
            att = copy.deepcopy(vectors["attestations"]["valid"])
            mutate(att)
            result = verifier.verify_attestation(att, check_registration=False)
            assert result.status == "invalid", name
            assert "signature_mismatch" in result.failures, name


def test_wrong_expected_subject_and_wallet(vectors, fixed_now):
    verifier = make_verifier(vectors, fixed_now)
    att = attestation_from_dict(vectors["attestations"]["valid"])
    result = verifier.verify_attestation(
        att,
        expected_subject=Subject(type="discord_application", id="444444444444444444"),
    )
    assert result.status == "invalid"
    assert "subject_mismatch" in result.failures
    result = verifier.verify_attestation(att, expected_wallet=B)
    assert result.status == "invalid"
    assert "wallet_mismatch" in result.failures


class MemoryNonceStore:
    """Strongly consistent active-claim read plus atomic final claim."""

    def __init__(self, now):
        self._records: dict[str, str] = {}
        self._now = now
        self._lock = threading.Lock()
        self.claims = 0

    def has(self, nonce, wallet):
        with self._lock:
            exp = self._records.get(f"{wallet}:{nonce}")
            return exp is not None and parse_z(exp) > self._now

    def claim(self, nonce, wallet, expires_at):
        with self._lock:
            self.claims += 1
            key = f"{wallet}:{nonce}"
            exp = self._records.get(key)
            if exp is not None and parse_z(exp) > self._now:
                return "replay"
            if parse_z(expires_at) <= self._now:
                return "expired"
            self._records[key] = expires_at
            return "claimed"


def test_replay_detected_second_presentation_only(vectors, fixed_now):
    store = MemoryNonceStore(fixed_now)
    verifier = make_verifier(vectors, fixed_now)
    att = attestation_from_dict(vectors["attestations"]["valid"])
    first = verifier.verify_attestation(att, nonce_store=store)
    assert first.status == "verified"
    second = verifier.verify_attestation(att, nonce_store=store)
    assert second.status == "invalid"
    assert "replay_detected" in second.failures
    # Same nonce under a different wallet is not a replay: a distinct
    # attestation from wallet B reusing the nonce verifies clean.
    account_b = synthetic_account(1)
    payload_b = base_payload(fixed_now, agent_wallet_address=B, nonce=att.payload.nonce)
    other = verifier.verify_attestation(
        sign_payload(account_b, payload_b), nonce_store=store
    )
    assert other.status == "verified"
    assert "replay_detected" not in other.failures


def test_malformed_attestations_return_results(vectors, fixed_now):
    verifier = make_verifier(vectors, fixed_now)
    valid = copy.deepcopy(vectors["attestations"]["valid"])
    cases: list[tuple[Any, str]] = [
        (None, "malformed_attestation"),
        ("a string", "malformed_attestation"),
        ({}, "malformed_attestation"),
        ({**valid, "payload": {**valid["payload"], "version": 2}}, "unsupported_version"),
        ({**valid, "payload": {**valid["payload"], "nonce": "short"}}, "malformed_attestation"),
    ]
    for att_input, code in cases:
        result = verifier.verify_attestation(att_input)
        assert result.status == "invalid", (att_input, code)
        assert code in result.failures


def test_present_null_optional_fields_are_malformed(vectors, fixed_now):
    verifier = make_verifier(vectors, fixed_now)
    for field in ("attestationUrl", "operatorDisplayName", "extra"):
        att = copy.deepcopy(vectors["attestations"]["valid"])
        att["payload"][field] = None
        result = verifier.verify_attestation(att)
        assert result.status == "invalid", field
        assert result.failures == ["malformed_attestation"], field


def test_extra_with_non_string_key_is_malformed_not_an_exception(vectors, fixed_now):
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["payload"]["extra"][1] = "one"
    result = make_verifier(vectors, fixed_now).verify_attestation(att)
    assert result.status == "invalid"
    assert result.failures == ["malformed_attestation"]


def test_attestation_racing_expiry_is_expired(vectors, fixed_now):
    later = parse_z(vectors["attestations"]["valid"]["payload"]["expiresAt"]) + timedelta(
        seconds=1
    )
    verifier = make_verifier(vectors, fixed_now, now=lambda: later)
    result = verifier.verify_attestation(
        attestation_from_dict(vectors["attestations"]["valid"])
    )
    assert result.status == "expired"


# -- skew discipline, proven with Python-signed payloads -------------------


def test_skew_applies_to_issued_at_within_window(vectors, fixed_now):
    account = synthetic_account(0)
    payload = base_payload(
        fixed_now,
        issued_at=fmt_z(fixed_now + timedelta(seconds=30)),
        expires_at=fmt_z(fixed_now + timedelta(days=30, seconds=30)),
    )
    result = make_verifier(vectors, fixed_now).verify_attestation(
        sign_payload(account, payload)
    )
    assert result.status == "verified"


def test_issued_at_beyond_skew_is_not_yet_valid(vectors, fixed_now):
    account = synthetic_account(0)
    payload = base_payload(
        fixed_now,
        issued_at=fmt_z(fixed_now + timedelta(seconds=120)),
        expires_at=fmt_z(fixed_now + timedelta(days=30, seconds=120)),
    )
    result = make_verifier(vectors, fixed_now).verify_attestation(
        sign_payload(account, payload)
    )
    assert result.status == "invalid"
    assert result.failures == ["not_yet_valid"]


def test_expiry_gets_no_skew_grace(vectors, fixed_now):
    account = synthetic_account(0)
    payload = base_payload(
        fixed_now,
        issued_at=fmt_z(fixed_now - timedelta(days=30)),
        expires_at=fmt_z(fixed_now),  # expires exactly at the check instant
    )
    result = make_verifier(vectors, fixed_now).verify_attestation(
        sign_payload(account, payload)
    )
    assert result.status == "expired"
    assert result.failures == ["expired"]


# -- ERC-1271 and chain identity -------------------------------------------


def test_erc1271_attestation_verifies_through_contract_path(vectors, fixed_now):
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["payload"]["agentWalletAddress"] = CONTRACT_WALLET
    att["signatureType"] = "eip1271"
    att["signature"] = "0x" + "11" * 65
    reader = StaticReader({CONTRACT_WALLET: HUMAN_1}, source="live")
    with StubRpc(chain_id="0x1e0", eth_call_result=MAGIC_RESULT) as rpc:
        verifier = make_verifier(vectors, fixed_now, reader=reader, rpc_url=rpc.url)
        result = verifier.verify_attestation(att)
    assert result.status == "verified"
    assert result.human_hash == hash_human_id(HUMAN_1)


def test_positive_lookup_accepted_only_after_chain_confirms_480(vectors):
    with StubRpc(chain_id="0x1e0", eth_call_result=POSITIVE_LOOKUP_RESULT) as rpc:
        result = create_verifier(rpc_url=rpc.url).verify_address(A)
    assert result.status == "verified"
    assert result.human_hash == hash_human_id("0x1")
    assert rpc.eth_calls == 1


def test_lookup_from_wrong_chain_is_unknown_before_any_call(vectors):
    with StubRpc(chain_id="0x1", eth_call_result=POSITIVE_LOOKUP_RESULT) as rpc:
        result = create_verifier(rpc_url=rpc.url).verify_address(A)
    assert result.status == "unknown"
    assert result.failures == ["lookup_failed"]
    assert result.human_hash is None
    assert rpc.eth_calls == 0


def test_erc1271_on_wrong_chain_is_unknown_before_any_call(vectors, fixed_now):
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["payload"]["agentWalletAddress"] = CONTRACT_WALLET
    att["signatureType"] = "eip1271"
    att["signature"] = "0x" + "11" * 65
    reader = StaticReader({CONTRACT_WALLET: HUMAN_1}, source="live")
    with StubRpc(chain_id="0x1", eth_call_result=MAGIC_RESULT) as rpc:
        verifier = make_verifier(vectors, fixed_now, reader=reader, rpc_url=rpc.url)
        result = verifier.verify_attestation(att)
    assert result.status == "unknown"
    assert result.failures == ["lookup_failed"]
    assert rpc.eth_calls == 0


def test_erc1271_http_503_is_unknown_not_bad_signature(vectors, fixed_now):
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["payload"]["agentWalletAddress"] = CONTRACT_WALLET
    att["signatureType"] = "eip1271"
    att["signature"] = "0x" + "11" * 32
    reader = StaticReader({CONTRACT_WALLET: HUMAN_1}, source="live")
    with StubRpc(eth_call_status=503) as rpc:
        verifier = make_verifier(vectors, fixed_now, reader=reader, rpc_url=rpc.url)
        result = verifier.verify_attestation(att)
        signed = verifier.verify_signed_message(
            "statement", att["signature"], "erc1271", expected_address=CONTRACT_WALLET
        )
    assert result.status == "unknown"
    assert result.failures == ["lookup_failed"]
    assert signed.verified is False
    assert signed.failures == ["lookup_failed"]
    assert rpc.eth_calls == 2


def test_erc1271_contract_revert_and_nonmagic_are_mismatches(vectors, fixed_now):
    for rpc_options in ({"eth_call_error": True}, {"eth_call_result": "0x" + "00" * 32}):
        with StubRpc(**rpc_options) as rpc:
            result = make_verifier(vectors, fixed_now, rpc_url=rpc.url).verify_signed_message(
                "statement", "0x" + "11" * 32, "erc1271",
                expected_address=CONTRACT_WALLET,
            )
        assert result.verified is False
        assert result.failures == ["signature_mismatch"]


def test_erc1271_http_503_preserves_expiry_precedence(vectors, fixed_now):
    att = copy.deepcopy(vectors["attestations"]["expired"])
    att["payload"]["agentWalletAddress"] = CONTRACT_WALLET
    att["signatureType"] = "eip1271"
    att["signature"] = "0x" + "11" * 32
    with StubRpc(eth_call_status=503) as rpc:
        result = make_verifier(vectors, fixed_now, rpc_url=rpc.url).verify_attestation(att)
    assert result.status == "expired"
    assert result.failures == ["expired", "lookup_failed"]


# -- raw humanId discipline (security property) ------------------------------


def test_default_result_carries_no_raw_id(vectors, fixed_now):
    result = make_verifier(vectors, fixed_now).verify_address(A)
    serialised = json.dumps(result.to_dict())
    assert HUMAN_1 not in serialised
    assert "human_id" not in result.to_dict()
    assert result.human_id is None


def test_include_raw_human_id_carries_value_and_still_hashes(vectors, fixed_now):
    result = make_verifier(vectors, fixed_now, include_raw_human_id=True).verify_address(A)
    assert result.human_id == HUMAN_1
    assert result.human_hash == hash_human_id(HUMAN_1)


def test_projection_is_a_fresh_object_deep_scanned(vectors, fixed_now):
    internal = make_verifier(vectors, fixed_now, include_raw_human_id=True).verify_address(A)
    public = to_public_verify_result(internal)
    serialised = json.dumps(public.to_dict())
    assert HUMAN_1 not in serialised
    assert "human_id" not in serialised
    assert A not in serialised
    assert set(public.to_dict().keys()) == {
        "status",
        "address_truncated",
        "human_hash",
        "failures",
        "evidence",
    }
    # A field added to the internal object afterwards cannot leak
    # through a fresh projection: only the public keys are ever built.
    internal.future_internal_field = "leak-me"  # type: ignore[attr-defined]
    serialised2 = json.dumps(to_public_verify_result(internal).to_dict())
    assert "leak-me" not in serialised2
    assert "future_internal_field" not in serialised2


# -- resolve_status ------------------------------------------------------------


def test_resolve_status_address_and_attestation(vectors, fixed_now):
    verifier = make_verifier(vectors, fixed_now)
    assert verifier.resolve_status(AddressSubject(address=A)).status == "verified"
    att = attestation_from_dict(vectors["attestations"]["valid"])
    assert verifier.resolve_status(AttestationSubjectInput(attestation=att)).status == (
        "verified"
    )
    resolved = verifier.resolve_status(
        AttestedSubject(subject=att.payload.subject, resolve_attestation=lambda s: att)
    )
    assert resolved.status == "verified"


def test_resolve_status_resolver_null_and_throw(vectors, fixed_now):
    verifier = make_verifier(vectors, fixed_now)
    subject = Subject(type="discord_application", id="555555555555555555")
    result = verifier.resolve_status(
        AttestedSubject(subject=subject, resolve_attestation=lambda s: None)
    )
    assert result.status == "unknown"
    assert result.failures == ["attestation_not_found"]

    def boom(s):
        raise RuntimeError("registry unreachable")

    result = verifier.resolve_status(
        AttestedSubject(subject=subject, resolve_attestation=boom)
    )
    assert result.status == "unknown"
    assert result.failures == ["lookup_failed"]


# -- canonical form ------------------------------------------------------------


def test_canonical_form_key_order_and_sorted_extra(vectors, fixed_now):
    payload = base_payload(fixed_now, extra={"zebra": "2", "alpha": "1"})
    message = canonical_attestation_message(payload)
    assert message.startswith('{"version":1,"subject":{"type":"discord_application"')
    assert '"extra":{"alpha":"1","zebra":"2"}' in message
    assert '": "' not in message
    assert ', "' not in message


# -- verify_signed_message (SPEC 3.6, D5) ---------------------------------------


def test_verify_signed_message_eoa_roundtrip(vectors, fixed_now):
    account = synthetic_account(0)
    verifier = make_verifier(vectors, fixed_now)
    message = "a caller-canonicalised statement"
    signature = sign_text(account, message)

    result = verifier.verify_signed_message(message, signature, "eoa", expected_address=A)
    assert result.verified is True
    assert result.address == A
    assert result.failures == []

    result = verifier.verify_signed_message(message, signature, "eoa")
    assert result.verified is True
    assert result.address == A

    result = verifier.verify_signed_message(message, signature, "eoa", expected_address=B)
    assert result.verified is False
    assert result.address == A
    assert result.failures == ["subject_mismatch"]

    result = verifier.verify_signed_message(message, "0x1234", "eoa", expected_address=A)
    assert result.verified is False
    assert result.address is None
    assert result.failures == ["signature_mismatch"]

    result = verifier.verify_signed_message(
        message, signature, "eoa", expected_address="0x123"
    )
    assert result.verified is False
    assert result.failures == ["malformed_address"]


def test_verify_signed_message_contract_through_eoa_path_fails(vectors, fixed_now):
    account = synthetic_account(0)
    verifier = make_verifier(vectors, fixed_now)
    signature = sign_text(account, "statement")
    result = verifier.verify_signed_message(
        "statement", signature, "eoa", expected_address=CONTRACT_WALLET
    )
    # No silent switch to the ERC-1271 path: the recovered EOA signer
    # simply is not the expected contract address.
    assert result.verified is False
    assert result.failures == ["subject_mismatch"]


def test_verify_signed_message_erc1271_path(vectors, fixed_now):
    signature = "0x" + "11" * 65
    with StubRpc(chain_id="0x1e0", eth_call_result=MAGIC_RESULT) as rpc:
        verifier = make_verifier(vectors, fixed_now, rpc_url=rpc.url)
        result = verifier.verify_signed_message(
            "statement", signature, "erc1271", expected_address=CONTRACT_WALLET
        )
    assert result.verified is True
    assert result.address == checksum_address(CONTRACT_WALLET)
    assert result.failures == []


def test_verify_signed_message_erc1271_rejection_and_wrong_path(vectors, fixed_now):
    signature = "0x" + "11" * 65
    with StubRpc(chain_id="0x1e0", eth_call_result="0x" + "00" * 32) as rpc:
        verifier = make_verifier(vectors, fixed_now, rpc_url=rpc.url)
        result = verifier.verify_signed_message(
            "statement", signature, "erc1271", expected_address=CONTRACT_WALLET
        )
        assert result.verified is False
        assert result.failures == ["signature_mismatch"]
        # An EOA address checked through the contract path fails too:
        # eth_call returns no magic value for a non-contract.
        result = verifier.verify_signed_message(
            "statement", signature, "erc1271", expected_address=A
        )
        assert result.verified is False
        assert result.failures == ["signature_mismatch"]


def test_verify_signed_message_erc1271_needs_an_address(vectors, fixed_now):
    verifier = make_verifier(vectors, fixed_now)
    result = verifier.verify_signed_message("statement", "0x" + "11" * 65, "erc1271")
    assert result.verified is False
    assert result.failures == ["signature_mismatch"]


def test_verify_signed_message_wrong_chain_is_lookup_failed(vectors, fixed_now):
    with StubRpc(chain_id="0x1", eth_call_result=MAGIC_RESULT) as rpc:
        verifier = make_verifier(vectors, fixed_now, rpc_url=rpc.url)
        result = verifier.verify_signed_message(
            "statement", "0x" + "11" * 65, "erc1271", expected_address=CONTRACT_WALLET
        )
    assert result.verified is False
    assert result.failures == ["lookup_failed"]


# -- construction ---------------------------------------------------------------


def test_create_verifier_rejects_malformed_contract():
    with pytest.raises(TypeError) as excinfo:
        create_verifier(contract_address="0x123")
    # The error names no configuration value (7.5 review M14).
    assert "0x123" not in str(excinfo.value)


# -- 7.5 regressions: envelope closure and shape (B3/M9/m4) ---------------------


def test_extra_envelope_key_is_malformed(vectors, fixed_now):
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["humanId"] = HUMAN_1  # a smuggled key riding alongside the payload
    result = make_verifier(vectors, fixed_now).verify_attestation(att)
    assert result.status == "invalid"
    assert result.failures == ["malformed_attestation"]


def test_extra_subject_key_is_malformed(vectors, fixed_now):
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["payload"]["subject"]["humanId"] = HUMAN_1
    result = make_verifier(vectors, fixed_now).verify_attestation(att)
    assert result.status == "invalid"
    assert result.failures == ["malformed_attestation"]


def test_impossible_calendar_date_is_malformed(vectors, fixed_now):
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["payload"]["issuedAt"] = "2026-02-30T12:00:00.000Z"
    att["payload"]["expiresAt"] = "2026-03-30T12:00:00.000Z"
    result = make_verifier(vectors, fixed_now).verify_attestation(att)
    assert result.status == "invalid"
    assert result.failures == ["malformed_attestation"]


def test_oversized_nonce_and_subject_fields_are_malformed(vectors, fixed_now):
    verifier = make_verifier(vectors, fixed_now)
    cases = []
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["payload"]["nonce"] = "ab" * 65  # 130 chars > 128 cap
    cases.append(att)
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["payload"]["subject"]["type"] = "t" * 65
    cases.append(att)
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["payload"]["subject"]["id"] = "i" * 257
    cases.append(att)
    for case in cases:
        result = verifier.verify_attestation(case)
        assert result.status == "invalid"
        assert result.failures == ["malformed_attestation"]


# -- 7.5 regressions: signatureType is honoured (B1) ---------------------------


def test_eip191_document_never_falls_through_to_erc1271(vectors, fixed_now):
    # The stub RPC would answer the ERC-1271 magic value to anything;
    # an eip191 document must make no RPC call at all.
    with StubRpc(chain_id="0x1e0", eth_call_result=MAGIC_RESULT) as rpc:
        verifier = make_verifier(vectors, fixed_now, rpc_url=rpc.url)
        result = verifier.verify_attestation(
            attestation_from_dict(vectors["attestations"]["wrongSigner"])
        )
    assert result.status == "invalid"
    assert "signature_mismatch" in result.failures
    assert rpc.chain_id_calls == 0
    assert rpc.eth_calls == 0


def test_eip191_claim_by_contract_wallet_is_a_mismatch(vectors, fixed_now):
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["payload"]["agentWalletAddress"] = CONTRACT_WALLET
    att["signatureType"] = "eip191"
    att["signature"] = "0x" + "11" * 65
    reader = StaticReader({CONTRACT_WALLET: HUMAN_1}, source="live")
    with StubRpc(chain_id="0x1e0", eth_call_result=MAGIC_RESULT) as rpc:
        verifier = make_verifier(vectors, fixed_now, reader=reader, rpc_url=rpc.url)
        result = verifier.verify_attestation(att)
    assert result.status == "invalid"
    assert "signature_mismatch" in result.failures
    assert rpc.eth_calls == 0


def test_erc1271_signature_need_not_be_65_bytes(vectors, fixed_now):
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["payload"]["agentWalletAddress"] = CONTRACT_WALLET
    att["signatureType"] = "eip1271"
    att["signature"] = "0x" + "11" * 32  # 32-byte validator blob
    reader = StaticReader({CONTRACT_WALLET: HUMAN_1}, source="live")
    with StubRpc(chain_id="0x1e0", eth_call_result=MAGIC_RESULT) as rpc:
        verifier = make_verifier(vectors, fixed_now, reader=reader, rpc_url=rpc.url)
        result = verifier.verify_attestation(att)
    assert result.status == "verified"


def test_hanging_erc1271_eth_call_obeys_timeout(vectors, fixed_now):
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["payload"]["agentWalletAddress"] = CONTRACT_WALLET
    att["signatureType"] = "eip1271"
    att["signature"] = "0x" + "11" * 65
    reader = StaticReader({CONTRACT_WALLET: HUMAN_1}, source="live")
    with StubRpc(chain_id="0x1e0", hang_eth_call=True) as rpc:
        verifier = make_verifier(
            vectors, fixed_now, reader=reader, rpc_url=rpc.url, timeout_ms=100
        )
        started = time.monotonic()
        result = verifier.verify_attestation(att)
        elapsed = time.monotonic() - started
    assert elapsed < 2
    assert result.status == "unknown"
    assert result.failures == ["lookup_timeout"]


def test_signature_step_network_failure_preserves_binding_failures(vectors, fixed_now):
    att = copy.deepcopy(vectors["attestations"]["valid"])
    att["payload"]["agentWalletAddress"] = CONTRACT_WALLET
    att["signatureType"] = "eip1271"
    att["signature"] = "0x" + "11" * 65
    reader = StaticReader({CONTRACT_WALLET: HUMAN_1}, source="live")
    # Chain 1: the 1271 check cannot run at all.
    with StubRpc(chain_id="0x1", eth_call_result=MAGIC_RESULT) as rpc:
        verifier = make_verifier(vectors, fixed_now, reader=reader, rpc_url=rpc.url)
        result = verifier.verify_attestation(
            att,
            expected_subject=Subject(
                type="discord_application", id="999999999999999999"
            ),
        )
    assert result.status == "invalid"  # invalid outranks unknown
    assert "subject_mismatch" in result.failures
    assert "lookup_failed" in result.failures


# -- 7.5 regressions: nonce store claim contract (B2/M1/M2) ----------------------


def test_claim_is_called_exactly_once_on_the_success_path(vectors, fixed_now):
    store = MemoryNonceStore(fixed_now)
    result = make_verifier(vectors, fixed_now).verify_attestation(
        attestation_from_dict(vectors["attestations"]["valid"]), nonce_store=store
    )
    assert result.status == "verified"
    assert store.claims == 1


def test_store_claim_replay_on_first_presentation_is_replay(vectors, fixed_now):
    class AlreadyClaimed:
        def has(self, nonce, wallet):
            return False

        def claim(self, nonce, wallet, expires_at):
            return "replay"

    result = make_verifier(vectors, fixed_now).verify_attestation(
        attestation_from_dict(vectors["attestations"]["valid"]),
        nonce_store=AlreadyClaimed(),
    )
    assert result.status == "invalid"
    assert result.failures == ["replay_detected"]


def test_replay_outranks_expiry(vectors, fixed_now):
    class AlreadyClaimed:
        def has(self, nonce, wallet):
            return True

        def claim(self, nonce, wallet, expires_at):
            raise AssertionError("expired document must not be claimed")

    result = make_verifier(vectors, fixed_now).verify_attestation(
        attestation_from_dict(vectors["attestations"]["expired"]),
        nonce_store=AlreadyClaimed(),
    )
    assert result.status == "invalid"
    assert "replay_detected" in result.failures
    assert "expired" in result.failures


def test_throwing_claim_store_fails_closed(vectors, fixed_now):
    class ThrowingStore:
        def has(self, nonce, wallet):
            return False

        def claim(self, nonce, wallet, expires_at):
            raise RuntimeError("store unavailable")

    verifier = make_verifier(vectors, fixed_now)
    result = verifier.verify_attestation(
        attestation_from_dict(vectors["attestations"]["valid"]),
        nonce_store=ThrowingStore(),
    )
    assert result.status == "unknown"
    assert result.failures == ["lookup_failed"]


def test_throwing_replay_read_still_yields_to_established_expiry(vectors, fixed_now):
    class ThrowingStore:
        def has(self, nonce, wallet):
            raise RuntimeError("store unavailable")

        def claim(self, nonce, wallet, expires_at):
            raise AssertionError("expired document must not be claimed")

    result = make_verifier(vectors, fixed_now).verify_attestation(
        attestation_from_dict(vectors["attestations"]["expired"]),
        nonce_store=ThrowingStore(),
    )
    assert result.status == "expired"
    assert "lookup_failed" in result.failures


def test_failing_replay_read_never_claims(vectors, fixed_now):
    class FailingReadStore:
        claims = 0

        def has(self, nonce, wallet):
            raise RuntimeError("store unavailable")

        def claim(self, nonce, wallet, expires_at):
            self.claims += 1
            return "claimed"

    store = FailingReadStore()
    result = make_verifier(vectors, fixed_now).verify_attestation(
        attestation_from_dict(vectors["attestations"]["valid"]), nonce_store=store
    )
    assert result.status == "unknown"
    assert result.failures == ["lookup_failed"]
    assert store.claims == 0


def test_nonce_not_claimed_for_expired_unregistered_or_unknown(vectors, fixed_now):
    store = MemoryNonceStore(fixed_now)
    valid = attestation_from_dict(vectors["attestations"]["valid"])
    expired = attestation_from_dict(vectors["attestations"]["expired"])
    assert make_verifier(vectors, fixed_now).verify_attestation(
        expired, nonce_store=store
    ).status == "expired"
    assert make_verifier(
        vectors, fixed_now, reader=StaticReader({A: None}, source="live")
    ).verify_attestation(valid, nonce_store=store).status == "unregistered"
    assert make_verifier(vectors, fixed_now, reader=ThrowingReader()).verify_attestation(
        valid, nonce_store=store
    ).status == "unknown"
    assert store.claims == 0
    assert store.has(valid.payload.nonce, A) is False


def test_nonce_claim_follows_replay_read_without_registration(vectors, fixed_now):
    calls = []

    class Store:
        def has(self, nonce, wallet):
            calls.append("has")
            return False

        def claim(self, nonce, wallet, expires_at):
            calls.append("claim")
            return "claimed"

    result = make_verifier(vectors, fixed_now, reader=ThrowingReader()).verify_attestation(
        attestation_from_dict(vectors["attestations"]["valid"]),
        nonce_store=Store(), check_registration=False,
    )
    assert result.status == "verified"
    assert calls == ["has", "claim"]


def test_two_concurrent_presentations_only_one_claims(vectors, fixed_now):
    store = MemoryNonceStore(fixed_now)
    barrier = threading.Barrier(2)
    original_has = store.has

    def concurrent_has(nonce, wallet):
        result = original_has(nonce, wallet)
        barrier.wait(timeout=10)
        return result

    store.has = concurrent_has
    verifier = make_verifier(vectors, fixed_now)
    att = attestation_from_dict(vectors["attestations"]["valid"])
    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(verifier.verify_attestation, att, nonce_store=store)
        b = pool.submit(verifier.verify_attestation, att, nonce_store=store)
        results = [a.result(timeout=20), b.result(timeout=20)]
    assert sorted(result.status for result in results) == ["invalid", "verified"]
    assert next(result for result in results if result.status == "invalid").failures == [
        "replay_detected"
    ]


def test_registration_crossing_expiry_does_not_claim(vectors, fixed_now):
    expires_at = parse_z(vectors["attestations"]["valid"]["payload"]["expiresAt"])
    clock = [fixed_now]

    class CrossingReader:
        source = "live"

        def lookup_human(self, address):
            clock[0] = expires_at + timedelta(milliseconds=1)
            return HUMAN_1

    store = MemoryNonceStore(fixed_now)
    verifier = make_verifier(vectors, fixed_now, now=lambda: clock[0], reader=CrossingReader())
    result = verifier.verify_attestation(
        attestation_from_dict(vectors["attestations"]["valid"]), nonce_store=store
    )
    assert result.status == "expired"
    assert result.failures == ["expired"]
    assert store.claims == 0


def test_store_clock_expiry_during_claim_records_nothing(vectors, fixed_now):
    store_clock = parse_z(vectors["attestations"]["valid"]["payload"]["expiresAt"]) + timedelta(
        milliseconds=1
    )

    class ExpiringStore:
        claims = 0

        def has(self, nonce, wallet):
            return False

        def claim(self, nonce, wallet, expires_at):
            if parse_z(expires_at) <= store_clock:
                return "expired"
            self.claims += 1
            return "claimed"

    store = ExpiringStore()
    result = make_verifier(vectors, fixed_now).verify_attestation(
        attestation_from_dict(vectors["attestations"]["valid"]), nonce_store=store
    )
    assert result.status == "expired"
    assert result.failures == ["expired"]
    assert store.claims == 0


def test_claim_crossing_expiry_cannot_return_verified(vectors, fixed_now):
    expires_at = parse_z(vectors["attestations"]["valid"]["payload"]["expiresAt"])
    clock = [fixed_now]

    class CrossingStore:
        def has(self, nonce, wallet):
            return False

        def claim(self, nonce, wallet, expires_at):
            assert parse_z(expires_at) > clock[0]
            clock[0] = parse_z(expires_at) + timedelta(milliseconds=1)
            return "claimed"

    verifier = make_verifier(vectors, fixed_now, now=lambda: clock[0])
    result = verifier.verify_attestation(
        attestation_from_dict(vectors["attestations"]["valid"]), nonce_store=CrossingStore()
    )
    assert result.status == "expired"
    assert result.failures == ["expired"]


# -- 7.5 regressions: guarded collaborators (M3/M12/m1) ---------------------------


def test_hanging_resolver_obeys_the_deadline(vectors, fixed_now):
    release = threading.Event()

    def hanging(subject):
        release.wait(30)
        return None

    verifier = make_verifier(vectors, fixed_now, timeout_ms=40)
    try:
        result = verifier.resolve_status(
            AttestedSubject(
                subject=Subject(type="discord_application", id="555555555555555555"),
                resolve_attestation=hanging,
            )
        )
    finally:
        release.set()
    assert result.status == "unknown"
    assert result.failures == ["lookup_timeout"]


def test_resolver_receives_the_callers_signal(vectors, fixed_now):
    seen: dict[str, Any] = {}
    att = attestation_from_dict(vectors["attestations"]["valid"])

    def resolver(subject, signal):
        seen["signal"] = signal
        return att

    signal = threading.Event()
    result = make_verifier(vectors, fixed_now).resolve_status(
        AttestedSubject(subject=att.payload.subject, resolve_attestation=resolver),
        signal=signal,
    )
    assert result.status == "verified"
    assert seen["signal"] is signal


# -- 7.5 regressions: expectations and endpoints (m2/M13/M17) ---------------------


def test_expected_wallet_case_spelling_is_not_a_mismatch(vectors, fixed_now):
    upper = "0x" + A[2:].upper()
    result = make_verifier(vectors, fixed_now).verify_attestation(
        attestation_from_dict(vectors["attestations"]["valid"]), expected_wallet=upper
    )
    assert result.status == "verified"


def test_non_string_expected_wallet_is_a_mismatch_never_a_throw(vectors, fixed_now):
    result = make_verifier(vectors, fixed_now).verify_attestation(
        attestation_from_dict(vectors["attestations"]["valid"]), expected_wallet=42
    )
    assert result.status == "invalid"
    assert "wallet_mismatch" in result.failures


def test_projection_agent_book_carries_only_its_two_fields(vectors, fixed_now):
    internal = make_verifier(vectors, fixed_now).verify_address(A)
    # Poison the internal evidence the way the TS M13 test does: the
    # projection builds agent_book field by field, so nothing rides.
    internal.evidence.agent_book.human_id = "injected-value"  # type: ignore[attr-defined]
    public = to_public_verify_result(internal)
    assert set(public.evidence.agent_book.to_dict().keys()) == {"network", "contract"}
    assert "injected-value" not in json.dumps(public.to_dict())


def test_non_https_rpc_urls_rejected_at_construction():
    with pytest.raises(TypeError):
        create_verifier(rpc_url="http://rpc.example.invalid")
    with pytest.raises(TypeError):
        LiveReader(rpc_url="http://rpc.example.invalid")
    # https anywhere, and http on loopback, construct fine (no calls made).
    LiveReader(rpc_url="https://rpc.example.invalid")
    LiveReader(rpc_url="http://127.0.0.1:8545")
    LiveReader(rpc_url="http://localhost:8545")
    LiveReader(rpc_url="http://[::1]:8545")
    create_verifier(rpc_url="http://127.0.0.1:8545")
