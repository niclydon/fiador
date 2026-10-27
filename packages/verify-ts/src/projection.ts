import type { PublicVerifyResult, VerifyResult } from './types.js';

// The package's only sanctioned way to turn a result into wire data
// (SPEC 3.0). Returns a FRESH object containing no humanId key and no
// full address, never a redacted view of the internal object, so a
// later-added internal field cannot leak by default. The attestation
// disclosure choice narrows the output further, never wider: 'none'
// omits the humanHash as well (SPEC 3.5).
export function toPublicVerifyResult(result: VerifyResult): PublicVerifyResult {
  return {
    status: result.status,
    addressTruncated: result.addressTruncated,
    humanHash: result.disclosure === 'none' ? null : result.humanHash,
    failures: [...result.failures],
    evidence: {
      checkedAt: result.evidence.checkedAt,
      source: result.evidence.source,
      // Enumerated, not spread (7.5 review M13): a poisoned or
      // future internal evidence object carrying extra keys inside
      // agentBook must not ride through the projection.
      agentBook: {
        network: result.evidence.agentBook.network,
        contract: result.evidence.agentBook.contract,
      },
      ...(result.evidence.rpcLatencyMs !== undefined
        ? { rpcLatencyMs: result.evidence.rpcLatencyMs }
        : {}),
    },
  };
}
