"""Core types for fiador-verify.

This module is the Python form of SPEC.md section 3.0 (W0 verify core
spec), mirroring ``@fiador/verify`` field-for-field with snake_case
names (W1 DESIGN 4.1). The internal/public split defined here is a hard
boundary, not a display preference: see
:func:`fiador_verify.projection.to_public_verify_result`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Optional, Protocol

# World Chain (W0 spec section 2).
WORLD_CHAIN_ID = 480
WORLD_CHAIN_NETWORK = "eip155:480"

VerificationStatus = Literal["verified", "unregistered", "expired", "invalid", "unknown"]

FailureCode = Literal[
    "malformed_address",
    "malformed_attestation",
    "unsupported_version",
    "signature_mismatch",  # signature does not recover to the claimed wallet
    "subject_mismatch",  # attestation binds a different subject than asked
    "wallet_mismatch",  # attestation wallet != address under check
    "not_yet_valid",  # issuedAt in the future beyond skew
    "expired",
    "not_registered",
    "replay_detected",  # nonce already seen (only with a nonce store)
    "lookup_failed",  # RPC / transport failure -> status 'unknown'
    "lookup_timeout",
    # Added when the attested_subject path was built, per SPEC 3.5:
    # a resolver found no attestation for the subject at all.
    "attestation_not_found",
]

VERIFICATION_STATUSES = frozenset(
    ["verified", "unregistered", "expired", "invalid", "unknown"]
)


@dataclass
class AgentBookRef:
    network: str  # always 'eip155:480' in v1
    contract: str  # EvmAddress, as configured

    def to_dict(self) -> dict[str, Any]:
        return {"network": self.network, "contract": self.contract}


@dataclass
class CheckEvidence:
    checked_at: str  # ISO 8601, when the live check ran
    source: str  # 'live' | 'cache' | 'fixture'
    agent_book: AgentBookRef
    rpc_latency_ms: Optional[int] = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "checked_at": self.checked_at,
            "source": self.source,
            "agent_book": self.agent_book.to_dict(),
        }
        if self.rpc_latency_ms is not None:
            out["rpc_latency_ms"] = self.rpc_latency_ms
        return out


@dataclass
class VerifyResult:
    """INTERNAL shape: server-side only, between trusted components."""

    status: str  # VerificationStatus
    address: str  # checksummed, as checked
    address_truncated: str  # '0x7d7D…6097f' form, safe for public output
    human_hash: Optional[str]  # see SPEC 3.5; None unless status is 'verified'
    failures: list[str]  # FailureCode[]; empty iff status is 'verified'
    evidence: CheckEvidence
    # INTERNAL ONLY: populated only when the verifier was built with
    # include_raw_human_id AND a humanId was actually looked up. Never
    # serialised to a public surface.
    human_id: Optional[str] = None
    # INTERNAL ONLY: the attestation's recorded disclosure choice, when
    # this result derives from an attestation. Read by
    # to_public_verify_result (which omits human_hash when it is 'none')
    # and never copied into the public shape. New internal fields are
    # private by default (SPEC 3.0).
    disclosure: Optional[str] = None  # 'hash' | 'none'

    def to_dict(self) -> dict[str, Any]:
        """Internal serialisation. The human_id key is present only when
        a raw value is actually carried, mirroring the TS shape."""
        out: dict[str, Any] = {
            "status": self.status,
            "address": self.address,
            "address_truncated": self.address_truncated,
            "human_hash": self.human_hash,
            "failures": list(self.failures),
            "evidence": self.evidence.to_dict(),
        }
        if self.human_id is not None:
            out["human_id"] = self.human_id
        if self.disclosure is not None:
            out["disclosure"] = self.disclosure
        return out


@dataclass
class PublicVerifyResult:
    """PUBLIC shape: the only form any public output may take."""

    status: str  # VerificationStatus
    address_truncated: str
    human_hash: Optional[str]
    failures: list[str]
    evidence: CheckEvidence

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "address_truncated": self.address_truncated,
            "human_hash": self.human_hash,
            "failures": list(self.failures),
            "evidence": self.evidence.to_dict(),
        }


@dataclass
class Subject:
    type: str
    id: str

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, "id": self.id}


@dataclass
class AttestationPayloadV1:
    version: int  # always 1 in v1
    subject: Subject
    agent_wallet_address: str  # EvmAddress
    human_id_disclosure: str  # 'hash' | 'none'; there is no 'raw' (SPEC 3.2)
    issued_at: str  # ISO 8601
    expires_at: str  # ISO 8601, at most 90 days after issued_at
    nonce: str  # >= 128 bits of entropy, hex or base64url
    attestation_url: Optional[str] = None  # where this payload is hosted
    operator_display_name: Optional[str] = None  # self-asserted
    extra: Optional[dict[str, str]] = None  # subject-specific; signed,
    # not interpreted by this package

    def to_wire_dict(self) -> dict[str, Any]:
        """The payload as a JSON-shaped dict (camelCase keys), with
        absent optional fields omitted, as on the wire."""
        out: dict[str, Any] = {
            "version": self.version,
            "subject": {"type": self.subject.type, "id": self.subject.id},
            "agentWalletAddress": self.agent_wallet_address,
        }
        if self.attestation_url is not None:
            out["attestationUrl"] = self.attestation_url
        if self.operator_display_name is not None:
            out["operatorDisplayName"] = self.operator_display_name
        out["humanIdDisclosure"] = self.human_id_disclosure
        out["issuedAt"] = self.issued_at
        out["expiresAt"] = self.expires_at
        out["nonce"] = self.nonce
        if self.extra is not None:
            out["extra"] = dict(self.extra)
        return out


@dataclass
class SignedAttestation:
    payload: AttestationPayloadV1
    signature: str  # 0x-prefixed EIP-191 signature over the canonical form
    signature_type: str  # 'eip191' | 'eip1271'

    def to_wire_dict(self) -> dict[str, Any]:
        return {
            "payload": self.payload.to_wire_dict(),
            "signature": self.signature,
            "signatureType": self.signature_type,
        }


class AgentBookReader(Protocol):
    """Returns the raw humanId for the core's internal use, or None when
    the contract read succeeded and there is no entry. MUST raise on
    transport/RPC failure so the core can return 'unknown' instead of
    misreporting 'unregistered' (SPEC 3.1)."""

    source: str  # provenance label copied into evidence: 'live' | 'fixture'

    def lookup_human(self, address: str) -> Optional[str]:
        ...


class NonceStore(Protocol):
    def has(self, nonce: str, wallet: str) -> bool:
        ...

    def add(self, nonce: str, wallet: str, expires_at: str) -> None:
        ...


@dataclass
class VerifyCoreOptions:
    reader: Optional[AgentBookReader] = None  # default: direct contract read
    rpc_url: Optional[str] = None  # World Chain RPC; default: the chain's public RPC
    contract_address: Optional[str] = None  # default: canonical AgentBook
    timeout_ms: int = 5000  # per-lookup deadline
    now: Optional[Callable[[], Any]] = None  # () -> datetime; test injection
    clock_skew_ms: int = 60_000
    include_raw_human_id: bool = False  # default False. When False, the
    # core hashes the lookup value and retains no raw humanId in the
    # result at all. When True, the INTERNAL result carries it for
    # trusted server-side callers. It never affects the public shape.


@dataclass
class VerifyAttestationOptions:
    expected_subject: Optional[Subject] = None
    expected_wallet: Optional[str] = None
    nonce_store: Optional[NonceStore] = None
    check_registration: bool = True  # also run the AgentBook lookup
    # Parity adaptation: where TS takes an AbortSignal, Python takes a
    # threading.Event; setting it aborts a pending lookup, which the
    # core reports as 'unknown' + lookup_failed, exactly like TS.
    signal: Any = None


@dataclass
class AddressSubject:
    address: str
    kind: str = field(default="address", init=False)


@dataclass
class AttestationSubjectInput:
    attestation: Any  # SignedAttestation or a wire-shaped dict
    kind: str = field(default="attestation", init=False)


@dataclass
class AttestedSubject:
    subject: Subject
    resolve_attestation: Callable[[Subject], Optional[Any]]
    kind: str = field(default="attested_subject", init=False)


StatusSubject = Any  # AddressSubject | AttestationSubjectInput | AttestedSubject | dict


@dataclass
class SignedMessageResult:
    """Result of verify_signed_message (SPEC 3.6, D5 amendment). Its own
    small shape, not a VerifyResult: no lookup, no attestation semantics."""

    verified: bool
    address: Optional[str]  # checksummed signer, when one was established
    failures: list[str]  # FailureCode[]

    def to_dict(self) -> dict[str, Any]:
        return {
            "verified": self.verified,
            "address": self.address,
            "failures": list(self.failures),
        }
