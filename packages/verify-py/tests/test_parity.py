"""Cross-language parity against the TypeScript package's committed
fixture vectors (packages/verify-ts/fixtures/vectors.json), read from
the sibling path at test time. The vectors carry payloads, signatures,
and lookup rows; identical canonical messages, hashes, and verify
outcomes across both implementations is the port's reason to exist.
"""

from __future__ import annotations

import hashlib
from typing import Any

from eth_account import Account
from eth_account.messages import encode_defunct

from fiador_verify import (
    canonical_attestation_message,
    create_verifier,
    hash_human_id,
    to_public_verify_result,
)
from fiador_verify.reader import StaticReader

from conftest import (
    MAGIC_RESULT,
    attestation_from_dict,
    make_verifier,
    payload_from_dict,
)

# Expected outcomes for every shared attestation vector, mirroring the
# assertions in packages/verify-ts/test/verify.test.ts exactly.
EXPECTED_ATTESTATION_OUTCOMES: dict[str, tuple[str, list[str]]] = {
    "valid": ("verified", []),
    "validDisclosureNone": ("verified", []),
    "expired": ("expired", ["expired"]),
    "notYetValid": ("invalid", ["not_yet_valid"]),
    # The lifetime branch reports its own code since the 7.5 fix
    # pass (M6), in both implementations.
    "longLifetime": ("invalid", ["attestation_lifetime_invalid"]),
    "wrongSigner": ("invalid", ["signature_mismatch"]),
    # The pathological-extra vectors added by the 7.5 fix pass
    # (M7/M8/m3): all are validly signed and must verify.
    "extraProtoKey": ("verified", []),
    "extraIntegerKeys": ("verified", []),
    "extraAstralKeys": ("verified", []),
}


def test_vectors_are_the_shared_synthetic_set(vectors: dict[str, Any]):
    assert "SYNTHETIC" in vectors["note"]
    assert len(vectors["lookups"]) == 4
    assert len(vectors["attestations"]) == 9
    assert len(vectors["signedMessages"]) == 1
    assert len(vectors["humans"]) == 2


def test_hash_parity(vectors: dict[str, Any]):
    # The canonical hash (SPEC 3.5) computed independently via hashlib.
    for human_id in vectors["humans"].values():
        expected = hashlib.sha256(f"w0-human-v1:{human_id}".encode("utf-8")).hexdigest()
        assert hash_human_id(human_id) == expected
    # Two wallets of one human share a hash; a different human differs.
    lookups = {row["address"]: row["humanId"] for row in vectors["lookups"]}
    a = vectors["wallets"]["operatorA"]
    b = vectors["wallets"]["operatorB"]
    d = vectors["wallets"]["operatorD"]
    assert hash_human_id(lookups[a]) == hash_human_id(lookups[b])
    assert hash_human_id(lookups[d]) != hash_human_id(lookups[a])


def test_canonical_message_recovers_every_vector_signature(vectors: dict[str, Any]):
    """Byte-for-byte canonical-form parity: EIP-191 recovery over the
    Python-produced canonical message must land on the signer's wallet
    for every shared vector. Any byte difference breaks recovery."""
    wallets = vectors["wallets"]
    expected_signers = {
        "valid": wallets["operatorA"],
        "validDisclosureNone": wallets["operatorA"],
        "expired": wallets["operatorA"],
        "notYetValid": wallets["operatorA"],
        "longLifetime": wallets["operatorA"],
        # The wrongSigner vector's payload claims operatorA's wallet;
        # its signature is strangerC's.
        "wrongSigner": wallets["strangerC"],
        "extraProtoKey": wallets["operatorA"],
        "extraIntegerKeys": wallets["operatorA"],
        "extraAstralKeys": wallets["operatorA"],
    }
    for name, vector in vectors["attestations"].items():
        message = canonical_attestation_message(payload_from_dict(vector["payload"]))
        recovered = Account.recover_message(
            encode_defunct(text=message), signature=vector["signature"]
        )
        assert recovered == expected_signers[name], name


def test_lookup_outcomes_for_every_shared_row(vectors: dict[str, Any], fixed_now):
    verifier = make_verifier(vectors, fixed_now)
    for row in vectors["lookups"]:
        result = verifier.verify_address(row["address"])
        if row["humanId"] is None:
            assert result.status == "unregistered", row["address"]
            assert result.failures == ["not_registered"]
            assert result.human_hash is None
        else:
            assert result.status == "verified", row["address"]
            assert result.failures == []
            assert result.human_hash == hash_human_id(row["humanId"])


def test_attestation_outcomes_for_every_shared_vector(vectors: dict[str, Any], fixed_now):
    # Every shared attestation vector is eip191, which since the 7.5
    # fix pass (B1) never falls through to ERC-1271 — no RPC is
    # involved at all, the wrongSigner vector included.
    verifier = make_verifier(vectors, fixed_now)
    for name, vector in vectors["attestations"].items():
        expected_status, expected_failures = EXPECTED_ATTESTATION_OUTCOMES[name]
        result = verifier.verify_attestation(attestation_from_dict(vector))
        assert result.status == expected_status, name
        assert result.failures == expected_failures, name
        if expected_status == "verified":
            assert result.human_hash == hash_human_id(vectors["humans"]["human1"]), name


def test_canonical_message_pathological_extra_shapes(vectors: dict[str, Any]):
    """The 7.5 canonical regressions (M7/M8/m3), asserted on the
    produced string as in the TS suite; recovery over every vector
    (above) proves the same bytes end to end."""
    attestations = vectors["attestations"]
    proto = canonical_attestation_message(
        payload_from_dict(attestations["extraProtoKey"]["payload"])
    )
    assert '"__proto__":"proto-value"' in proto
    integers = canonical_attestation_message(
        payload_from_dict(attestations["extraIntegerKeys"]["payload"])
    )
    assert '"extra":{"1":"one","10":"ten","2":"two","a":"letter"}' in integers
    astral = canonical_attestation_message(
        payload_from_dict(attestations["extraAstralKeys"]["payload"])
    )
    assert astral.index("\ue000") > -1
    assert astral.index("\ue000") < astral.index("\U00020000")


def test_canonical_message_matches_json_stringify_for_surrogates(vectors: dict[str, Any]):
    payload = payload_from_dict(vectors["attestations"]["valid"]["payload"])
    payload.extra = {
        "\U00020000": "astral",
        "\ud800": "lone",
        "\ue000": "bmp",
    }
    message = canonical_attestation_message(payload)
    assert '"extra":{"\ue000":"bmp","\\ud800":"lone","\U00020000":"astral"}' in message
    assert "\ud800" not in message

    # JavaScript stores astral characters as UTF-16 surrogate pairs,
    # but JSON.stringify emits the scalar character.
    payload.extra = {"\ud83d\ude00": "smile"}
    assert '"extra":{"😀":"smile"}' in canonical_attestation_message(payload)


def test_valid_disclosure_none_strips_hash_publicly_only(vectors: dict[str, Any], fixed_now):
    verifier = make_verifier(vectors, fixed_now)
    internal = verifier.verify_attestation(
        attestation_from_dict(vectors["attestations"]["validDisclosureNone"])
    )
    assert internal.status == "verified"
    assert internal.human_hash == hash_human_id(vectors["humans"]["human1"])
    assert to_public_verify_result(internal).human_hash is None
    public_default = to_public_verify_result(
        verifier.verify_attestation(attestation_from_dict(vectors["attestations"]["valid"]))
    )
    assert public_default.human_hash == hash_human_id(vectors["humans"]["human1"])


def test_reader_built_from_vectors_matches_lookup_rows(vectors: dict[str, Any]):
    reader = StaticReader(
        {row["address"]: row["humanId"] for row in vectors["lookups"]}, source="fixture"
    )
    verifier = create_verifier(reader=reader)
    assert verifier.verify_address(vectors["wallets"]["operatorD"]).human_hash == (
        hash_human_id(vectors["humans"]["human2"])
    )


def test_erc1271_magic_constant_matches_stub(vectors: dict[str, Any]):
    # Guards the test harness itself: the stub's magic result is the
    # ERC-1271 value the verifier checks for.
    assert MAGIC_RESULT.startswith("0x1626ba7e")


def test_signed_message_outcomes_for_every_shared_vector(vectors: dict[str, Any], fixed_now):
    """Signed-message parity (SPEC 3.6 amendment, D5): every shared
    signedMessages vector runs through verify_signed_message and lands
    on the outcome its recorded fields pin. The section is additive in
    the TS vectors — when it is present, every entry is covered; the
    recorded signer doubles as the expected address, so a passing
    vector must verify, report the checksummed signer, and carry no
    failures. Mirrors the TS suite's use of the same vector
    (packages/verify-ts/test/verify.test.ts)."""
    verifier = make_verifier(vectors, fixed_now)
    for name, vector in vectors["signedMessages"].items():
        # Fixture sanity, as in the TS suite: the vector's signer is
        # the wallet recorded under the same name.
        assert vector["signer"] == vectors["wallets"][name], name
        result = verifier.verify_signed_message(
            vector["message"],
            vector["signature"],
            "eoa",
            expected_address=vector["signer"],
        )
        assert result.verified is True, name
        assert result.address == vector["signer"], name
        assert result.failures == [], name
        # Bare (no expected address) the same vector verifies, and the
        # result is exactly the amendment's small shape — no human
        # identifier in either direction.
        bare = verifier.verify_signed_message(
            vector["message"], vector["signature"], "eoa"
        )
        assert bare.verified is True, name
        assert bare.address == vector["signer"], name
        assert set(bare.to_dict()) == {"verified", "address", "failures"}, name
