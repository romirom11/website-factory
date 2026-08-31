'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Status } from './Status';
import { safeHttpUrl } from '@/lib/format';
import { humanVerdict } from '@/lib/humanStatus';
import type { ApprovalItem } from '@/lib/approvals';
import type { ActionResult } from '@/lib/types';
import { deepLinkFor } from '@/lib/keys';
import { runWithToast } from '@/lib/toast';
import { approveOutreach, rejectOutreach, confirmManualSent } from '@/lib/actions';

const CHANNELS = [
  { value: 'whatsapp', label: 'WhatsApp', manual: false },
  { value: 'instagram', label: 'Instagram', manual: true },
  { value: 'viber', label: 'Viber', manual: true },
  { value: 'email', label: 'Email', manual: false },
];

function channelLabel(value: string | null): string {
  return CHANNELS.find((c) => c.value === value)?.label ?? '—';
}

function approvalStatus(sendState: string | null) {
  switch (sendState) {
    case 'delivery_unknown':
      return { tone: 'stop' as const, text: 'Результат відправки невідомий — не надсилай повторно' };
    case 'failed':
      return { tone: 'stop' as const, text: 'Відправку не завершено — перевір помилку задачі' };
    case 'manual_pending':
      return { tone: 'wait' as const, text: 'Затверджено — чекає ручної відправки' };
    case 'queued':
      return { tone: 'wait' as const, text: 'Затверджено — повідомлення у черзі' };
    default:
      return { tone: 'wait' as const, text: 'Демо готове — чекає на твоє слово' };
  }
}

/**
 * The one decision the whole factory is built around: send this message, or not.
 *
 * Every mechanism the previous card had is still here — editable text, channel
 * override, contact evidence, manual deep-link flow — but only the two things
 * Roman needs to READ are open by default: what the demo looks like, and what
 * the message says. The channel picker, the evidence list and the address field
 * are behind «ще», because on the normal path the factory already chose right
 * and touching them is the exception.
 */
export function ApprovalCard({ item }: { item: ApprovalItem }) {
  const [channel, setChannel] = useState(item.channel ?? '');
  const [toAddress, setToAddress] = useState(item.toAddress ?? '');
  const [subject, setSubject] = useState(item.subject ?? '');
  const [body, setBody] = useState(item.body);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [showMore, setShowMore] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [result, setResult] = useState<ActionResult | null>(
    // Already approved and waiting on a hand-send: show the manual panel immediately.
    item.decision === 'approved' && item.sendState === 'manual_pending'
      ? {
          ok: true,
          message: 'Затверджено раніше — чекає, поки ти надішлеш вручну.',
          manual: {
            channel: item.channel ?? '',
            deepLink: '',
            text: item.body,
            approvalId: item.approvalId ?? 0,
          },
        }
      : null,
  );
  const [pending, startTransition] = useTransition();

  const decided = Boolean(item.decision);
  const manualChannel = CHANNELS.find((c) => c.value === channel)?.manual ?? false;
  const dirty = channel !== (item.channel ?? '') || body !== item.body;
  const deepLink = deepLinkFor(channel, toAddress, body);
  const verdict = humanVerdict(item.websiteVerdict);
  const deliveryStatus = approvalStatus(item.sendState);

  // The in-card result panel STAYS: for a manual channel it is not a message
  // but a workflow — the deep link, the copy button and «Я надіслав». The toast
  // is the immediate acknowledgement; the panel is what you then work in.
  function onApprove() {
    if (!item.approvalId) return;
    startTransition(() => {
      void runWithToast(
        () => approveOutreach({
          approvalId: item.approvalId!, channel, toAddress,
          subject: subject || null, body,
        }),
        { onResult: setResult },
      );
    });
  }

  function onReject() {
    if (!item.approvalId) return;
    startTransition(() => {
      void runWithToast(
        () => rejectOutreach({ approvalId: item.approvalId!, reason: rejectReason }),
        { onResult: (res) => { setResult(res); if (res.ok) setRejecting(false); } },
      );
    });
  }

  function onConfirmManual() {
    if (!item.approvalId) return;
    startTransition(() => {
      void runWithToast(
        () => confirmManualSent({ approvalId: item.approvalId! }),
        { onResult: setResult },
      );
    });
  }

  return (
    <article className="card overflow-hidden">
      <div className="p-5 sm:p-6">
        <Status tone={deliveryStatus.tone}>{deliveryStatus.text}</Status>

        <h2 className="text-xl font-semibold mt-2">
          <Link href={`/businesses/${item.businessId}`} className="link">
            {item.name}
          </Link>
        </h2>

        <p className="text-sm text-ink-soft mt-1.5">
          {[item.category, verdict.text, item.score !== null ? `бал ${item.score}` : null]
            .filter(Boolean).join(' · ')}
        </p>
      </div>

      {/* ── the demo ── */}
      <div className="px-5 sm:px-6">
        {item.demoUrl ? (
          <>
            <div className="flex items-center justify-between gap-3 mb-2.5">
              <span className="label mb-0">Демосайт</span>
              {/* A segmented control, not two words. The unselected half used
                  to be bare ink-mute text whose only affordance was a hover —
                  so on a phone there was nothing to say the preview could be
                  switched at all. The enclosing track is what makes both halves
                  read as one switch; the selected half is the raised one. */}
              <div className="flex gap-0.5 rounded-lg border border-line bg-paper-sunk p-0.5">
                {(['desktop', 'mobile'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDevice(d)}
                    aria-pressed={device === d}
                    className={`rounded-md px-2.5 py-1 text-sm transition-colors ${
                      device === d
                        ? 'bg-paper-card text-ink font-medium shadow-card'
                        : 'text-ink-soft hover:text-ink'
                    }`}
                  >
                    {d === 'desktop' ? 'Комп’ютер' : 'Телефон'}
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-line overflow-hidden bg-white flex justify-center">
              <iframe
                src={item.demoUrl}
                title={`Демо ${item.name}`}
                sandbox="allow-scripts allow-same-origin"
                className={`bg-white block ${device === 'mobile' ? 'w-[390px] max-w-full' : 'w-full'}`}
                style={{ height: 420, border: 0 }}
              />
            </div>
            <a
              href={safeHttpUrl(item.demoUrl)}
              target="_blank"
              rel="noreferrer"
              className="link text-sm mt-2"
            >
              Відкрити на весь екран ↗
            </a>
          </>
        ) : (
          <p className="text-sm text-dot-wait">Демо ще не опубліковане — показати нічого.</p>
        )}
      </div>

      {/* ── the message ── */}
      <div className="p-5 sm:p-6 space-y-4">
        <div>
          <div className="flex items-baseline justify-between gap-3 mb-1.5">
            <span className="label mb-0">
              Повідомлення в {channelLabel(channel)}
            </span>
            <span className="text-sm text-ink-mute tabular-nums">{body.length}</span>
          </div>
          <textarea
            id={`bo-${item.approvalId}`}
            aria-label="Текст першого повідомлення"
            value={body}
            disabled={decided}
            onChange={(e) => setBody(e.target.value)}
            rows={7}
          />
          <p className="text-sm text-ink-mute mt-1.5">
            {toAddress ? `Кому: ${toAddress}` : 'Адреси немає — вибери канал нижче.'}
            {dirty && !decided && ' · змінено вручну, запишеться в approval'}
          </p>
        </div>

        {/* ── everything secondary ── */}
        <details open={showMore} onToggle={(e) => setShowMore(e.currentTarget.open)}>
          {/* Named by what it holds. «ще» told the reader there was more of
              something without saying of what — and the address field lives in
              here, which the line above tells people to come looking for. */}
          <summary className="disclosure">Канал, адреса і докази</summary>

          <div className="mt-4 space-y-4 pl-4 border-l-2 border-line">
            <div>
              <label className="label" htmlFor={`ch-${item.approvalId}`}>Канал і адреса</label>
              <div className="flex gap-2 flex-wrap">
                <select
                  id={`ch-${item.approvalId}`}
                  value={channel}
                  disabled={decided}
                  onChange={(e) => {
                    const next = e.target.value;
                    setChannel(next);
                    const cand = item.candidates.find((c) => c.channel === next);
                    if (cand) setToAddress(cand.toAddress);
                  }}
                  className="flex-1 min-w-[150px]"
                >
                  <option value="">— немає —</option>
                  {CHANNELS.map((c) => {
                    const cand = item.candidates.find((x) => x.channel === c.value);
                    return (
                      <option key={c.value} value={c.value}>
                        {c.label}{c.manual ? ' (вручну)' : ''}{cand ? '' : ' — контакту немає'}
                      </option>
                    );
                  })}
                </select>
                <input
                  value={toAddress}
                  disabled={decided}
                  onChange={(e) => setToAddress(e.target.value)}
                  placeholder="адреса, номер або хендл"
                  aria-label="Адреса отримувача"
                  className="flex-1 min-w-[170px] font-mono"
                />
              </div>
              <p className="text-sm text-ink-mute mt-1.5">{item.channelReason}</p>
            </div>

            {channel === 'email' && (
              <div>
                <label className="label" htmlFor={`su-${item.approvalId}`}>Тема листа</label>
                <input
                  id={`su-${item.approvalId}`}
                  value={subject}
                  disabled={decided}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </div>
            )}

            {item.candidates.length > 0 && (
              <div>
                <span className="label">Звідки ми знаємо ці контакти</span>
                <ul className="space-y-1">
                  {item.candidates.map((c, i) => (
                    <li key={i} className="text-sm text-ink-mute">
                      {c.channel} · <span className="font-mono">{c.toAddress}</span> · {c.evidence}
                      {c.verified && ' · підтверджено'}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <span className="label">Чому цей бізнес тут</span>
              <p className="text-sm text-ink-soft">{item.queueReason}</p>
            </div>
          </div>
        </details>
      </div>

      {/* ── the decision ── */}
      {!decided && !rejecting && (
        <div className="border-t border-line bg-paper-sunk/50 p-5 sm:p-6 flex flex-wrap gap-2 items-center">
          <button
            type="button"
            onClick={onApprove}
            disabled={pending || !channel || !toAddress || !body.trim()}
            className="btn-primary"
          >
            {pending ? 'Обробка…' : manualChannel ? 'Підтвердити — надішлю сам' : 'Підтвердити і надіслати'}
          </button>
          <button
            type="button"
            onClick={() => setRejecting(true)}
            disabled={pending}
            className="btn-danger ml-auto"
          >
            Відхилити
          </button>
        </div>
      )}

      {!decided && rejecting && (
        <div className="border-t border-line bg-paper-sunk/50 p-5 sm:p-6 space-y-3">
          <label className="label" htmlFor={`rr-${item.approvalId}`}>Чому не надсилаємо</label>
          <input
            id={`rr-${item.approvalId}`}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            autoFocus
            placeholder="причина — запишеться в історію"
          />
          <div className="flex gap-2">
            <button type="button" className="btn-danger" onClick={onReject} disabled={pending}>
              {pending ? 'Відхиляю…' : 'Відхилити'}
            </button>
            <button type="button" className="btn-quiet" onClick={() => setRejecting(false)}>
              Скасувати
            </button>
          </div>
        </div>
      )}

      {result && (
        <div
          role="status"
          className={`border-t border-line p-5 sm:p-6 ${
            result.ok ? 'bg-accent-soft' : 'bg-dot-stop/5'
          }`}
        >
          <p className={`text-sm ${result.ok ? 'text-accent' : 'text-dot-stop'}`}>{result.message}</p>

          {result.manual && (
            <div className="mt-4 space-y-3">
              <div className="flex gap-2 flex-wrap">
                <a
                  href={result.manual.deepLink || deepLink}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-outline no-underline"
                >
                  Відкрити {channelLabel(result.manual.channel)}
                </a>
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => navigator.clipboard?.writeText(result.manual!.text || body)}
                >
                  Скопіювати текст
                </button>
              </div>
              <button
                type="button"
                onClick={onConfirmManual}
                disabled={pending}
                className="btn-primary w-full sm:w-auto"
              >
                Я надіслав
              </button>
              <p className="text-sm text-ink-mute">
                Підтвердження запише повідомлення як відправлене і поставить нагадування.
              </p>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
