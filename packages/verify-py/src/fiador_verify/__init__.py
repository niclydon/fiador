"""fiador-verify — Python parity port of @fiador/verify (W0 spec 3).

Verify that a unique human stands behind an agent wallet: AgentBook
registration lookups and signed operator attestations, with a
hash-only public result shape. The export surface mirrors the
TypeScript package's, field-for-field with snake_case names (W1
DESIGN 4.1): the names below, and no others.
"""

from __future__ import annotations

from .canonical import canonical_attestation_message
from .hashes import hash_human_id, truncate_address
from .projection import to_public_verify_result
from .types import (
    VERIFICATION_STATUSES,
    AgentBookReader,
    AttestedSubject,
    AttestationPayloadV1,
    AttestationSubjectInput,
    AddressSubject,
    CheckEvidence,
    NonceStore,
    PublicVerifyResult,
    SignedAttestation,
    SignedMessageResult,
    Subject,
    VerifyAttestationOptions,
    VerifyCoreOptions,
    VerifyResult,
)
from .verifier import Verifier, create_verifier

__version__ = "0.1.0"

__all__ = [
    "create_verifier",
    "Verifier",
    "to_public_verify_result",
    "canonical_attestation_message",
    "hash_human_id",
    "truncate_address",
    "is_verification_status",
    "AgentBookReader",
    "NonceStore",
    "AttestationPayloadV1",
    "SignedAttestation",
    "Subject",
    "CheckEvidence",
    "VerifyResult",
    "PublicVerifyResult",
    "SignedMessageResult",
    "VerifyCoreOptions",
    "VerifyAttestationOptions",
    "AddressSubject",
    "AttestationSubjectInput",
    "AttestedSubject",
    "__version__",
]


def is_verification_status(value: object) -> bool:
    """Guard for consumers parsing status values off the wire (for
    example the badge service's JSON, SPEC 4.2)."""
    return isinstance(value, str) and value in VERIFICATION_STATUSES
