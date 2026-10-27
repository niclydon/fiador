import { request as httpRequest } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import {
  createVerifier,
  type AgentBookReader,
  type EvmAddress,
  type SignedAttestation,
  type Verifier,
} from '@fiador/verify';
import { ConfigError, depsFromEnv } from '../src/config.js';
import { createVerifyHttpServer, parseHttpOptions } from '../src/http.js';
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
      expect(healthPost.status).toBe(404);
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

  it('a declared body over the cap is refused 413 before being read', async () => {
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

  it('on an unknown result, checks do not fabricate stage outcomes (M5)', async () => {
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
    expect(body.checks.signature).toBe('not_checked');
    expect(body.checks.expiry).toBe('not_checked');
    expect(body.checks.registration).toBe('not_checked');
    // Binding DID run and pass before the network stage; it may say so.
    expect(body.checks.binding.subject).toBe('pass');
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
