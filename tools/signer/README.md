# @fiador/signer — the Fiador reference signer CLI

Fiador — human-backed attestation for Discord bots. This is the operator-side tool from DESIGN §3.2 (point 5): it drafts an attestation payload for a Discord application, signs it with the operator's AgentBook-registered wallet, and verifies signed attestations through the verify core (`@fiador/verify`). It is the signer the `examples/publish-your-attestation/` walkthrough drives.

## Commands

```sh
# 1. Draft (unsigned payload; the humanId hash is derived live, see below)
fiador-signer draft \
  --application-id <discord application id> \
  --attestation-url https://your-host/attestations/your-bot.json \
  --env-file .env.program \
  [--bot-user-id <id>] [--operator-name "<name>"] [--days 90] \
  --out draft.json

# 2. Sign (EIP-191 over the core's canonical message)
fiador-signer sign --draft draft.json --env-file .env.program --out signed.json
#    (--out optional: without it, the signed JSON is printed to stdout, and nothing else)

# 3. Verify (live, through the core; prints the PUBLIC result only)
fiador-signer verify --file signed.json
```

`--env-file` points at a dotenv-style file carrying `AGENT_PRIVATE_KEY` (and `AGENT_ADDRESS`, which `draft` reads so the wallet address never needs to be typed either). `draft` also accepts `--wallet <address>` instead of `--env-file`.

## How the hash gets in (the HUMANID RULE)

The payload's `extra.human_id_hash` is never typed, pasted, or passed as a flag. At draft time (and again, fresh, at sign time) the CLI runs the verify core's `verifyAddress` on the wallet, takes the `humanHash` from the internal result, and writes only that hash into the payload. The full humanId is never printed, logged, or written to any file by this tool — and the tests scan every produced output for it.

Signing refuses, before producing any signature, when:

- the key in the env file does not control the draft's wallet;
- the wallet is not registered in AgentBook at signing time;
- the draft's `human_id_hash` no longer matches the live registration (re-run `draft`);
- the draft is already expired, or its disclosure is not the Discord profile's pinned `hash`.

## Field notes (DESIGN §3.1)

- `operatorDisplayName` is **optional and off by default** (§3.1.1): it is included only when `--operator-name` is explicitly passed, is self-asserted under the signature, and is capped at 64 characters.
- Expiry defaults to the 90-day hard cap; `--days` accepts 1..90 and refuses more.
- The nonce is 24 random bytes, base64url (192 bits, inside the profile's 16–64 char `[A-Za-z0-9_-]` shape).
- `discord_bot_user_id` defaults to the application ID; pass `--bot-user-id` when they differ.

## Publish walkthrough (stub)

1. Register your wallet in AgentBook (World's docs) — the wallet must show as registered before `draft` will run.
2. `draft` → review the payload JSON (check the application ID, URL, and expiry; the operator name only if you opted in).
3. `sign` → the signed attestation JSON.
4. Host the signed JSON at exactly the `attestation_url` in the payload, over HTTPS.
5. `verify --file signed.json` from anywhere to confirm the live check passes.
6. Open a registry PR adding your application ID and attestation URL (see `registry/CONTRIBUTING.md` when it lands; the full walkthrough will live at `examples/publish-your-attestation/` and link this README).

## Safety properties

- The private key is read from the env file only — never an argument (shell history), never printed, never logged, never written anywhere else. Error messages name variables, not values.
- No private key or raw humanId appears in any output; the test suite's hygiene scan asserts this over the draft, the signed attestation, and the verify output.
- Verification output is the core's public projection (`toPublicVerifyResult`): truncated address, hash only.
