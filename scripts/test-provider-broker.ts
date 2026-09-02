/**
 * Offline proof for the OpenCode credential broker (src/runner/providerBroker.ts).
 *
 * A fake upstream on loopback plays the provider; the broker forwards to it
 * with the real key from a scratch auth.json. Nothing here touches a real
 * provider or a subscription.
 *
 *   pnpm test:provider-broker
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

let passed = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`✅ ${label}`);
}

const scratch = await mkdtemp(path.join(tmpdir(), 'factory-broker-'));
process.env.XDG_DATA_HOME = path.join(scratch, 'xdg');
await mkdir(path.join(process.env.XDG_DATA_HOME, 'opencode'), { recursive: true });
await writeFile(
  path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
  JSON.stringify({ 'test-provider': { type: 'api', key: 'real-provider-key' }, 'oauth-only': { type: 'oauth' } }),
);

const { startProviderBroker, brokerProviderConfig, OPENCODE_BROKER_PLACEHOLDER } = await import('../src/runner/providerBroker.js');
const { readOpenCodeAuth } = await import('../src/runner/credentials.js');

interface Seen { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }
const seen: Seen[] = [];
const upstream: Server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    if (req.url?.endsWith('/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 50);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
    res.end(JSON.stringify({ echoed: JSON.parse(body || '{}') }));
  });
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamPort = (upstream.address() as { port: number }).port;

const providers = [
  { id: 'test-provider', name: 'Test Provider', api: `http://127.0.0.1:${upstreamPort}/v1` },
  { id: 'oauth-only', name: 'OAuth Only', api: `http://127.0.0.1:${upstreamPort}/oauth` },
];
const broker = await startProviderBroker({
  port: 0,
  providers: () => providers,
  auth: () => readOpenCodeAuth(),
});
const base = `http://127.0.0.1:${broker.port}`;

try {
  await check('broker health lists the enabled providers', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json() as { providers: string[] }).providers, ['test-provider', 'oauth-only']);
  });

  await check('placeholder bearer is swapped for the real key and the path is joined onto the API base', async () => {
    const res = await fetch(`${base}/test-provider/chat/completions?stream=false`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OPENCODE_BROKER_PLACEHOLDER}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-upstream'), 'yes');
    assert.deepEqual(await res.json(), { echoed: { model: 'x', messages: [] } });
    const last = seen.at(-1)!;
    assert.equal(last.method, 'POST');
    assert.equal(last.url, '/v1/chat/completions?stream=false');
    assert.equal(last.headers.authorization, 'Bearer real-provider-key');
    assert.equal(last.headers.host, `127.0.0.1:${upstreamPort}`);
  });

  await check('x-api-key style placeholders are rewritten too (Anthropic-shaped providers)', async () => {
    const res = await fetch(`${base}/test-provider/messages`, {
      method: 'POST',
      headers: { 'x-api-key': OPENCODE_BROKER_PLACEHOLDER, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    assert.equal(seen.at(-1)!.headers['x-api-key'], 'real-provider-key');
    assert.equal(seen.at(-1)!.headers.authorization, undefined);
  });

  await check('streamed upstream bodies pass through', async () => {
    const res = await fetch(`${base}/test-provider/stream`, {
      headers: { authorization: `Bearer ${OPENCODE_BROKER_PLACEHOLDER}` },
    });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(await res.text(), 'data: one\n\ndata: two\n\n');
  });

  await check('a request without the placeholder never reaches the provider', async () => {
    const before = seen.length;
    const res = await fetch(`${base}/test-provider/chat/completions`, {
      method: 'POST', headers: { authorization: 'Bearer something-else' }, body: '{}',
    });
    assert.equal(res.status, 401);
    assert.equal(seen.length, before);
  });

  await check('unknown and non-api providers are refused before any upstream contact', async () => {
    const before = seen.length;
    const unknown = await fetch(`${base}/not-enabled/x`, { headers: { authorization: `Bearer ${OPENCODE_BROKER_PLACEHOLDER}` } });
    assert.equal(unknown.status, 404);
    const oauth = await fetch(`${base}/oauth-only/x`, { headers: { authorization: `Bearer ${OPENCODE_BROKER_PLACEHOLDER}` } });
    assert.equal(oauth.status, 401);
    assert.equal(seen.length, before);
  });

  await check('a key connected after start is used on the next request (read per request)', async () => {
    await writeFile(
      path.join(process.env.XDG_DATA_HOME!, 'opencode', 'auth.json'),
      JSON.stringify({ 'test-provider': { type: 'api', key: 'rotated-key' } }),
    );
    await fetch(`${base}/test-provider/ping`, { headers: { authorization: `Bearer ${OPENCODE_BROKER_PLACEHOLDER}` } });
    assert.equal(seen.at(-1)!.headers.authorization, 'Bearer rotated-key');
  });

  await check('the generated OpenCode config never contains a real key', () => {
    const fragment = brokerProviderConfig(broker.port, providers);
    assert.ok(!JSON.stringify(fragment).includes('real-provider-key'));
    assert.equal(fragment['test-provider']!.options.apiKey, OPENCODE_BROKER_PLACEHOLDER);
    assert.equal(fragment['test-provider']!.options.baseURL, `${base}/test-provider`);
  });

  console.log(`\n🔑 PROVIDER BROKER TESTS PASSED (${passed})`);
} finally {
  await broker.close();
  upstream.close();
}
