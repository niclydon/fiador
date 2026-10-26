import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import {
  createVerifier,
  type AgentBookReader,
  type EvmAddress,
  type SignedAttestation,
} from '@fiador/verify';
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
  attestations: { valid: SignedAttestation };
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

describe('transport parity', () => {
  it('streamable HTTP returns the same verify_address result as in-memory', async () => {
    const deps = makeDeps();
    const viaMemory = await connectInMemory(deps);
    const memoryResult = await viaMemory.callTool({
      name: 'verify_address',
      arguments: { address: A },
    });

    const httpServer = createHttpServer(async (req, res) => {
      let body: unknown;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString('utf8');
      body = text.length > 0 ? JSON.parse(text) : undefined;
      // Stateless SDK pattern: fresh server + transport per request.
      const requestServer = createVerifyMcpServer(deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await requestServer.connect(transport);
      await transport.handleRequest(req, res, body);
      res.on('close', () => {
        void transport.close();
        void requestServer.close();
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const httpClient = new Client({ name: 'verify-mcp-http-test', version: '0.0.0' });
      await httpClient.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/`)),
      );
      const httpResult = await httpClient.callTool({
        name: 'verify_address',
        arguments: { address: A },
      });
      expect(httpResult.structuredContent).toEqual(memoryResult.structuredContent);
    } finally {
      httpServer.close();
    }
  });
});
