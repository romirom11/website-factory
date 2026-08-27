/**
 * Calling the factory's internal API from the console.
 *
 * Some things the UI needs are owned by the FACTORY process, not by this one:
 * the build workspaces on disk, the demo server that knows how to re-root a Next
 * export's asset paths, the agent CLIs. Those are asked for over the internal
 * API rather than reached for directly, because the UI container does not see
 * the same filesystem and must not become a second owner of that state.
 *
 * Unlike a plain fetch wrapper this one preserves the ENDPOINT's own verdict: a
 * 409 "the build is not on disk any more" is a real answer with a real message
 * for Roman, not a transport failure to swallow.
 */

export interface FactoryResponse {
  /** True only when the factory answered AND reported success. */
  ok: boolean;
  /** Message to show Roman: the factory's own, or a transport explanation. */
  message: string;
  body: Record<string, unknown> | null;
  status: number;
}

function base(): string {
  return (process.env.FACTORY_API_URL ?? 'http://factory:8787').replace(/\/+$/, '');
}

function internalKey(): string {
  return process.env.INTERNAL_API_KEY ?? process.env.UI_SESSION_SECRET ?? process.env.UI_PASSWORD ?? '';
}

export async function factoryFetch(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<FactoryResponse> {
  const key = internalKey();
  if (!key) {
    return {
      ok: false,
      status: 0,
      body: null,
      message: 'INTERNAL_API_KEY / UI_SESSION_SECRET не заданий — фабрика не приймає внутрішні запити.',
    };
  }

  try {
    const res = await fetch(`${base()}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'x-internal-key': key,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    return {
      ok: res.ok && body?.ok !== false,
      status: res.status,
      body,
      message: String(body?.message ?? (res.ok ? '' : `Фабрика відповіла ${res.status}.`)),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      message: `Не достукались до фабрики (${base()}): ${String(err).slice(0, 140)}. Контейнер factory піднятий?`,
    };
  }
}
