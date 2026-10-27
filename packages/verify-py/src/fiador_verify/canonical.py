"""The canonical signing form and envelope validation.

The canonical form is part of the protocol and versioned with the
payload (SPEC 3.2): JSON with keys in the exact order of the payload
definition, ``extra`` keys sorted by Unicode code point (UTF-8 byte
order), no insignificant whitespace, addresses checksummed,
timestamps in UTC ISO 8601 with ``Z``. This deterministic string —
and nothing else — is the message that is signed. Byte-for-byte
parity with the TypeScript core is proven by the shared fixture
vectors: every vector signature recovers to its wallet over the
string this function produces.

The string is assembled field by field from the sorted ``extra``
entries, never by handing a dict to a JSON serialiser (7.5 review
M7/M8/m3, mirrored from TS @fiador/verify 0.3.0): a serialiser may
re-order integer-like keys numerically ("1","2","10" instead of
"1","10","2"), and an ``extra`` key like ``__proto__`` must be bound
by the signature as ordinary data — in Python it is, provided the
entries are emitted explicitly in sorted order. Sorting is by the
keys' UTF-8 encodings; escaped lone UTF-16 surrogates use
TextEncoder's replacement-character ordering.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping, Optional

from .addresses import checksum_address, is_address
from .types import AttestationPayloadV1, SignedAttestation, Subject

_ISO_Z_CAPTURE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$"
)
_HEX_NONCE = re.compile(r"^[0-9a-fA-F]{32,}$")
_B64URL_NONCE = re.compile(r"^[A-Za-z0-9_-]{22,}$")

# The signature shape gate follows the DECLARED type (7.5 review B1):
# an EIP-191 signature is exactly 65 bytes; an ERC-1271 signature is
# an opaque blob whose length is the contract's own business (Safe
# and passkey validators routinely exceed 65 bytes), so it is gated
# only as non-empty even-length hex.
_EIP191_SIGNATURE_RE = re.compile(r"^0x[0-9a-fA-F]{130}$")
_EIP1271_SIGNATURE_RE = re.compile(r"^0x(?:[0-9a-fA-F]{2})+$")

# Length caps on attacker-controlled strings (7.5 review m4):
# generous for every legitimate use, small enough that a hostile
# document cannot make the verifier (or its logs and stores) carry
# unbounded fields.
MAX_NONCE_LENGTH = 128
MAX_SUBJECT_TYPE_LENGTH = 64
MAX_SUBJECT_ID_LENGTH = 256

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

_ENVELOPE_KEYS = {"payload", "signature", "signatureType"}


def _days_in_month(year: int, month: int) -> int:
    if month == 2:
        leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
        return 29 if leap else 28
    return (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[month - 1]


def is_valid_iso_z_timestamp(value: Any) -> bool:
    """Strict calendar validation (7.5 review M9), mirroring the TS
    core's Date.UTC round-trip: components must be in range for the
    proleptic Gregorian calendar, so impossible dates (2026-02-30)
    are malformed instead of rolling over. Years 0000-0099 are
    rejected because JS Date.UTC maps them onto 1900-1999, which
    fails the TS round-trip the same way."""
    if not isinstance(value, str):
        return False
    m = _ISO_Z_CAPTURE.match(value)
    if not m:
        return False
    year, month, day, hour, minute, second = (int(g) for g in m.groups()[:6])
    if year <= 99:
        return False
    if not 1 <= month <= 12:
        return False
    if not 1 <= day <= _days_in_month(year, month):
        return False
    return hour <= 23 and minute <= 59 and second <= 59


def parse_iso8601_z_ms(value: str) -> int:
    """Epoch milliseconds for a strict ``...Z`` ISO 8601 timestamp.

    Raises ValueError for anything the strict calendar validation
    rejects (the JS ``Date.parse`` NaN cases)."""
    if not is_valid_iso_z_timestamp(value):
        raise ValueError(f"not a valid ISO 8601 Z timestamp: {value!r}")
    m = _ISO_Z_CAPTURE.match(value)
    assert m is not None
    year, month, day, hour, minute, second = (int(g) for g in m.groups()[:6])
    frac = m.group(7)
    ms = int(frac.ljust(3, "0")) if frac else 0
    # Days since 1970-01-01 in the proleptic Gregorian calendar
    # (Howard Hinnant's days-from-civil algorithm).
    y = year - (1 if month <= 2 else 0)
    era = y // 400
    yoe = y - era * 400
    mp = (month + 9) % 12
    doy = (153 * mp + 2) // 5 + day - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    days = era * 146097 + doe - 719468
    return (((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + ms


def _is_parseable_iso_z(value: Any) -> bool:
    return is_valid_iso_z_timestamp(value)


def _json_string(value: str) -> str:
    # Per-value serialisation only, where key order cannot arise.
    # ensure_ascii=False matches JSON.stringify: non-ASCII is emitted
    # raw (UTF-8). JavaScript strings are UTF-16: a valid surrogate
    # pair becomes one scalar, while a lone surrogate is escaped by
    # JSON.stringify rather than emitted as invalid UTF-8.
    normalized = value.encode("utf-16", "surrogatepass").decode(
        "utf-16", "surrogatepass"
    )
    encoded = json.dumps(normalized, ensure_ascii=False)
    return re.sub(
        r"[\ud800-\udfff]",
        lambda m: f"\\u{ord(m.group()):04x}",
        encoded,
    )


def _extra_sort_key(key: str) -> bytes:
    # TextEncoder replaces lone UTF-16 surrogates with U+FFFD. Keep
    # that ordering when an escaped surrogate appears in a JSON key.
    return key.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")


def canonical_attestation_message(payload: AttestationPayloadV1 | Mapping[str, Any]) -> str:
    """The exact string that is signed for a payload (SPEC 3.2)."""
    wire: Mapping[str, Any]
    if isinstance(payload, AttestationPayloadV1):
        wire = payload.to_wire_dict()
    else:
        wire = payload
    parts: list[str] = []
    parts.append(f'"version":{json.dumps(wire["version"])}')
    subject = wire["subject"]
    parts.append(
        f'"subject":{{"type":{_json_string(subject["type"])},"id":{_json_string(subject["id"])}}}'
    )
    parts.append(
        f'"agentWalletAddress":{_json_string(checksum_address(wire["agentWalletAddress"]))}'
    )
    if wire.get("attestationUrl") is not None:
        parts.append(f'"attestationUrl":{_json_string(wire["attestationUrl"])}')
    if wire.get("operatorDisplayName") is not None:
        parts.append(f'"operatorDisplayName":{_json_string(wire["operatorDisplayName"])}')
    parts.append(f'"humanIdDisclosure":{_json_string(wire["humanIdDisclosure"])}')
    parts.append(f'"issuedAt":{_json_string(wire["issuedAt"])}')
    parts.append(f'"expiresAt":{_json_string(wire["expiresAt"])}')
    parts.append(f'"nonce":{_json_string(wire["nonce"])}')
    extra = wire.get("extra")
    if extra is not None:
        entries = sorted(extra.items(), key=lambda kv: _extra_sort_key(kv[0]))
        inner = ",".join(f"{_json_string(k)}:{_json_string(v)}" for k, v in entries)
        parts.append(f'"extra":{{{inner}}}')
    return "{" + ",".join(parts) + "}"


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
        # The subject object is closed (7.5 review B3): exactly
        # {type, id}. A smuggled third field (for example a raw
        # humanId) is malformed, never silently carried into a
        # signed-payload reconstruction.
        or any(key not in ("type", "id") for key in subject.keys())
        or not isinstance(subject.get("type"), str)
        or len(subject["type"]) == 0
        or len(subject["type"]) > MAX_SUBJECT_TYPE_LENGTH
        or not isinstance(subject.get("id"), str)
        or len(subject["id"]) == 0
        or len(subject["id"]) > MAX_SUBJECT_ID_LENGTH
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

    if "attestationUrl" in value and (
        not isinstance(value["attestationUrl"], str) or len(value["attestationUrl"]) > 2048
    ):
        return malformed
    if "operatorDisplayName" in value and (
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
    if (
        not isinstance(nonce, str)
        or len(nonce) > MAX_NONCE_LENGTH
        or not (_HEX_NONCE.match(nonce) or _B64URL_NONCE.match(nonce))
    ):
        return malformed

    extra: Optional[dict[str, str]] = None
    if "extra" in value:
        if not _is_plain_object(value["extra"]):
            return malformed
        extra = {}
        for k, v in value["extra"].items():
            if not isinstance(k, str) or not isinstance(v, str):
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
    # The envelope is closed (7.5 review B3): exactly {payload,
    # signature, signatureType}. Any further key (for example a raw
    # humanId riding alongside the payload) makes the document
    # malformed, whatever its signature says.
    for key in value.keys():
        if key not in _ENVELOPE_KEYS:
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
    if value.get("signatureType") not in ("eip191", "eip1271"):
        return None, ["malformed_attestation"], wallet
    signature = value.get("signature")
    signature_ok = isinstance(signature, str) and (
        _EIP191_SIGNATURE_RE.match(signature)
        if value["signatureType"] == "eip191"
        else _EIP1271_SIGNATURE_RE.match(signature)
    )
    if not signature_ok:
        return None, ["malformed_attestation"], wallet
    return (
        SignedAttestation(
            payload=payload,
            signature=signature,
            signature_type=value["signatureType"],
        ),
        [],
        wallet,
    )
