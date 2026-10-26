#!/usr/bin/env node
// fiador-signer — the reference signer CLI (DESIGN §3.2 point 5).
//
//   fiador-signer draft  --application-id <id> --attestation-url <url>
//                        (--wallet <address> | --env-file <path>)
//                        [--bot-user-id <id>] [--operator-name <name>]
//                        [--days <1..90>] --out <file>
//   fiador-signer sign   --draft <file> --env-file <path> [--out <file>]
//   fiador-signer verify --file <signed.json>
//
// The wallet key comes from the env file (AGENT_PRIVATE_KEY), never from
// an argument, and is never printed or logged. The CLI derives the
// payload's human_id_hash from the wallet's live AgentBook registration;
// the full humanId never transits this process's output.

import { readFileSync, writeFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createVerifier, type AttestationPayloadV1 } from '@fiador/verify';
import { buildDraft, payloadHash } from './draft.js';
import { signDraft } from './sign.js';
import { verifyAttestation } from './verify.js';
import { loadAddressFromEnvFile, loadWalletFromEnvFile } from './env.js';

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = argv[++i];
    if (value === undefined) throw new Error(`flag --${name} needs a value`);
    flags[name] = value;
  }
  return flags;
}

function required(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (v === undefined || v === '') throw new Error(`--${name} is required`);
  return v;
}

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`cannot read file: ${path}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`file is not valid JSON: ${path}`);
  }
}

async function cmdDraft(flags: Record<string, string>): Promise<void> {
  const walletAddress =
    flags['wallet'] ??
    (flags['env-file'] ? loadAddressFromEnvFile(flags['env-file']) : undefined);
  if (!walletAddress) {
    throw new Error('draft needs --wallet <address> or --env-file <path>');
  }
  const payload = await buildDraft(createVerifier(), {
    applicationId: required(flags, 'application-id'),
    ...(flags['bot-user-id'] ? { botUserId: flags['bot-user-id'] } : {}),
    walletAddress,
    attestationUrl: required(flags, 'attestation-url'),
    ...(flags['operator-name'] ? { operatorName: flags['operator-name'] } : {}),
    ...(flags['days'] ? { days: Number(flags['days']) } : {}),
  });
  const out = required(flags, 'out');
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`wrote ${out}`);
  console.log(`payloadHash: ${payloadHash(payload)}`);
  console.log(`expiresAt: ${payload.expiresAt}`);
}

async function cmdSign(flags: Record<string, string>): Promise<void> {
  const draftRaw = readJsonFile(required(flags, 'draft'));
  if (
    typeof draftRaw !== 'object' ||
    draftRaw === null ||
    'payload' in (draftRaw as Record<string, unknown>) ||
    'signature' in (draftRaw as Record<string, unknown>)
  ) {
    throw new Error('draft file must contain an unsigned payload object');
  }
  const draft = draftRaw as AttestationPayloadV1;
  const wallet = loadWalletFromEnvFile(required(flags, 'env-file'));
  if (wallet.address !== undefined) {
    const derived = privateKeyToAccount(wallet.privateKey).address;
    if (getAddress(wallet.address) !== getAddress(derived)) {
      throw new Error('env file AGENT_ADDRESS does not match AGENT_PRIVATE_KEY');
    }
  }
  const signed = await signDraft(createVerifier(), {
    draft,
    privateKey: wallet.privateKey,
  });
  const json = `${JSON.stringify(signed, null, 2)}\n`;
  if (flags['out']) {
    writeFileSync(flags['out'], json, 'utf8');
    console.log(`wrote ${flags['out']}`);
  } else {
    process.stdout.write(json);
  }
}

async function cmdVerify(flags: Record<string, string>): Promise<void> {
  const attestation = readJsonFile(required(flags, 'file'));
  const publicResult = await verifyAttestation(createVerifier(), attestation);
  console.log(JSON.stringify(publicResult, null, 2));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (command) {
    case 'draft':
      await cmdDraft(flags);
      return;
    case 'sign':
      await cmdSign(flags);
      return;
    case 'verify':
      await cmdVerify(flags);
      return;
    default:
      throw new Error(
        'usage: fiador-signer <draft|sign|verify> [--flags] (see README)',
      );
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
