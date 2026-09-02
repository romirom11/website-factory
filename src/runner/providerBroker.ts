/**
 * Credential broker for OpenCode runs inside the runner sandbox.
 *
 * OpenCode has no client/server split for its tools: the process that holds a
 * provider key is the same process whose Bash tool a prompt-injected page can
 * drive. The Codex exact-root sandbox (bubblewrap) hides `/app/runner-work` —
 * and with it OpenCode's `auth.json` — from everything inside it, which is the
 * invariant every runtime honours: tools never read the credential of the
 * runtime that runs them.
 *
 * So the sandboxed OpenCode never sees a key. Its generated config points every
 * connected provider at this loopback server (`baseURL` = `/<provider id>`,
 * `apiKey` = a placeholder), and the broker — running in the executor process,
 * outside the sandbox — swaps the placeholder for the real key from auth.json
 * and forwards the request to the provider's API base through the same egress
 * proxy every other runner request crosses. Verified against OpenCode 1.18:
 * with an empty data dir and this config it sends `x-api-key: <placeholder>`
 * (Anthropic-style providers) or `Authorization: Bearer <placeholder>`
 * (OpenAI-compatible ones) to the broker; the header NAME is the SDK's choice,
 * so the broker rewrites whichever header carries the placeholder.
 *
 * What the sandbox can do through the broker: spend the subscription of a
 * provider the operator connected. What it cannot do: learn the key, reach a
 * provider that is not enabled in OPENCODE_PROVIDERS, or reach anything else —
 * the broker only forwards to catalog API bases.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { enabledOpenCodeProviders, type OpenCodeProvider } from './egressRegistry.js';
import { connectedOpenCodeProviderIds, readOpenCodeAuth } from './credentials.js';

export const OPENCODE_BROKER_PLACEHOLDER = 'factory-broker-placeholder';
export const DEFAULT_BROKER_PORT = 8792;

/** Loopback port the executor's broker listens on; fixed so probes can find it. */
export function providerBrokerPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RUNNER_PROVIDER_BROKER_PORT ?? DEFAULT_BROKER_PORT);
  if (!Number.isInteger(raw) || raw < 1024 || raw > 65_535) {
    throw new Error('RUNNER_PROVIDER_BROKER_PORT must be an unprivileged TCP port');
  }
  return raw;
}

/**
 * The `provider` block a sandboxed OpenCode run receives: every provider that
 * is both enabled (OPENCODE_PROVIDERS) and connected (auth.json) routed through
 * the broker. Read per run so a key connected in the UI applies immediately.
 */
export async function sandboxProviderConfig(): Promise<ReturnType<typeof brokerProviderConfig>> {
  const connected = new Set(await connectedOpenCodeProviderIds());
  return brokerProviderConfig(
    providerBrokerPort(),
    enabledOpenCodeProviders().filter((provider) => connected.has(provider.id)),
  );
}

/** Executor-side broker wired to the runner's auth store and egress proxy. */
export function startRunnerProviderBroker(): Promise<ProviderBroker> {
  return startProviderBroker({
    port: providerBrokerPort(),
    providers: () => enabledOpenCodeProviders(),
    auth: () => readOpenCodeAuth(),
    proxyUrl: process.env.HTTPS_PROXY || undefined,
  });
}

export interface BrokerAuthEntry { type: string; key?: string }

export interface ProviderBrokerOptions {
  port: number;
  /** Providers the broker may forward to (enabled ∩ catalog). */
  providers: () => OpenCodeProvider[];
  /** OpenCode auth.json contents, read per request so a UI connect applies live. */
  auth: () => Promise<Record<string, BrokerAuthEntry>>;
  /** `http://host:port` of the egress proxy; undefined = direct (tests). */
  proxyUrl?: string;
}

/** OpenCode config fragment routing each connected provider through the broker. */
export function brokerProviderConfig(
  port: number,
  providers: OpenCodeProvider[],
): Record<string, { options: { baseURL: string; apiKey: string } }> {
  return Object.fromEntries(providers.map((provider) => [provider.id, {
    options: {
      baseURL: `http://127.0.0.1:${port}/${provider.id}`,
      apiKey: OPENCODE_BROKER_PLACEHOLDER,
    },
  }]));
}

/** Header names that never cross the broker as-is. */
const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function rewriteHeaders(
  incoming: IncomingMessage['headers'],
  key: string,
  targetHost: string,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let substituted = false;
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (typeof value === 'string' && value.includes(OPENCODE_BROKER_PLACEHOLDER)) {
      out[name] = value.split(OPENCODE_BROKER_PLACEHOLDER).join(key);
      substituted = true;
    } else {
      out[name] = value;
    }
  }
  if (!substituted) throw new BrokerRequestError(401, 'request carries no broker placeholder credential');
  out.host = targetHost;
  return out;
}

export class BrokerRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'BrokerRequestError';
  }
}

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'factory_broker' } }));
}

/** CONNECT tunnel through the egress proxy; the TLS session is end-to-end. */
function tunnel(proxyUrl: string, host: string, port: number): Promise<Socket> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port || 80) });
    socket.setTimeout(15_000);
    let head = '';
    const fail = (error: Error): void => { socket.destroy(); reject(error); };
    socket.once('error', fail);
    socket.once('timeout', () => fail(new Error('egress proxy CONNECT timed out')));
    socket.once('connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      socket.setTimeout(0);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      if (!status || status[1] !== '200') {
        return fail(new Error(`egress proxy refused CONNECT ${host}:${port} (${status?.[1] ?? 'no status'})`));
      }
      const leftover = Buffer.from(head.slice(end + 4), 'latin1');
      if (leftover.length) socket.unshift(leftover);
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  provider: OpenCodeProvider,
  key: string,
  rest: string,
  proxyUrl: string | undefined,
): Promise<void> {
  const target = new URL(provider.api);
  const basePath = target.pathname.replace(/\/+$/, '');
  const targetPath = `${basePath}/${rest}`.replace(/\/{2,}/g, '/');
  const headers = rewriteHeaders(req.headers, key, target.host);
  const secure = target.protocol === 'https:';
  const port = Number(target.port || (secure ? 443 : 80));

  const socket = proxyUrl ? await tunnel(proxyUrl, target.hostname, port) : undefined;
  const upstream = (secure ? httpsRequest : httpRequest)({
    host: target.hostname,
    port,
    method: req.method,
    path: targetPath,
    headers,
    servername: secure ? target.hostname : undefined,
    ...(socket
      ? { createConnection: () => (secure ? tlsConnect({ socket, servername: target.hostname }) : socket) }
      : {}),
  });
  upstream.setTimeout(10 * 60_000, () => upstream.destroy(new Error('upstream idle timeout')));

  await new Promise<void>((resolve) => {
    upstream.once('response', (response) => {
      const responseHeaders = { ...response.headers };
      for (const name of HOP_BY_HOP) delete responseHeaders[name];
      res.writeHead(response.statusCode ?? 502, responseHeaders);
      response.pipe(res);
      response.once('end', resolve);
      response.once('error', () => { res.destroy(); resolve(); });
    });
    upstream.once('error', (error) => {
      if (!res.headersSent) reject(res, 502, `upstream request failed: ${error.message}`);
      else res.destroy();
      resolve();
    });
    req.pipe(upstream);
  });
}

export interface ProviderBroker {
  port: number;
  close(): Promise<void>;
}

export function startProviderBroker(options: ProviderBrokerOptions): Promise<ProviderBroker> {
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, providers: options.providers().map((p) => p.id) }));
        return;
      }
      const [, providerId, ...restParts] = url.pathname.split('/');
      const provider = options.providers().find((candidate) => candidate.id === providerId);
      if (!provider) throw new BrokerRequestError(404, `provider "${providerId ?? ''}" is not enabled in OPENCODE_PROVIDERS`);
      const entry = (await options.auth())[provider.id];
      if (!entry || entry.type !== 'api' || !entry.key) {
        throw new BrokerRequestError(401, `provider "${provider.id}" is not connected (no api key in OpenCode auth)`);
      }
      await forward(req, res, provider, entry.key, `${restParts.join('/')}${url.search}`, options.proxyUrl);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof BrokerRequestError) return reject(res, error.status, error.message);
      reject(res, 502, `broker failure: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  server.keepAliveTimeout = 65_000;
  return new Promise((resolve, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(options.port, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
