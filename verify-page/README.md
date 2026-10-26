# Fiador browser verification page

`verify-page/` is the static source tree. The root `npm run build:web` command
copies it into the Vercel `public/` output directory. Its `/verify/` page is the browser
destination for the `/v/<short-id>` preview route. A browser opening that
route receives `/verify/?attestation=<public URL>` and starts a fresh check;
it never reuses the crawler's earlier verdict.

The page supports a Discord application ID through `registry.json`, a public
attestation URL, and pasted or dropped signed JSON. It uses the same
`@fiador/verify` source as the other surfaces and the shared Discord profile
checks from `link-preview/src/profile.ts`. The browser performs the live
AgentBook read using the selected World Chain RPC. The result is projected
through `toPublicVerifyResult` before rendering; the full human identifier
and wallet address never become display fields. A core-valid claim is shown
as **Claim unconfirmed** because there is no trusted assertion that the
signer controls the named Discord application.

## Build and checks

From the repository root:

```sh
npm ci
npm run typecheck --workspace @fiador/verify-page
npm run test --workspace @fiador/verify-page
npm run build --workspace @fiador/verify-page
```

The esbuild step bundles the shared TypeScript core and profile logic to
`verify-page/verify/app.js`. The committed bundle makes this tree deployable
as static files without a build step. The root web build also copies the
canonical registry from `registry/registry.json`. Rebuild it after any change to the
verify core or Discord profile checks. No secret or deployment token is
needed. The page's local banner and badge files are copies of the approved
repository assets so the static root has no third-party asset requests.

The registry, attestation host, and selected RPC endpoint receive requests
only when the visitor checks a claim or opens a prefilled `/v/` destination.
The default registry is this host's `/registry.json`. Browsers enforce CORS
for other hosts: operators should serve public attestation JSON with
`Access-Control-Allow-Origin: *`; visitors can paste the signed JSON when
the host does not allow a browser fetch. Pasted claims have no registry
check, and the page calls that limitation out in the result.

Local build and tests do not establish live Discord application control,
production hosting, real browser CORS behavior, or a current on-chain
result. Those remain separate live checks before publishing `/v/` links as
a complete verification flow. See [the web preview runbook](../docs/web-preview.md)
for the root deployment layout and preview checks.
