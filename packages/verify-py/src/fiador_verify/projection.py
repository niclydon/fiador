"""The internal -> public projection (SPEC 3.0)."""

from __future__ import annotations

from .types import AgentBookRef, CheckEvidence, PublicVerifyResult, VerifyResult


def to_public_verify_result(result: VerifyResult) -> PublicVerifyResult:
    """The package's only sanctioned way to turn a result into wire data.

    Returns a FRESH object containing no humanId and no full address,
    never a redacted view of the internal object, so a later-added
    internal field cannot leak by default. The attestation disclosure
    choice narrows the output further, never wider: 'none' omits the
    humanHash as well (SPEC 3.5).
    """
    evidence = result.evidence
    return PublicVerifyResult(
        status=result.status,
        address_truncated=result.address_truncated,
        human_hash=None if result.disclosure == "none" else result.human_hash,
        failures=list(result.failures),
        evidence=CheckEvidence(
            checked_at=evidence.checked_at,
            source=evidence.source,
            agent_book=AgentBookRef(
                network=evidence.agent_book.network,
                contract=evidence.agent_book.contract,
            ),
            rpc_latency_ms=evidence.rpc_latency_ms,
        ),
    )
