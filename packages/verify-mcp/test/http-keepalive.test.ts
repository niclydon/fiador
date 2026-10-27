import { connect as netConnect } from 'node:net';
import { expect, it } from 'vitest';
import { createVerifier } from '@fiador/verify';
import { createVerifyHttpServer } from '../src/http.js';

it('closes a keep-alive socket when the next request stalls in its headers', async () => {
  const server = createVerifyHttpServer(
    {
      verifier: createVerifier({
        reader: { source: 'live', lookupHuman: async () => null },
      }),
    },
    {
      host: '127.0.0.1',
      port: 0,
      headersTimeoutMs: 200,
      requestTimeoutMs: 2000,
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  try {
    const elapsed = await new Promise<number>((resolve, reject) => {
      let response = '';
      let secondStartedAt: number | undefined;
      const socket = netConnect(address.port, '127.0.0.1', () => {
        socket.write(
          `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: keep-alive\r\n\r\n`,
        );
      });
      const watchdog = setTimeout(() => {
        socket.destroy();
        reject(new Error('second request headers remained open past their deadline'));
      }, 1500);
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
        if (secondStartedAt !== undefined || !response.includes('{"ok":true}')) return;
        if (!response.toLowerCase().includes('connection: keep-alive')) {
          reject(new Error('first response did not keep the connection alive'));
          socket.destroy();
          return;
        }
        secondStartedAt = Date.now();
        socket.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nX-Partial:`);
      });
      socket.on('error', (error) => {
        if (secondStartedAt === undefined) reject(error);
      });
      socket.on('close', () => {
        clearTimeout(watchdog);
        if (secondStartedAt === undefined) {
          reject(new Error('socket closed before the second request'));
        } else {
          resolve(Date.now() - secondStartedAt);
        }
      });
    });
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1200);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}, 5000);
