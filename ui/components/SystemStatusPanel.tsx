import { Badge } from '@/components/Badge';
import type { SystemStatus } from '@/lib/systemStatus';

/**
 * "Is anything broken right now" at a glance.
 *
 * The heartbeat rows are the part that cannot be faked by a healthy container:
 * each factory process stamps one every 30 seconds, so a stale age means the
 * workers are wedged even though the container is technically up.
 */
export function SystemStatusPanel({ status }: { status: SystemStatus }) {
  return (
    <section className="card p-4 space-y-4">
      <h2 className="text-sm font-medium text-ink">Стан системи</h2>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {status.services.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-2 rounded-md border border-line bg-paper-sunk px-3 py-2">
            <span className="text-sm text-ink">{s.label}</span>
            <span className="flex items-center gap-2">
              <span className="text-xs text-ink-mute truncate max-w-[10rem]" title={s.detail}>{s.detail}</span>
              <Badge tone={s.ok ? 'ok' : 'bad'}>{s.ok ? 'ok' : 'down'}</Badge>
            </span>
          </div>
        ))}
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-wide text-ink-mute mb-2">Воркери (heartbeat кожні 30с)</h3>
        {status.heartbeats.length === 0 ? (
          <p className="text-sm text-ink-mute">
            Жодного heartbeat. Контейнери <code>factory</code> / <code>factory-build</code> ще не перезапускалися
            після оновлення, або воркери не працюють.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {status.heartbeats.map((h) => (
              <div key={h.group} className="rounded-md border border-line bg-paper-sunk px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-ink">{h.group}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-ink-mute">
                      {h.ageLabel ?? '—'}{h.pid ? ` · pid ${h.pid}` : ''}
                    </span>
                    <Badge tone={h.stale ? 'bad' : 'ok'}>
                      {h.stale ? 'застій' : 'живий'}
                    </Badge>
                  </span>
                </div>
                {h.capacity.length > 0 && (
                  <div className="mt-2 space-y-1 border-t border-line pt-2">
                    {h.capacity.map((capacity) => (
                      <p key={capacity.group} className="text-xs text-ink-mute tabular-nums">
                        {capacity.group}: агенти {capacity.active}/{capacity.limit}
                        {capacity.waiting > 0 ? ` · чекає ${capacity.waiting}` : ''}
                        {capacity.consumerHandles !== null
                          ? ` · consumers ${capacity.consumerHandles}/${capacity.consumerTarget}`
                          : ''}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-wide text-ink-mute mb-2">Черга</h3>
        {status.jobs ? (
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge tone="info">в черзі: {status.jobs.queued}</Badge>
            <Badge tone={status.jobs.active > 0 ? 'ok' : 'idle'}>в роботі: {status.jobs.active}</Badge>
            <Badge tone={status.jobs.failed > 0 ? 'bad' : 'idle'}>failed: {status.jobs.failed}</Badge>
          </div>
        ) : (
          <p className="text-sm text-ink-mute">Ledger черги ще не ініціалізований.</p>
        )}
      </div>
    </section>
  );
}
