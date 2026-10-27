// Core types for @fiador/verify. This file is the type-level form of
// SPEC.md section 3.0 (W0 verify core spec). The internal/public split
// defined here is a hard boundary, not a display preference: see
// toPublicVerifyResult in projection.ts.

export type EvmAddress = `0x${string}`;

export type VerificationStatus =
  | 'verified' // checked live: registration (and attestation, if any) valid
  | 'unregistered' // checked live: no AgentBook entry for the address
  | 'expired' // attestation exists but is past expiresAt
  | 'invalid' // attestation malformed, mis-signed, or mis-bound
  | 'unknown'; // the check itself failed (RPC, network, timeout)

export type FailureCode =
  | 'malformed_address'
  | 'malformed_attestation'
  | 'unsupported_version'
  | 'signature_mismatch' // signature does not recover to the claimed wallet
  | 'subject_mismatch' // attestation binds a different subject than asked
  | 'wallet_mismatch' // attestation wallet != address under check
  | 'not_yet_valid' // issuedAt in the future beyond skew
  | 'expired'
  | 'attestation_lifetime_invalid' // expiresAt - issuedAt exceeds the 90-day
  // protocol lifetime cap (or is not positive). Split out of
  // malformed_attestation on the 7.5 review's M6 so consumers can report
  // the signature and binding stages honestly for a well-formed document
  // whose only defect is its lifetime (SPEC 3.0).
  | 'not_registered'
  | 'replay_detected' // nonce already seen (only when a nonce store is supplied)
  | 'lookup_failed' // RPC / transport failure -> status 'unknown'
  | 'lookup_timeout'
  // Added when the attested_subject path was built, per SPEC 3.5:
  // a resolver found no attestation for the subject at all.
  | 'attestation_not_found';

export interface CheckEvidence {
  checkedAt: string; // ISO 8601, when the live check ran
  source: 'live' | 'cache' | 'fixture';
  agentBook: { network: 'eip155:480'; contract: EvmAddress };
  rpcLatencyMs?: number;
}

export interface VerifyResult {
  // INTERNAL shape: server-side only, between trusted components.
  status: VerificationStatus;
  address: EvmAddress; // checksummed, as checked
  addressTruncated: string; // '0x7d7D…6097f' form, safe for public output
  humanHash: string | null; // see SPEC 3.5; null unless status is 'verified'
  humanId?: string | null; // INTERNAL ONLY: present only when the verifier
  // was built with includeRawHumanId. Never serialised to a public surface.
  failures: FailureCode[]; // empty iff status is 'verified'
  evidence: CheckEvidence;
  // INTERNAL ONLY: the attestation's recorded disclosure choice, when this
  // result derives from an attestation. Read by toPublicVerifyResult (which
  // omits humanHash when it is 'none') and never copied into the public
  // shape. New internal fields are private by default (SPEC 3.0).
  disclosure?: 'hash' | 'none';
}

export interface PublicVerifyResult {
  // PUBLIC shape: the only form any public output may take.
  status: VerificationStatus;
  addressTruncated: string;
  humanHash: string | null;
  failures: FailureCode[];
  evidence: CheckEvidence;
}

export interface AttestationPayloadV1 {
  version: 1;
  subject: { type: string; id: string };
  agentWalletAddress: EvmAddress;
  attestationUrl?: string; // where this payload is hosted
  operatorDisplayName?: string; // self-asserted, always labelled as such
  humanIdDisclosure: 'hash' | 'none'; // whether public outputs may show the
  // humanHash for this attestation, or no human identifier at all.
  // There is no 'raw' (SPEC 3.2).
  issuedAt: string; // ISO 8601
  expiresAt: string; // ISO 8601, at most 90 days after issuedAt
  nonce: string; // >= 128 bits of entropy, hex or base64url
  extra?: Record<string, string>; // subject-specific fields; signed,
  // not interpreted by this package
}

export interface SignedAttestation {
  payload: AttestationPayloadV1;
  signature: string; // 0x-prefixed EIP-191 signature over the canonical form
  signatureType: 'eip191' | 'eip1271';
}

export interface AgentBookReader {
  // Returns the raw humanId for the core's internal use, or null when the
  // contract read succeeded and there is no entry. MUST throw on
  // transport/RPC failure so the core can return 'unknown' instead of
  // misreporting 'unregistered' (SPEC 3.1).
  lookupHuman(address: EvmAddress): Promise<string | null>;
  // Provenance label copied into result evidence. Live readers use 'live';
  // fixture-replay readers use 'fixture'.
  source?: 'live' | 'fixture';
}

export interface VerifyCoreOptions {
  reader?: AgentBookReader; // default: direct viem readContract reader (reader.ts)
  rpcUrl?: string; // World Chain RPC; default: the chain's public RPC
  contractAddress?: EvmAddress; // default: canonical AgentBook (SPEC section 2)
  timeoutMs?: number; // per-lookup deadline, default 5000
  now?: () => Date;
  clockSkewMs?: number; // default 60_000
  includeRawHumanId?: boolean; // default false. When false, the core hashes
  // the lookup value and retains no raw humanId in the result at all. When
  // true, the INTERNAL result carries it for trusted server-side callers.
  // It never affects the public shape.
}

export interface VerifyAttestationOptions {
  expectedSubject?: { type: string; id: string };
  expectedWallet?: EvmAddress;
  nonceStore?: {
    // A single ATOMIC claim (7.5 review B2): resolves true when this
    // call newly recorded the nonce for the wallet, false when the
    // nonce was already claimed (a replay). The previous has/add pair
    // had a check-then-set race between the two awaits; there is no
    // safe way to compose them, so the contract is one operation.
    claim(nonce: string, wallet: EvmAddress, expiresAt: string): Promise<boolean>;
  };
  checkRegistration?: boolean; // default true: also run the AgentBook lookup
  signal?: AbortSignal;
}

export type StatusSubject =
  | { kind: 'address'; address: string }
  | { kind: 'attestation'; attestation: SignedAttestation }
  | {
      kind: 'attested_subject';
      subject: { type: string; id: string };
      resolveAttestation: (
        subject: { type: string; id: string },
        signal?: AbortSignal,
      ) => Promise<SignedAttestation | null | undefined>;
    };

export interface Verifier {
  verifyAddress(
    address: string,
    opts?: { signal?: AbortSignal },
  ): Promise<VerifyResult>;
  verifyAttestation(
    attestation: unknown,
    opts?: VerifyAttestationOptions,
  ): Promise<VerifyResult>;
  resolveStatus(
    subject: StatusSubject,
    opts?: { signal?: AbortSignal },
  ): Promise<VerifyResult>;
}
