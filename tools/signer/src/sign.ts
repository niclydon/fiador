// Signing (DESIGN §3.2). EIP-191 personal_sign over the core's canonical
// message, nothing else. Refusals, all before any signature is produced:
// the key does not control the draft's wallet; the wallet is not (or no
// longer) registered in AgentBook; the draft's human_id_hash is stale
// against a fresh live lookup; the draft is already expired; the draft's
// disclosure is not the Discord profile's pinned 'hash'.

import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  canonicalAttestationMessage,
  truncateAddress,
  type AttestationPayloadV1,
  type SignedAttestation,
  type Verifier,
} from '@fiador/verify';

export interface SignOptions {
  draft: AttestationPayloadV1;
  privateKey: Hex;
  now?: Date;
}

export async function signDraft(
  verifier: Verifier,
  opts: SignOptions,
): Promise<SignedAttestation> {
  const { draft } = opts;
  const account = privateKeyToAccount(opts.privateKey);

  if (getAddress(account.address) !== getAddress(draft.agentWalletAddress)) {
    throw new Error(
      `the key controls ${truncateAddress(account.address)}, not the draft's ` +
        `wallet ${truncateAddress(draft.agentWalletAddress)}; refusing to sign`,
    );
  }
  if (draft.humanIdDisclosure !== 'hash') {
    throw new Error(
      `draft disclosure is '${draft.humanIdDisclosure}'; the Discord profile pins 'hash' (§3.1)`,
    );
  }
  const now = opts.now ?? new Date();
  if (Date.parse(draft.expiresAt) <= now.getTime()) {
    throw new Error('draft is already expired; re-run draft');
  }

  // Fresh live check at signing time (§3.2 point 5 discipline): the wallet
  // must be registered NOW, and the hash baked into the draft must still
  // be the registration's hash.
  const registration = await verifier.verifyAddress(draft.agentWalletAddress);
  if (registration.status !== 'verified' || registration.humanHash === null) {
    throw new Error(
      `wallet ${truncateAddress(draft.agentWalletAddress)} is not registered in ` +
        `AgentBook (status: ${registration.status}); refusing to sign`,
    );
  }
  if (draft.extra?.human_id_hash !== registration.humanHash) {
    throw new Error(
      'draft human_id_hash does not match the live registration; re-run draft',
    );
  }

  const signature = await account.signMessage({
    message: canonicalAttestationMessage(draft),
  });
  return { payload: draft, signature, signatureType: 'eip191' };
}
