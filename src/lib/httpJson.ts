/**
 * One JSON POST for the agent-runner hops (factory → gateway → executor).
 *
 * Why not `fetch`: Node's fetch is undici, and undici aborts a request whose
 * response HEADERS have not arrived within 300 s (`headersTimeout`), no
 * matter what `AbortSignal.timeout` says. An agent call holds the connection
 * open for as long as the model works — the design step alone runs ~13 min —
 * so every long step died at the five-minute mark with a bare «fetch failed»,
 * the worker parked it as RUNNER_UNAVAILABLE and queued another attempt while
 * the executor finished the first one into nothing (BEAUTIFY Laser,
 * 2026-09-04: twelve attempts, each a full Opus run). `node:http` has no such
 * limit; the only deadline here is the one the caller asks for.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface JsonPostResult {
  status: number;
  text: string;
}

export function postJson(
  url: string,
  options: { body: string; headers?: Record<string, string>; timeoutMs: number },
): Promise<JsonPostResult> {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const requestFn = secure ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requestFn({
      method: 'POST',
      host: target.hostname,
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(options.body),
        ...(options.headers ?? {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    // One deadline for the whole exchange, connect included. Node's own
    // `timeout` is an idle timer on the socket, which a slow but alive server
    // would never trip — a wall clock is what "give up after N minutes" means.
    const timer = setTimeout(() => {
      req.destroy(new Error(`request to ${target.host}${target.pathname} timed out after ${Math.round(options.timeoutMs / 1000)}s`));
    }, options.timeoutMs);
    req.on('error', (error) => { clearTimeout(timer); reject(error); });
    req.on('close', () => clearTimeout(timer));
    req.end(options.body);
  });
}
