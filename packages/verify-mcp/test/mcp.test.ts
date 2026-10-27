import { request as httpRequest } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createVerifier,
  type AgentBookReader,
  type EvmAddress,
  type FailureCode,
  type PublicVerifyResult,
  type SignedAttestation,
  type Verifier,
} from '@fiador/verify';
import { computeChecks } from '../src/checks.js';
import { ConfigError, depsFromEnv, parseBadgeBaseUrl } from '../src/config.js';
import {
  createVerifyHttpServer,
  isLoopbackHost,
  normalizeHost,
  parseHttpOptions,
} from '../src/http.js';
import { createVerifyMcpServer, type VerifyMcpDeps } from '../src/server.js';

const vectors = JSON.parse(
  readFileSync(
    new URL('../../verify-ts/fixtures/vectors.json', import.meta.url),
    'utf8',
  ),
) as {
  fixedNow: string;
  humans: { human1: string };
  wallets: { operatorA: string; strangerC: string };
  lookups: Array<{ address: string; humanId: string | null }>;
  attestations: { valid: SignedAttestation; longLifetime: SignedAttestation };
};
const NOW = new Date(vectors.fixedNow);
const A = vectors.wallets.operatorA;
const HUMAN_1 = vectors.humans.human1;

function makeDeps(extra: Partial<VerifyMcpDeps> = {}): VerifyMcpDeps {
  const entries = new Map(vectors.lookups.map((r) => [r.address.toLowerCase(), r.humanId]));
  const reader: AgentBookReader = {
    source: 'live',
    async lookupHuman(address: EvmAddress) {
      return entries.get(address.toLowerCase()) ?? null;
    },
  };
  return {
    verifier: createVerifier({ reader, now: () => NOW }),
    resolver: async (subject) =>
      subject.id === vectors.attestations.valid.payload.subject.id
        ? vectors.attestations.valid
        : null,
    ...extra,
  };
}

async function connectInMemory(deps: VerifyMcpDeps) {
  const server = createVerifyMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'verify-mcp-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('verify MCP tools', () => {
  it('lists three tools with a resolver configured, two without', async () => {
    const withResolver = await connectInMemory(makeDeps());
    const names = (await withResolver.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['badge_status', 'verify_address', 'verify_attestation']);
    const depsNoResolver = makeDeps();
    delete depsNoResolver.resolver;
    const without = await connectInMemory(depsNoResolver);
    const names2 = (await without.listTools()).tools.map((t) => t.name).sort();
    expect(names2).toEqual(['verify_address', 'verify_attestation']);
  });

  it('verify_address returns the public projection for each lookup state', async () => {
    const client = await connectInMemory(makeDeps());
    const ok = await client.callTool({
      name: 'verify_address',
      arguments: { address: A },
    });
    const okBody = ok.structuredContent as { status: string; humanHash: string };
    expect(okBody.status).toBe('verified');
    expect(okBody.humanHash).toMatch(/^[0-9a-f]{64}$/);

    const unreg = await client.callTool({
      name: 'verify_address',
      arguments: { address: vectors.wallets.strangerC },
    });
    expect((unreg.structuredContent as { status: string }).status).toBe('unregistered');
  });

  it('verify_attestation returns the per-check breakdown', async () => {
    const client = await connectInMemory(makeDeps());
    const att = vectors.attestations.valid;
    const res = await client.callTool({
      name: 'verify_attestation',
      arguments: { attestation: att, subject: att.payload.subject },
    });
    const body = res.structuredContent as {
      result: { status: string };
      checks: {
        signature: string;
        binding: { subject: string; wallet: string };
        expiry: string;
        registration: string;
      };
    };
    expect(body.result.status).toBe('verified');
    expect(body.checks).toEqual({
      signature: 'pass',
      binding: { subject: 'pass', wallet: 'not_checked' },
      expiry: 'valid',
      registration: 'registered',
    });

    const wrong = await client.callTool({
      name: 'verify_attestation',
      arguments: {
        attestation: att,
        subject: { type: 'discord_application', id: '999999999999999999' },
      },
    });
    const wrongBody = wrong.structuredContent as {
      result: { status: string };
      checks: { binding: { subject: string } };
    };
    expect(wrongBody.result.status).toBe('invalid');
    expect(wrongBody.checks.binding.subject).toBe('fail');
  });

  it('malformed attestation is a domain result, not a transport error', async () => {
    const client = await connectInMemory(makeDeps());
    const res = await client.callTool({
      name: 'verify_attestation',
      arguments: { attestation: 'this is not json' },
    });
    expect(res.isError).toBeFalsy();
    const body = res.structuredContent as {
      result: { status: string; failures: string[] };
      checks: { signature: string };
    };
    expect(body.result.status).toBe('invalid');
    expect(body.result.failures).toContain('malformed_attestation');
    expect(body.checks.signature).toBe('not_checked');
  });

  it('badge_status mirrors the badge JSON shape, URLs only when configured', async () => {
    const withBase = await connectInMemory(
      makeDeps({ badgeBaseUrl: 'https://badges.example' }),
    );
    const res = await withBase.callTool({
      name: 'badge_status',
      arguments: {
        subjectType: 'discord_application',
        subjectId: vectors.attestations.valid.payload.subject.id,
      },
    });
    const body = res.structuredContent as {
      status: string;
      badge?: { svg: { auto: string } };
    };
    expect(body.status).toBe('verified');
    expect(body.badge?.svg.auto).toBe(
      `https://badges.example/badge/discord_application/${vectors.attestations.valid.payload.subject.id}.svg?theme=auto`,
    );

    const noBase = await connectInMemory(makeDeps());
    const res2 = await noBase.callTool({
      name: 'badge_status',
      arguments: {
        subjectType: 'discord_application',
        subjectId: vectors.attestations.valid.payload.subject.id,
      },
    });
    expect('badge' in (res2.structuredContent as object)).toBe(false);

    const missing = await noBase.callTool({
      name: 'badge_status',
      arguments: { subjectType: 'discord_application', subjectId: '424242424242424242' },
    });
    const missingBody = missing.structuredContent as {
      status: string;
      failures: string[];
    };
    expect(missingBody.status).toBe('unknown');
    expect(missingBody.failures).toEqual(['attestation_not_found']);
  });

  it('input schemas are closed: a humanId field is rejected', async () => {
    const client = await connectInMemory(makeDeps());
    const res = await client.callTool({
      name: 'verify_address',
      arguments: { address: A, humanId: HUMAN_1 },
    });
    expect(res.isError).toBe(true);
  });

  it('advertises the same tool inputs and rejects invalid arguments', async () => {
    const client = await connectInMemory(makeDeps());
    const tools = (await client.listTools()).tools;
    const schemas = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));

    expect(schemas.verify_address).toMatchObject({
      type: 'object',
      required: ['address'],
      additionalProperties: false,
      properties: { address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } },
    });
    expect(schemas.verify_attestation).toMatchObject({
      type: 'object',
      required: ['attestation'],
      additionalProperties: false,
      properties: {
        attestation: { anyOf: [{ type: 'object' }, { type: 'string' }] },
        subject: {
          required: ['type', 'id'],
          additionalProperties: false,
          properties: {
            type: { maxLength: 128 },
            id: { maxLength: 256 },
          },
        },
        wallet: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
      },
    });
    expect(schemas.badge_status).toMatchObject({
      type: 'object',
      required: ['subjectType', 'subjectId'],
      additionalProperties: false,
      properties: {
        subjectType: { minLength: 1, maxLength: 128 },
        subjectId: { minLength: 1, maxLength: 256 },
      },
    });

    const invalidCalls = [
      { name: 'verify_address', arguments: { address: '0x123' } },
      {
        name: 'verify_attestation',
        arguments: { attestation: '{}', subject: { type: 'discord_application', id: '1', extra: true } },
      },
      { name: 'badge_status', arguments: { subjectType: 'x'.repeat(129), subjectId: '1' } },
    ];
    for (const call of invalidCalls) {
      expect((await client.callTool(call)).isError).toBe(true);
    }
  });

  it('no tool output contains the raw humanId, a humanId key, or a full address', async () => {
    const client = await connectInMemory(makeDeps({ badgeBaseUrl: 'https://badges.example' }));
    const calls: Array<Record<string, unknown>> = [
      { name: 'verify_address', arguments: { address: A } },
      { name: 'verify_attestation', arguments: { attestation: vectors.attestations.valid } },
      {
        name: 'badge_status',
        arguments: {
          subjectType: 'discord_application',
          subjectId: vectors.attestations.valid.payload.subject.id,
        },
      },
    ];
    for (const call of calls) {
      const res = await client.callTool(call as { name: string; arguments: Record<string, unknown> });
      const serialised = JSON.stringify(res);
      expect(serialised).not.toContain(HUMAN_1);
      expect(serialised).not.toContain('"humanId"');
      expect(serialised).not.toContain(A);
    }
  });
});

async function startHttp(deps: VerifyMcpDeps) {
  // The REAL wiring (src/http.ts, the same factory main.ts serves):
  // routing, body handling, DNS-rebinding protection, error paths.
  const server = createVerifyHttpServer(deps, { host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

describe('transport parity (real HTTP wiring)', () => {
  it('streamable HTTP returns the same verify_address result as in-memory', async () => {
    const deps = makeDeps();
    const viaMemory = await connectInMemory(deps);
    const memoryResult = await viaMemory.callTool({
      name: 'verify_address',
      arguments: { address: A },
    });

    const { server, base } = await startHttp(deps);
    try {
      const httpClient = new Client({ name: 'verify-mcp-http-test', version: '0.0.0' });
      await httpClient.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`)),
      );
      const httpResult = await httpClient.callTool({
        name: 'verify_address',
        arguments: { address: A },
      });
      // Parity is over the semantic result; rpcLatencyMs is measured
      // per call and is the one field allowed to differ.
      const stripLatency = (value: unknown) => {
        const clone = JSON.parse(JSON.stringify(value)) as {
          evidence: Record<string, unknown>;
        };
        const latency = clone.evidence.rpcLatencyMs;
        expect(typeof latency).toBe('number');
        delete clone.evidence.rpcLatencyMs;
        return clone;
      };
      expect(stripLatency(httpResult.structuredContent)).toEqual(
        stripLatency(memoryResult.structuredContent),
      );
    } finally {
      server.close();
    }
  });
});

describe('7.5 regressions: HTTP wiring (B4/m7/M15)', () => {
  it('routes on pathname: /health is GET-only, unknown paths 404, query strings do not break routes', async () => {
    const { server, base } = await startHttp(makeDeps());
    try {
      const health = await fetch(`${base}/health?probe=1`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      const healthPost = await fetch(`${base}/health`, { method: 'POST', body: '{}' });
      // Fix pass 2 (m7): a wrong method on a known route is a 405
      // in the SDK's JSON-RPC error shape, not a 404.
      expect(healthPost.status).toBe(405);
      expect(healthPost.headers.get('allow')).toBe('GET');
      const nope = await fetch(`${base}/nope`);
      expect(nope.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('malformed JSON gets the SDK JSON-RPC error shape, not an HTML 500', async () => {
    const { server, base } = await startHttp(makeDeps());
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: '{not json',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: number } };
      expect(body.error?.code).toBe(-32700);
    } finally {
      server.close();
    }
  });

  it('a declared body over the cap is refused 413 in the SDK error shape (B4)', async () => {
    const { server, base } = await startHttp(makeDeps());
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }),
      });
      expect(res.status).toBe(413);
      // The rejection comes from the transport's own cap (fix pass
      // 2, B4): the SDK's JSON-RPC shape, not a hand-rolled body.
      const body = (await res.json()) as {
        jsonrpc?: string;
        error?: { code?: number; message?: string };
      };
      expect(body.jsonrpc).toBe('2.0');
      expect(body.error?.code).toBe(-32000);
      expect(body.error?.message).toContain('Payload Too Large');
    } finally {
      server.close();
    }
  });

  it('a chunked body over the cap is refused 413 before SDK JSON parsing', async () => {
    const { server, base } = await startHttp(makeDeps());
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(`${base}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'transfer-encoding': 'chunked',
          },
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.write('{"pad":"');
        for (let index = 0; index < 17; index += 1) {
          req.write('x'.repeat(64 * 1024));
        }
        req.end('"}');
      });
      expect(status).toBe(413);
    } finally {
      server.close();
    }
  });

  it('DNS-rebinding protection rejects a foreign Host header on loopback binds', async () => {
    const { server, base } = await startHttp(makeDeps());
    try {
      const url = new URL(`${base}/mcp`);
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              host: 'evil.example',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end(
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        );
      });
      expect(status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('7.5 regressions: verify_attestation inputs (M10/M11/M5/M6)', () => {
  it('duplicate JSON keys in a string document -> malformed domain result (M10)', async () => {
    const client = await connectInMemory(makeDeps());
    const valid = JSON.stringify(vectors.attestations.valid);
    // A second, identical top-level "payload" key: last-wins JSON.parse
    // would verify this happily; the strict parser must not.
    const dup = valid.replace(
      ',"signature"',
      `,"payload":${JSON.stringify(vectors.attestations.valid.payload)},"signature"`,
    );
    expect(dup).not.toBe(valid);
    const res = await client.callTool({
      name: 'verify_attestation',
      arguments: { attestation: dup },
    });
    expect(res.isError).toBeFalsy();
    const body = res.structuredContent as {
      result: { status: string; failures: string[] };
    };
    expect(body.result.status).toBe('invalid');
    expect(body.result.failures).toContain('malformed_attestation');
  });

  it('oversize document -> spec domain result, not a tool error (M11)', async () => {
    const client = await connectInMemory(makeDeps());
    const big = `{"pad":"${'x'.repeat(70 * 1024)}"}`;
    const res = await client.callTool({
      name: 'verify_attestation',
      arguments: { attestation: big },
    });
    expect(res.isError).toBeFalsy();
    const body = res.structuredContent as {
      result: { status: string; failures: string[] };
      checks: {
        signature: string;
        binding: { subject: string; wallet: string };
        expiry: string;
        registration: string;
      };
    };
    expect(body.result.status).toBe('invalid');
    expect(body.result.failures).toEqual(['malformed_attestation']);
    expect(body.checks).toEqual({
      signature: 'not_checked',
      binding: { subject: 'not_checked', wallet: 'not_checked' },
      expiry: 'not_checked',
      registration: 'not_checked',
    });
  });

  it('on an unknown result, checks report the stages that actually ran (M5)', async () => {
    const throwing: AgentBookReader = {
      source: 'live',
      async lookupHuman() {
        throw new Error('RPC endpoint unreachable');
      },
    };
    const deps = makeDeps({
      verifier: createVerifier({ reader: throwing, now: () => NOW }),
    });
    const client = await connectInMemory(deps);
    const att = vectors.attestations.valid;
    const res = await client.callTool({
      name: 'verify_attestation',
      arguments: { attestation: att, subject: att.payload.subject },
    });
    const body = res.structuredContent as {
      result: { status: string };
      checks: {
        signature: string;
        binding: { subject: string };
        expiry: string;
        registration: string;
      };
    };
    expect(body.result.status).toBe('unknown');
    // Fix pass 2 (re-review M5, restoring SPEC 11.2 exactly): the
    // registration lookup RAN and failed — the local eip191
    // signature was evaluated and passed before it, and the dates
    // were evaluated too. The result's rpcLatencyMs (recorded only
    // by the registration lookup) is what proves the stage.
    expect(body.checks.signature).toBe('pass');
    expect(body.checks.expiry).toBe('valid');
    expect(body.checks.registration).toBe('unknown');
    // Binding DID run and pass before the network stage; it may say so.
    expect(body.checks.binding.subject).toBe('pass');
  });

  it('date failures cannot prove signature success when a lookup failed ambiguously', async () => {
    const publicResult = await makeDeps().verifier.verifyAttestation(
      vectors.attestations.valid,
    );
    const cases: Array<{ status: 'expired' | 'invalid'; failures: FailureCode[] }> = [
      { status: 'expired', failures: ['expired', 'lookup_failed'] },
      { status: 'invalid', failures: ['not_yet_valid', 'lookup_timeout'] },
      { status: 'invalid', failures: ['attestation_lifetime_invalid', 'lookup_failed'] },
      { status: 'invalid', failures: ['subject_mismatch', 'expired', 'lookup_failed'] },
    ];
    for (const { status, failures } of cases) {
      const checks = computeChecks({
        status,
        addressTruncated: publicResult.addressTruncated,
        humanHash: null,
        failures,
        evidence: publicResult.evidence,
      }, { subject: true, wallet: false });
      expect(checks.signature).toBe('not_checked');
      expect(checks.registration).toBe('not_checked');
    }
  });

  it('a lifetime failure reports signature/binding honestly (M6)', async () => {
    const client = await connectInMemory(makeDeps());
    const att = vectors.attestations.longLifetime;
    const res = await client.callTool({
      name: 'verify_attestation',
      arguments: { attestation: att, subject: att.payload.subject },
    });
    const body = res.structuredContent as {
      result: { status: string; failures: string[] };
      checks: {
        signature: string;
        binding: { subject: string };
        expiry: string;
        registration: string;
      };
    };
    expect(body.result.status).toBe('invalid');
    expect(body.result.failures).toContain('attestation_lifetime_invalid');
    expect(body.checks.signature).toBe('pass');
    expect(body.checks.binding.subject).toBe('pass');
    expect(body.checks.expiry).toBe('lifetime_invalid');
    expect(body.checks.registration).toBe('not_checked');
  });

  it('a throwing verifier surfaces a fixed internal error, never its message (M12)', async () => {
    const deps = makeDeps({
      verifier: {
        async verifyAddress(): Promise<never> {
          throw new Error('boom: secret detail');
        },
      } as unknown as Verifier,
    });
    const client = await connectInMemory(deps);
    const res = await client.callTool({
      name: 'verify_address',
      arguments: { address: A },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).not.toContain('secret detail');
  });

  it("badge_status rejects '..' subject segments when a badge base is set (m6)", async () => {
    const client = await connectInMemory(
      makeDeps({ badgeBaseUrl: 'https://badges.example' }),
    );
    const res = await client.callTool({
      name: 'badge_status',
      arguments: { subjectType: 'discord_application', subjectId: '..' },
    });
    expect(res.isError).toBe(true);
  });
});

describe('7.5 regressions: configuration (M14/M16/m5/m6)', () => {
  it('VERIFY_TIMEOUT_MS is strict: invalid explicit values are startup errors (M16)', () => {
    for (const bad of ['abc', '50', '60001', '5.5', '-100']) {
      expect(() => depsFromEnv({ VERIFY_TIMEOUT_MS: bad })).toThrow(ConfigError);
      expect(() => depsFromEnv({ VERIFY_TIMEOUT_MS: bad })).toThrow(/VERIFY_TIMEOUT_MS/);
    }
    expect(() => depsFromEnv({ VERIFY_TIMEOUT_MS: '250' })).not.toThrow();
  });

  it('ports are strict: 0, non-numeric, and out-of-range are startup errors (M16)', () => {
    expect(() => parseHttpOptions({ VERIFY_MCP_PORT: '0' }, [])).toThrow(/VERIFY_MCP_PORT/);
    expect(() => parseHttpOptions({ VERIFY_MCP_PORT: 'abc' }, [])).toThrow(/VERIFY_MCP_PORT/);
    expect(() => parseHttpOptions({}, ['--port=70000'])).toThrow(/--port/);
    expect(parseHttpOptions({}, [])).toEqual({ host: '127.0.0.1', port: 8787 });
  });

  it('a malformed registry file fails sanitised: names the file class, never content (M14/m5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-mcp-config-'));
    const secretish = 'do-not-leak-this-content';
    const path = join(dir, 'registry.json');
    writeFileSync(path, `{"a:b": ${secretish}`);
    try {
      depsFromEnv({ VERIFY_REGISTRY_FILE: path });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/VERIFY_REGISTRY_FILE/);
      expect((err as Error).message).not.toContain(secretish);
    }
  });

  it('registry shape errors and duplicate keys are startup errors (m5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-mcp-config-'));
    const dupPath = join(dir, 'dup.json');
    writeFileSync(dupPath, '{"discord_application:1":{},"discord_application:1":{}}');
    expect(() => depsFromEnv({ VERIFY_REGISTRY_FILE: dupPath })).toThrow(/duplicate keys/);
    const arrPath = join(dir, 'arr.json');
    writeFileSync(arrPath, '[]');
    expect(() => depsFromEnv({ VERIFY_REGISTRY_FILE: arrPath })).toThrow(/JSON object/);
    const badValuePath = join(dir, 'badvalue.json');
    writeFileSync(badValuePath, '{"discord_application:1":42}');
    expect(() => depsFromEnv({ VERIFY_REGISTRY_FILE: badValuePath })).toThrow(/attestation objects/);
    // A well-formed file loads and its resolver answers.
    const okPath = join(dir, 'ok.json');
    const subject = vectors.attestations.valid.payload.subject;
    writeFileSync(
      okPath,
      JSON.stringify({ [`${subject.type}:${subject.id}`]: vectors.attestations.valid }),
    );
    const deps = depsFromEnv({ VERIFY_REGISTRY_FILE: okPath });
    expect(deps.resolver).toBeTypeOf('function');
  });

  it('a bad contract address fails with a fixed message naming no value (M14)', () => {
    const marker = 'not-an-address-marker';
    try {
      depsFromEnv({ VERIFY_CONTRACT_ADDRESS: marker });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).not.toContain(marker);
    }
  });

  it('the badge base URL is validated and its query/fragment stripped (m6)', () => {
    expect(() => depsFromEnv({ VERIFY_BADGE_BASE_URL: 'ftp://badges.example' })).toThrow(
      /VERIFY_BADGE_BASE_URL/,
    );
    const deps = depsFromEnv({
      VERIFY_BADGE_BASE_URL: 'https://badges.example/root/?token=abc#frag',
    });
    expect(deps.badgeBaseUrl).toBe('https://badges.example/root');
  });
});

// ---------------------------------------------------------------------------
// 7.5 re-review regressions (fix pass 2): B4 (transport body cap +
// total arrival deadline), M15 (host normalisation), M16 (port
// spelling + factory validation), m7 (method gating + the real
// main() entry path), M10 (object-form round-trip), M5 (checks
// probes), m5/m6 (registry shape, badge URL credentials).
// ---------------------------------------------------------------------------

function rawHttp(
  base: string,
  options: { method: string; path: string; host?: string; chunks?: string[] },
): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: options.path,
        method: options.method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(options.host ? { host: options.host } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    for (const chunk of options.chunks ?? []) req.write(chunk);
    req.end();
  });
}

describe('fix pass 2: body cap and arrival deadline (B4)', () => {
  it('a chunked body over the cap is refused 413 in the SDK shape', async () => {
    const { server, base } = await startHttp(makeDeps());
    try {
      // No Content-Length: node sends Transfer-Encoding: chunked.
      // The transport counts bytes as it reads them, so the cap
      // applies exactly as it does to a declared body.
      const res = await rawHttp(base, {
        method: 'POST',
        path: '/mcp',
        chunks: ['{"pad":"', 'x'.repeat(700 * 1024), 'y'.repeat(700 * 1024), '"}'],
      });
      expect(res.status).toBe(413);
      const body = JSON.parse(res.body) as {
        jsonrpc?: string;
        error?: { code?: number; message?: string };
      };
      expect(body.jsonrpc).toBe('2.0');
      expect(body.error?.code).toBe(-32000);
      expect(body.error?.message).toContain('Payload Too Large');
    } finally {
      server.close();
    }
  });

  it('a slow-drip body is terminated at the total request deadline, not per-gap', async () => {
    const server = createVerifyHttpServer(makeDeps(), {
      host: '127.0.0.1',
      port: 0,
      headersTimeoutMs: 300,
      requestTimeoutMs: 900,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const elapsed = await new Promise<number>((resolve, reject) => {
        const started = Date.now();
        const socket = netConnect(address.port, '127.0.0.1', () => {
          socket.write(
            'POST /mcp HTTP/1.1\r\n' +
              `host: 127.0.0.1:${address.port}\r\n` +
              'content-type: application/json\r\n' +
              'accept: application/json, text/event-stream\r\n' +
              'content-length: 100\r\n\r\n',
          );
        });
        const drip = setInterval(() => socket.write('x'), 250);
        const done = () => {
          clearInterval(drip);
          resolve(Date.now() - started);
        };
        socket.on('close', done);
        socket.on('error', done);
        setTimeout(() => {
          clearInterval(drip);
          socket.destroy();
          reject(new Error('server never terminated the drip'));
        }, 5000);
      });
      // requestTimeout (900ms) is the TOTAL arrival deadline: with
      // a 250ms drip the per-gap timer would never fire at all.
      expect(elapsed).toBeGreaterThanOrEqual(700);
      expect(elapsed).toBeLessThan(2500);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('a header drip is terminated at the headers deadline', async () => {
    const server = createVerifyHttpServer(makeDeps(), {
      host: '127.0.0.1',
      port: 0,
      headersTimeoutMs: 300,
      requestTimeoutMs: 5000,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const elapsed = await new Promise<number>((resolve, reject) => {
        const started = Date.now();
        const socket = netConnect(address.port, '127.0.0.1', () => {
          socket.write('POST /mcp HTTP/1.1\r\n');
        });
        const drip = setInterval(() => socket.write('x-probe: 1\r\n'), 100);
        const done = () => {
          clearInterval(drip);
          resolve(Date.now() - started);
        };
        socket.on('close', done);
        socket.on('error', done);
        setTimeout(() => {
          clearInterval(drip);
          socket.destroy();
          reject(new Error('server never terminated the header drip'));
        }, 4000);
      });
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 10000);
});

describe('fix pass 2: host normalisation (M15)', () => {
  it('isLoopbackHost recognises the spellings operators actually type', () => {
    for (const host of [
      '127.0.0.1',
      '127.1',
      '127.0.1',
      '127.255.0.9',
      '2130706433',
      '0x7f.1',
      'localhost',
      'LOCALHOST',
      'localhost.',
      '::1',
      '[::1]',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of [
      '128.0.0.1',
      '126.255.255.255',
      '0.0.0.0',
      '::',
      '::ffff:8.8.8.8',
      'example.com',
      'localhost.example.com',
      '',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
    expect(normalizeHost('LOCALHOST')).toBe('localhost');
    expect(normalizeHost('127.1')).toBe('127.0.0.1');
    expect(normalizeHost('0:0:0:0:0:0:0:1')).toBe('0:0:0:0:0:0:0:1');
    expect(normalizeHost('example.com')).toBeNull();
  });

  it('VERIFY_MCP_HOST=127.1 still gets DNS-rebinding protection (foreign Host -> 403)', async () => {
    const server = createVerifyHttpServer(makeDeps(), { host: '127.1', port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const foreign = await rawHttp(base, {
        method: 'POST',
        path: '/mcp',
        host: 'evil.example',
        chunks: [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })],
      });
      expect(foreign.status).toBe(403);
      const own = await rawHttp(base, {
        method: 'POST',
        path: '/mcp',
        host: `127.1:${address.port}`,
        chunks: [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })],
      });
      expect(own.status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe('fix pass 2: methods, port spelling, factory validation (m7/M16)', () => {
  it('wrong methods on /mcp and /health return 405 in the SDK shape; DELETE /mcp no longer 200s', async () => {
    const { server, base } = await startHttp(makeDeps());
    try {
      for (const method of ['PUT', 'DELETE', 'GET']) {
        const res = await fetch(`${base}/mcp`, { method });
        expect(res.status, method).toBe(405);
        expect(res.headers.get('allow')).toBe('POST');
        const body = (await res.json()) as {
          jsonrpc?: string;
          error?: { code?: number; message?: string };
          id?: unknown;
        };
        expect(body.jsonrpc).toBe('2.0');
        expect(body.error?.code).toBe(-32000);
        expect(body.error?.message).toBe('Method not allowed.');
        expect(body.id).toBeNull();
      }
      const healthDelete = await fetch(`${base}/health`, { method: 'DELETE' });
      expect(healthDelete.status).toBe(405);
      expect(healthDelete.headers.get('allow')).toBe('GET');
    } finally {
      server.close();
    }
  });

  it("'--port 9999' space form parses like the = form; a missing value errors (M16)", () => {
    expect(parseHttpOptions({}, ['--port', '9999'])).toEqual({
      host: '127.0.0.1',
      port: 9999,
    });
    expect(parseHttpOptions({}, ['--port=9999'])).toEqual({
      host: '127.0.0.1',
      port: 9999,
    });
    expect(() => parseHttpOptions({}, ['--port'])).toThrow(/--port/);
    expect(() => parseHttpOptions({}, ['--port', 'abc'])).toThrow(/--port/);
  });

  it('the HTTP factory validates its own options (M16)', () => {
    expect(() => createVerifyHttpServer(makeDeps(), { host: '', port: 0 })).toThrow(
      ConfigError,
    );
    expect(() => createVerifyHttpServer(makeDeps(), { host: '127.0.0.1', port: 70000 })).toThrow(
      ConfigError,
    );
    expect(() =>
      createVerifyHttpServer(makeDeps(), {
        host: '127.0.0.1',
        port: 0,
        headersTimeoutMs: 5000,
        requestTimeoutMs: 1000,
      }),
    ).toThrow(ConfigError);
    // Port 0 is legitimate at the factory (ephemeral test binds);
    // parseHttpOptions remains the deployment gate that rejects it.
    expect(() =>
      createVerifyHttpServer(makeDeps(), { host: '127.0.0.1', port: 0 }),
    ).not.toThrow();
  });
});

describe('fix pass 2: checks mapping probes (M5)', () => {
  const pub = (partial: Partial<PublicVerifyResult>): PublicVerifyResult =>
    ({
      status: 'unknown',
      address: A,
      addressTruncated: '0x1234…5678',
      humanHash: null,
      failures: [],
      evidence: {
        checkedAt: '2026-01-15T12:00:00.000Z',
        source: 'live',
        agentBook: {
          network: 'eip155:480',
          contract: '0xA23aB2712eA7BBa896930544C7d6636a96b944dA',
        },
      },
      ...partial,
    }) as PublicVerifyResult;
  const noAssert = { subject: false, wallet: false };

  it('expired + [expired, lookup_failed] (eip1271, signature never ran): no fabricated pass', () => {
    const checks = computeChecks(
      pub({ status: 'expired', failures: ['expired', 'lookup_failed'] }),
      noAssert,
    );
    expect(checks.signature).toBe('not_checked');
    expect(checks.expiry).toBe('expired');
    expect(checks.registration).toBe('not_checked');
  });

  it('invalid + [attestation_lifetime_invalid, lookup_failed]: signature not_checked', () => {
    const checks = computeChecks(
      pub({
        status: 'invalid',
        failures: ['attestation_lifetime_invalid', 'lookup_failed'],
      }),
      noAssert,
    );
    expect(checks.signature).toBe('not_checked');
    expect(checks.expiry).toBe('lifetime_invalid');
    expect(checks.registration).toBe('not_checked');
  });

  it('invalid + [not_yet_valid, lookup_timeout]: signature not_checked', () => {
    const checks = computeChecks(
      pub({ status: 'invalid', failures: ['not_yet_valid', 'lookup_timeout'] }),
      noAssert,
    );
    expect(checks.signature).toBe('not_checked');
    expect(checks.expiry).toBe('not_yet_valid');
    expect(checks.registration).toBe('not_checked');
  });

  it('an eip191 attestation whose registration lookup failed: registration unknown, ran stages reported', () => {
    const checks = computeChecks(
      pub({
        status: 'unknown',
        failures: ['lookup_failed'],
        evidence: {
          checkedAt: '2026-01-15T12:00:00.000Z',
          source: 'live',
          agentBook: {
            network: 'eip155:480',
            contract: '0xA23aB2712eA7BBa896930544C7d6636a96b944dA',
          },
          rpcLatencyMs: 12,
        },
      }),
      noAssert,
    );
    expect(checks.registration).toBe('unknown');
    expect(checks.signature).toBe('pass');
    expect(checks.expiry).toBe('valid');
  });
});

describe('fix pass 2: object-form attestation round-trip (M10)', () => {
  it('an object-form document with a payload-level __proto__ key is malformed, like the string form', async () => {
    const client = await connectInMemory(makeDeps());
    const payloadJson = JSON.stringify(vectors.attestations.valid.payload);
    const doctoredPayload = JSON.parse(
      `{"__proto__":{"polluted":true},${payloadJson.slice(1)}`,
    ) as Record<string, unknown>;
    const att = { ...vectors.attestations.valid, payload: doctoredPayload };
    const res = await client.callTool({
      name: 'verify_attestation',
      arguments: { attestation: att },
    });
    expect(res.isError).toBeFalsy();
    const body = res.structuredContent as {
      result: { status: string; failures: string[] };
    };
    expect(body.result.status).toBe('invalid');
    expect(body.result.failures).toContain('malformed_attestation');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a string-form document with a top-level __proto__ key is malformed', async () => {
    const client = await connectInMemory(makeDeps());
    const valid = JSON.stringify(vectors.attestations.valid);
    const doctored = `{"__proto__":{"polluted":true},${valid.slice(1)}`;
    const res = await client.callTool({
      name: 'verify_attestation',
      arguments: { attestation: doctored },
    });
    expect(res.isError).toBeFalsy();
    const body = res.structuredContent as {
      result: { status: string; failures: string[] };
    };
    expect(body.result.status).toBe('invalid');
    expect(body.result.failures).toContain('malformed_attestation');
  });

  it('an ordinary object-form document still verifies through the round-trip', async () => {
    const client = await connectInMemory(makeDeps());
    const res = await client.callTool({
      name: 'verify_attestation',
      arguments: { attestation: vectors.attestations.valid },
    });
    const body = res.structuredContent as { result: { status: string } };
    expect(body.result.status).toBe('verified');
  });
});

describe('fix pass 2: registry shape and badge URL credentials (m5/m6)', () => {
  it('registry legs with surrounding whitespace are rejected at startup (m5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-mcp-config-'));
    const subject = vectors.attestations.valid.payload.subject;
    const paddedType = join(dir, 'padded-type.json');
    writeFileSync(
      paddedType,
      JSON.stringify({ [` ${subject.type}:${subject.id}`]: vectors.attestations.valid }),
    );
    expect(() => depsFromEnv({ VERIFY_REGISTRY_FILE: paddedType })).toThrow(
      /attestation objects/,
    );
    const paddedId = join(dir, 'padded-id.json');
    writeFileSync(
      paddedId,
      JSON.stringify({ [`${subject.type}: ${subject.id}`]: vectors.attestations.valid }),
    );
    expect(() => depsFromEnv({ VERIFY_REGISTRY_FILE: paddedId })).toThrow(
      /attestation objects/,
    );
  });

  it('registry values are shape-validated at startup: payload/signature/signatureType (m5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-mcp-config-'));
    const noType = join(dir, 'notype.json');
    writeFileSync(
      noType,
      JSON.stringify({
        'discord_application:1': { payload: {}, signature: '0x12' },
      }),
    );
    expect(() => depsFromEnv({ VERIFY_REGISTRY_FILE: noType })).toThrow(/attestation objects/);
    const noPayload = join(dir, 'nopayload.json');
    writeFileSync(
      noPayload,
      JSON.stringify({
        'discord_application:1': { signature: '0x12', signatureType: 'eip191' },
      }),
    );
    expect(() => depsFromEnv({ VERIFY_REGISTRY_FILE: noPayload })).toThrow(
      /attestation objects/,
    );
  });

  it('badge base URL userinfo is stripped, never republished (m6)', () => {
    expect(parseBadgeBaseUrl('https://user:pass@badges.example/root')).toBe(
      'https://badges.example/root',
    );
    expect(parseBadgeBaseUrl('https://user@badges.example')).toBe('https://badges.example');
  });
});

describe('fix pass 2: the real main() entry path (m7)', () => {
  const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));

  beforeAll(() => {
    // The spawned entry point imports @fiador/verify's dist too.
    execFileSync('npm', ['run', 'build', '--workspace', '@fiador/verify'], {
      cwd: join(PKG_DIR, '..', '..'),
      stdio: 'pipe',
    });
    execFileSync('npm', ['run', 'build'], { cwd: PKG_DIR, stdio: 'pipe' });
  }, 120_000);

  it('spawned main.js --http serves /health and tools/list on an ephemeral port', async () => {
    const probe = createNetServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const probeAddress = probe.address();
    if (probeAddress === null || typeof probeAddress === 'string') {
      throw new Error('no probe port');
    }
    const port = probeAddress.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.VERIFY_REGISTRY_FILE;
    delete env.VERIFY_BADGE_BASE_URL;
    env.VERIFY_MCP_HOST = '127.0.0.1';
    env.VERIFY_MCP_PORT = String(port);
    const child = spawn(process.execPath, ['dist/main.js', '--http'], {
      cwd: PKG_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      let healthy = false;
      for (let i = 0; i < 50 && !healthy; i += 1) {
        try {
          const res = await fetch(`${base}/health`);
          healthy = res.status === 200;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      expect(healthy).toBe(true);
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const jsonText = text.startsWith('{')
        ? text
        : text
            .split('\n')
            .find((line) => line.startsWith('data:'))
            ?.slice('data:'.length);
      const parsed = JSON.parse(jsonText ?? '{}') as {
        result?: { tools?: Array<{ name: string }> };
      };
      const names = (parsed.result?.tools ?? []).map((t) => t.name).sort();
      // No registry env in the child: badge_status is not listed.
      expect(names).toEqual(['verify_address', 'verify_attestation']);
    } finally {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
  }, 30_000);
});
