/**
 * The runner egress registry — one source for "which hosts may the sandbox
 * reach", shared by three consumers that used to carry their own copies:
 *
 *   infra/agent-egress/render.sh   → Squid ACL and CoreDNS zones (shell, at
 *                                    egress container start)
 *   this module                    → Claude tool-sandbox package allowlist,
 *                                    OpenCode provider catalog for the broker,
 *                                    the accounts UI and OPENCODE_PROVIDERS
 *                                    validation
 *
 * Files (infra/agent-egress/):
 *   runtime-domains.txt      `<group> <domain>` — inherent Claude/Codex and
 *                            package-registry domains
 *   opencode-providers.tsv   models.dev catalog rendered by
 *                            scripts/refresh-opencode-catalog.ts
 *
 * OPENCODE_PROVIDERS (compose env, comma-separated provider ids) selects which
 * catalog entries are enabled. It is a topology fact like the egress network
 * itself — the proxy and DNS containers read it at start and cannot consult the
 * settings database — so it deliberately lives in env, not in /settings.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface OpenCodeProvider {
  id: string;
  name: string;
  /** API base URL (https, no trailing slash) the broker forwards to. */
  api: string;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;

function registryDir(): string {
  return path.resolve(process.env.EGRESS_REGISTRY_DIR ?? 'infra/agent-egress');
}

function registryLines(file: string): string[] {
  return readFileSync(path.join(registryDir(), file), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

let catalogCache: Map<string, OpenCodeProvider> | undefined;

/** Every provider the factory can route; the catalog is immutable per process. */
export function openCodeCatalog(): Map<string, OpenCodeProvider> {
  if (catalogCache) return catalogCache;
  const catalog = new Map<string, OpenCodeProvider>();
  for (const line of registryLines('opencode-providers.tsv')) {
    const [id, name, api] = line.split('\t');
    if (!id || !name || !api || !PROVIDER_ID.test(id)) {
      throw new Error(`malformed opencode-providers.tsv line: ${line.slice(0, 120)}`);
    }
    catalog.set(id, { id, name, api: api.replace(/\/+$/, '') });
  }
  catalogCache = catalog;
  return catalog;
}

/** Raw OPENCODE_PROVIDERS ids, validated against the catalog. Throws on typos so
 * a misconfigured deployment fails at executor start, not at the first job. */
export function enabledOpenCodeProviderIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.OPENCODE_PROVIDERS ?? '';
  const ids = [...new Set(raw.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean))];
  const catalog = openCodeCatalog();
  for (const id of ids) {
    if (!PROVIDER_ID.test(id)) throw new Error(`OPENCODE_PROVIDERS entry "${id}" is not a provider id`);
    if (!catalog.has(id)) {
      throw new Error(`OPENCODE_PROVIDERS entry "${id}" is not in infra/agent-egress/opencode-providers.tsv`);
    }
  }
  return ids;
}

export function enabledOpenCodeProviders(env: NodeJS.ProcessEnv = process.env): OpenCodeProvider[] {
  const catalog = openCodeCatalog();
  return enabledOpenCodeProviderIds(env).map((id) => catalog.get(id)!);
}

/** Registrable domains of one group from runtime-domains.txt. */
export function runtimeDomains(group: 'provider' | 'package'): string[] {
  return registryLines('runtime-domains.txt')
    .map((line) => line.split(/\s+/))
    .filter(([g]) => g === group)
    .map(([, domain]) => domain!)
    .filter(Boolean);
}

/** Hostname of a provider API base — what the proxy/DNS allow for it. */
export function providerHost(provider: OpenCodeProvider): string {
  return new URL(provider.api).hostname;
}
