# Privacy and support route candidate — 27 October 2026

Fiador's public site has no `/privacy/` or `/support/` page yet. The
prepared Slack owner trial needs both links before its one-account
canary can start. This candidate adds practical disclosures and a
public issue route for general help, while keeping private proof and
account details out of that public channel.

The page copy was checked against the trial's code and runbook. It
says that the trial backend, Slack sign-in, and World proof have not
run live. It explains the signed state token in tab storage, the
signed but unencrypted Slack identity cookies, encrypted proof
custody, and the lack of automatic deletion for enrollment and
binding records. The app's general enrollment remains closed.

The local web build tests passed. A manual full-tree and history
secret scan found only existing synthetic test fixtures, dispositioned
in the verification log. Coordinator privacy review and publication
remain open. Publishing this site's full build would also ship the
existing `/verify/` and `/v/` routes; those release gates remain
separate.
