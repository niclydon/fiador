# Contributing to the Fiador registry

The registry is a discovery index, not a trust root. Trust comes
from the per-entry verification checks, never from being listed.
An entry says: at its URL there is a signed attestation for this
Discord application; verify it yourself.

## Adding an entry

- Open a PR against `registry/registry.json` adding one entry for
  your application ID, in the format defined by
  `registry/registry.schema.json` (entries sorted by application
  ID so diffs stay reviewable).
- The PR may be opened by the operator, or by anyone on the
  operator's behalf.
- The PR description must state the bot's name, for human
  reviewers.
- `attestation_url` must be HTTPS. The attestation it serves must
  verify at merge time: a registry PR whose attestation does not
  verify does not merge. Expiry after merge is normal lifecycle,
  handled by verifier sync, not by registry edits.
- Entries carry no human identifier in any form: no humanId, no
  hash of one. The registry points at attestations; it does not
  republish their contents.
- If it verifies and it is schema-valid, it is listed. There is
  no maintainer discretion about who "deserves" listing.

## Removing an entry

- Removal is by PR from anyone. It merges on a failed verify plus
  a 7-day issue notice, or immediately on the operator's own PR.
- The recommended removal path is a tombstone, not a deletion:
  mark the entry `"status": "revoked"` and leave it in place.
  Old `/v/` links then keep rendering an honest revoked card
  instead of a misleading not-found. Deletion remains possible
  where a tombstone is not appropriate.
- Registry removal stops discovery. It does not unbind guilds
  that already hold a local binding; their own sync loop removes
  the role when their checks fail.
