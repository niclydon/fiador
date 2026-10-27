"""The canonical signing form and envelope validation.

The canonical form is part of the protocol and versioned with the
payload (SPEC 3.2): JSON with keys in the exact order of the payload
definition, ``extra`` keys sorted lexicographically, no insignificant
whitespace, addresses checksummed, timestamps in UTC ISO 8601 with
``Z``. This deterministic string — and nothing else — is the message
that is signed. Byte-for-byte parity with the TypeScript core is
proven by the shared fixture vectors: every vector signature recovers
to its wallet over the string this function produces.
"""

from __future__ import annotations

import calendar
import json
import re
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from .addresses import checksum_address, is_address
from .types import AttestationPayloadV1, SignedAttestation, Subject

_ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$")
_HEX_NONCE = re.compile(r"^[0-9a-fA-F]{32,}$")
_B64URL_NONCE = re.compile(r"^[A-Za-z0-9_-]{22,}$")
_SIGNATURE_RE = re.compile(r"^0x[0-9a-fA-F]{130}$")

_PAYLOAD_KEYS = {
    "version",
    "subject",
    "agentWalletAddress",
    "attestationUrl",
    "operatorDisplayName",
    "humanIdDisclosure",
    "issuedAt",
    "expiresAt",
    "nonce",
    "extra",
}


def parse_iso8601_z_ms(value: str) -> int:
    """Epoch milliseconds for a strict ``...Z`` ISO 8601 timestamp.

    Raises ValueError for anything the module's ISO_Z shape or the
    calendar rejects (the JS ``Date.parse`` NaN cases)."""
    if not isinstance(value, str) or not _ISO_Z.match(value):
        raise ValueError(f"not an ISO 8601 Z timestamp: {value!r}")
    body = value[:-1]  # strip 'Z'
    base, dot, frac = body.partition(".")
    dt = datetime.strptime(base, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    ms = int(frac.ljust(3, "0")) if dot else 0
    return calendar.timegm(dt.timetuple()) * 1000 + ms


def _is_parseable_iso_z(value: Any) -> bool:
    if not isinstance(value, str) or not _ISO_Z.match(value):
        return False
    try:
        parse_iso8601_z_ms(value)
    except ValueError:
        return False
    return True


def canonical_attestation_message(payload: AttestationPayloadV1 | Mapping[str, Any]) -> str:
    """The exact string that is signed for a payload (SPEC 3.2)."""
    wire: Mapping[str, Any]
    if isinstance(payload, AttestationPayloadV1):
        wire = payload.to_wire_dict()
    else:
        wire = payload
    ordered: dict[str, Any] = {}
    ordered["version"] = wire["version"]
    subject = wire["subject"]
    ordered["subject"] = {"type": subject["type"], "id": subject["id"]}
    ordered["agentWalletAddress"] = checksum_address(wire["agentWalletAddress"])
    if wire.get("attestationUrl") is not None:
        ordered["attestationUrl"] = wire["attestationUrl"]
    if wire.get("operatorDisplayName") is not None:
        ordered["operatorDisplayName"] = wire["operatorDisplayName"]
    ordered["humanIdDisclosure"] = wire["humanIdDisclosure"]
    ordered["issuedAt"] = wire["issuedAt"]
    ordered["expiresAt"] = wire["expiresAt"]
    ordered["nonce"] = wire["nonce"]
    extra = wire.get("extra")
    if extra is not None:
        ordered["extra"] = {key: extra[key] for key in sorted(extra.keys())}
    # ensure_ascii=False matches JSON.stringify: non-ASCII is emitted
    # raw (UTF-8), separators are bare, key order is insertion order.
    return json.dumps(ordered, separators=(",", ":"), ensure_ascii=False)


def _is_plain_object(value: Any) -> bool:
    return isinstance(value, dict)


def validate_payload(value: Any) -> tuple[Optional[AttestationPayloadV1], list[str]]:
    """Envelope validation (SPEC 3.3 step 1): parses and checks the
    payload's shape, version, and field forms. Date semantics,
    lifetime, signature, binding, and registration are the verifier's
    later steps, not this one.

    Returns (payload, []) on success, (None, failures) otherwise."""
    malformed: tuple[None, list[str]] = (None, ["malformed_attestation"])
    if not _is_plain_object(value):
        return malformed
    for key in value.keys():
        if key not in _PAYLOAD_KEYS:
            return malformed
    if "version" in value:
        version = value["version"]
        if isinstance(version, bool) or version != 1:
            return None, ["unsupported_version"]
    if value.get("version") != 1 or isinstance(value.get("version"), bool):
        return malformed

    subject = value.get("subject")
    if (
        not _is_plain_object(subject)
        or not isinstance(subject.get("type"), str)
        or len(subject["type"]) == 0
        or not isinstance(subject.get("id"), str)
        or len(subject["id"]) == 0
    ):
        return malformed

    if not isinstance(value.get("agentWalletAddress"), str) or not is_address(
        value["agentWalletAddress"]
    ):
        return malformed
    try:
        wallet = checksum_address(value["agentWalletAddress"])
    except ValueError:
        return malformed

    if value.get("attestationUrl") is not None and (
        not isinstance(value["attestationUrl"], str) or len(value["attestationUrl"]) > 2048
    ):
        return malformed
    if value.get("operatorDisplayName") is not None and (
        not isinstance(value["operatorDisplayName"], str)
        or len(value["operatorDisplayName"]) > 128
    ):
        return malformed
    if value.get("humanIdDisclosure") not in ("hash", "none"):
        return malformed
    if not _is_parseable_iso_z(value.get("issuedAt")) or not _is_parseable_iso_z(
        value.get("expiresAt")
    ):
        return malformed
    nonce = value.get("nonce")
    if not isinstance(nonce, str) or not (_HEX_NONCE.match(nonce) or _B64URL_NONCE.match(nonce)):
        return malformed

    extra: Optional[dict[str, str]] = None
    if value.get("extra") is not None:
        if not _is_plain_object(value["extra"]):
            return malformed
        extra = {}
        for k, v in value["extra"].items():
            if not isinstance(v, str):
                return malformed
            extra[k] = v

    payload = AttestationPayloadV1(
        version=1,
        subject=Subject(type=subject["type"], id=subject["id"]),
        agent_wallet_address=wallet,
        attestation_url=value.get("attestationUrl"),
        operator_display_name=value.get("operatorDisplayName"),
        human_id_disclosure=value["humanIdDisclosure"],
        issued_at=value["issuedAt"],
        expires_at=value["expiresAt"],
        nonce=nonce,
        extra=extra,
    )
    return payload, []


def validate_signed_attestation(
    value: Any,
) -> tuple[Optional[SignedAttestation], list[str], Optional[str]]:
    """Full envelope validation of a signed attestation presented as
    unknown input. When the payload names a well-formed wallet, it is
    returned alongside failures so the result can still be addressed
    to it. Returns (attestation, failures, wallet)."""
    if not _is_plain_object(value):
        return None, ["malformed_attestation"], None
    payload, failures = validate_payload(value.get("payload"))
    if payload is None:
        partial = value.get("payload") if _is_plain_object(value.get("payload")) else None
        wallet: Optional[str] = None
        if partial is not None and is_address(partial.get("agentWalletAddress")):
            try:
                wallet = checksum_address(partial["agentWalletAddress"])
            except ValueError:
                wallet = None
        return None, failures, wallet
    wallet = payload.agent_wallet_address
    if not isinstance(value.get("signature"), str) or not _SIGNATURE_RE.match(
        value["signature"]
    ):
        return None, ["malformed_attestation"], wallet
    if value.get("signatureType") not in ("eip191", "eip1271"):
        return None, ["malformed_attestation"], wallet
    return (
        SignedAttestation(
            payload=payload,
            signature=value["signature"],
            signature_type=value["signatureType"],
        ),
        [],
        wallet,
    )
