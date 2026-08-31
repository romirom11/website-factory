/**
 * "Стан системи" panel data: is each dependency actually up, right now.
 *
 * Deliberately shallow probes (a TCP/HTTP touch, not a full handshake) so the
 * page renders in well under a second even when something is down. The deep,
 * credential-proving checks are the per-group "Перевірити" buttons.
 */
import { sql } from 'drizzle-orm';
import { db } from './db';
import { effectiveValue, loadHeartbeats, loadPendingJobs, type HeartbeatView, type PendingJobs } from './settings';

export interface StatusLine {
  id: string;
  label: string;
  ok: boolean;
  degraded?: boolean;
  detail: string;
}

async function probe(label: string, id: string, url: string, headers?: Record<string, string>): Promise<StatusLine> {
  try {
    const res = await fetch(url, { headers, cache: 'no-store', signal: AbortSignal.timeout(4000) });
    return { id, label, ok: res.ok, detail: res.ok ? `HTTP ${res.status}` : `HTTP ${res.status}` };
  } catch (err) {
    return { id, label, ok: false, detail: String(err).slice(0, 120) };
  }
}

async function probeRunner(url: string): Promise<StatusLine> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json().catch(() => null) as {
      ok?: boolean;
      executor?: boolean;
      active?: number;
    } | null;
    const ok = res.ok && data?.ok === true && data.executor === true;
    return {
      id: 'agent-runner',
      label: 'Agent runner',
      ok,
      degraded: !ok,
      detail: ok ? `executor ok · active ${data?.active ?? 0}` : `HTTP ${res.status} · executor unavailable`,
    };
  } catch (err) {
    return {
      id: 'agent-runner',
      label: 'Agent runner',
      ok: false,
      degraded: true,
      detail: String(err).slice(0, 120),
    };
  }
}

export interface EnrichmentStatus {
  waiting: number;
  blocked: number;
  recentBlocked: Array<{
    id: string;
    name: string;
    reason: string;
  }>;
}

async function loadEnrichmentStatus(): Promise<EnrichmentStatus> {
  const [summary, recent] = await Promise.all([
    db.execute(sql`
      select
        count(*) filter (
          where r.status = 'running'
            and (r.assets_status = 'pending' or r.audit_status = 'pending')
        )::int as waiting,
        count(*) filter (where r.status = 'blocked')::int as blocked
      from enrichment_runs r
    `),
    db.execute(sql`
      select r.business_id as id, b.name,
             coalesce(r.blocking_reason, 'reason unavailable') as reason
      from enrichment_runs r
      join businesses b on b.id = r.business_id
      where r.status = 'blocked'
      order by r.updated_at desc
      limit 5
    `),
  ]);
  const counts = (summary.rows as Array<{ waiting: number; blocked: number }>)[0];
  return {
    waiting: Number(counts?.waiting ?? 0),
    blocked: Number(counts?.blocked ?? 0),
    recentBlocked: (recent.rows as Array<{ id: string; name: string; reason: string }>).map((row) => ({
      id: row.id,
      name: row.name,
      reason: row.reason,
    })),
  };
}

export interface SystemStatus {
  services: StatusLine[];
  heartbeats: HeartbeatView[];
  jobs: PendingJobs | null;
  enrichment: EnrichmentStatus | null;
}

export async function loadSystemStatus(): Promise<SystemStatus> {
  const wahaUrl = await effectiveValue('WAHA_URL');
  const factoryBase = (process.env.FACTORY_API_URL ?? 'http://factory:8787').replace(/\/+$/, '');
  const s3 = (process.env.S3_ENDPOINT ?? 'http://minio:9000').replace(/\/+$/, '');
  const gosom = (process.env.GOSOM_URL ?? 'http://gosom:8080').replace(/\/+$/, '');
  const runner = (process.env.RUNNER_GATEWAY_URL ?? 'http://agent-runner-gateway:8790').replace(/\/+$/, '');

  const [dbLine, ...rest] = await Promise.all([
    (async (): Promise<StatusLine> => {
      try {
        await db.execute(sql`select 1`);
        return { id: 'db', label: 'Postgres', ok: true, detail: 'відповідає' };
      } catch (err) {
        return { id: 'db', label: 'Postgres', ok: false, detail: String(err).slice(0, 120) };
      }
    })(),
    probe('MinIO', 'minio', `${s3}/minio/health/live`),
    probe('gosom', 'gosom', `${gosom}/api/v1/jobs`),
    probe('Factory API', 'factory', `${factoryBase}/health`),
    probeRunner(runner),
    wahaUrl
      ? probe('WAHA', 'waha', `${wahaUrl.replace(/\/+$/, '')}/ping`)
      : Promise.resolve<StatusLine>({ id: 'waha', label: 'WAHA', ok: false, detail: 'WAHA_URL не заданий' }),
  ]);

  const [heartbeats, jobs, enrichment] = await Promise.all([
    loadHeartbeats().catch(() => [] as HeartbeatView[]),
    loadPendingJobs().catch(() => null),
    loadEnrichmentStatus().catch(() => null),
  ]);

  return { services: [dbLine, ...rest], heartbeats, jobs, enrichment };
}
