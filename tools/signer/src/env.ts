// Minimal env-file loading for the signer (DESIGN §3.2 point 5).
//
// The wallet key is read from an env file (the playground's discipline:
// key from a file, never an argument, never logged). This module parses
// KEY=VALUE lines only; it never prints values, and callers must treat
// the returned private key as opaque key material.

import { readFileSync } from 'node:fs';
import type { Hex } from 'viem';

export const WALLET_KEY_VAR = 'AGENT_PRIVATE_KEY';
export const WALLET_ADDRESS_VAR = 'AGENT_ADDRESS';

export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface WalletFromEnv {
  privateKey: Hex;
  /** The env file's AGENT_ADDRESS, when present (unvalidated here). */
  address?: string;
}

export function loadWalletFromEnvFile(path: string): WalletFromEnv {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`cannot read env file: ${path}`);
  }
  const env = parseEnvFile(contents);
  const key = env[WALLET_KEY_VAR];
  if (key === undefined || key === '') {
    throw new Error(`${WALLET_KEY_VAR} is not set in ${path}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${WALLET_KEY_VAR} in ${path} is not a 32-byte hex private key`);
  }
  return {
    privateKey: key as Hex,
    ...(env[WALLET_ADDRESS_VAR] ? { address: env[WALLET_ADDRESS_VAR] } : {}),
  };
}

/** Read AGENT_ADDRESS from an env file (draft flow: no key handling). */
export function loadAddressFromEnvFile(path: string): string {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`cannot read env file: ${path}`);
  }
  const env = parseEnvFile(contents);
  const address = env[WALLET_ADDRESS_VAR];
  if (!address) {
    throw new Error(`${WALLET_ADDRESS_VAR} is not set in ${path}`);
  }
  return address;
}
