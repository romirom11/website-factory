'use client';

/**
 * "Підключені акаунти" — every credential the factory needs, one ROW each,
 * expanding into the full connect/check flow on click (see `AccountRow`).
 *
 * Two rules decide everything on this screen, both of them from Roman's
 * feedback on 2026-08-21 ("Заходжу — Claude 'налаштовано', Codex 'частково',
 * хоча обидва підключені; тисну Перевірити — все ок. Кнопки в ряд, не зрозуміло
 * де текст а де кнопка"):
 *
 *  1. **The status is the answer, not a guess.** A card opens showing the
 *     result of a REAL check (cached ten minutes in the factory, see
 *     `src/api/checkCache.ts`), so the page no longer needs to be asked before
 *     it tells the truth. The old two-word vocabulary — «налаштовано» meaning
 *     "a row exists" versus «підключено» meaning "verified" — is gone: it made
 *     the page's most prominent word describe the least interesting fact.
 *
 *  2. **One primary action per card, and it moves.** When nothing is connected
 *     the filled button is «Підключити». Once it IS connected the status is the
 *     hero and there is no filled button at all — «Оновити» is an outline and
 *     «Перепідключити» / «Відключити» are quiet and destructive respectively,
 *     because neither is what Roman came here to do. Anything clickable is a
 *     button; anything not clickable is muted text under the buttons, never
 *     beside them.
 *
 *  3. **No one-item dropdowns** (Roman, 2026-08-22). The secondary actions used
 *     to hide behind a «···» that, for Codex and Telegram, opened onto a single
 *     item — a button wearing a costume, hiding the action and charging a click
 *     for it. Two or fewer secondary actions render inline; a «···» would have
 *     to earn itself with three.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Status } from '@/components/Status';
import { WahaQr } from '@/components/WahaQr';
import { refreshCheck, runCheck, type CheckOutcome } from '@/lib/settingsActions';
import { toastError, toastResult } from '@/lib/toast';
import {
  cancelAccount, disconnectAccount, findTelegramChats, pollAccount,
  saveGmail, saveTelegramToken, startAccount, submitAccountCode, useTelegramChat,
  type AccountSession, type TelegramChat,
} from '@/lib/accountsActions';
import { gmailVerdict, verdictOf, wahaQrAvailable, type Verdict } from '@/lib/accountVerdict';
import type { AccountsSnapshot, AccountStatus } from '@/lib/accounts';
import type { CheckKind, ChecksByKind } from '@/lib/checks';

/** http(s) only — the URL comes from CLI output, so it is never blindly trusted. */
function safeHttpUrl(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.toString() : undefined;
  } catch { return undefined; }
}

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * «перевірено N хв тому», computed AFTER mount.
 *
 * Anything derived from `now` differs between the server's HTML and the
 * browser's hydration pass, which is React #418 — the same trap `lib/format.ts`
 * documents. Rendering nothing on the first paint makes both passes agree, and
 * the label appears a frame later.
 */
function CheckedAgo({ at }: { at: string | null | undefined }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!at) { setLabel(null); return; }
    const tick = () => {
      const ms = Date.now() - Date.parse(at);
      if (!Number.isFinite(ms)) { setLabel(null); return; }
      const min = Math.floor(ms / 60_000);
      setLabel(
        min < 1 ? 'перевірено щойно'
          : min < 60 ? `перевірено ${min} хв тому`
            : `перевірено ${Math.floor(min / 60)} год тому`,
      );
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [at]);

  if (!label) return null;
  return <span className="text-sm text-ink-mute whitespace-nowrap">{label}</span>;
}

// ─── Card chrome ─────────────────────────────────────────────────────────────

/**
 * A SUCCESSFUL check's own words, under the actions.
 *
 * Failures are deliberately not rendered here: the card header already shows
 * «помилка» with the reason underneath it, and printing the same sentence twice
 * in one card is how the old page got noisy. A success, on the other hand, says
 * something the one-word status cannot — «Тестове повідомлення надіслано»
 * tells Roman to go look at his phone.
 */
function Outcome({ outcome, prefix }: { outcome: CheckOutcome | undefined; prefix?: string }) {
  if (!outcome || outcome.pending || !outcome.ok) return null;
  return (
    <div className="rounded-lg border border-dot-go/30 bg-dot-go/8 px-3 py-2 text-sm text-dot-go">
      {prefix ? `${prefix}: ` : ''}{outcome.message}
    </div>
  );
}

/**
 * One account as one ROW: name, real status, when it was checked — and nothing
 * else until it is clicked (Roman's pick, 2026-08-22, against the six
 * always-open cards that made this the tallest block of the old page).
 *
 * The collapsed row answers the only question a working account ever gets
 * asked: «воно живе?». Everything a person needs while CONNECTING — buttons,
 * QR, forms, instructions — expands under the one account being worked on,
 * one at a time (an accordion), because nobody connects two services at once.
 */
function AccountRow({ title, identity, blurb, verdict, checkedAt, open, onToggle, actions, children, footnote, how }: {
  title: string;
  /** Human identity for the connected account, shown without opening the row. */
  identity?: string | null;
  blurb: string;
  verdict: Verdict;
  checkedAt?: string | null;
  open: boolean;
  onToggle: () => void;
  /** The action row. Exactly one filled button in here, or none — or nothing at all. */
  actions?: React.ReactNode;
  children?: React.ReactNode;
  /** One muted paragraph, under the actions. Longer text belongs in `how`. */
  footnote?: React.ReactNode;
  /** Collapsed «Як це працює» — the multi-step explanations live here. */
  how?: React.ReactNode;
}) {
  return (
    <div className="border-b border-line last:border-b-0">
      {/* The whole row is the toggle, with an explicit ▸ — the affordance rule:
          if it can be clicked, it looks clickable. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="w-full flex items-center gap-x-3 py-3 px-2 -mx-2 rounded-lg text-left
                   transition-colors hover:bg-paper-sunk"
      >
        <span aria-hidden className={`text-ink-mute shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>▸</span>
        <span className="text-sm font-medium text-ink shrink-0">{title}</span>
        <Status tone={verdict.tone}>{verdict.label}</Status>
        {identity && (
          <span className="min-w-0 truncate text-sm text-ink-soft" title={identity}>{identity}</span>
        )}
        <span className="ml-auto hidden sm:inline"><CheckedAgo at={checkedAt} /></span>
      </button>

      {open && (
        <div className="pb-4 pl-6 space-y-3">
          <p className="text-sm text-ink-mute max-w-[70ch]">{blurb}</p>

          {verdict.reason && (
            <p className="text-sm text-dot-stop break-words">{verdict.reason}</p>
          )}

          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}

          {children}

          {footnote && <p className="text-sm text-ink-mute max-w-[70ch]">{footnote}</p>}

          {/* The disclosure triangle is drawn explicitly: globals.css hides the
              native marker, and without a replacement a <summary> is a line of
              text that happens to be clickable — which is the confusion this
              whole screen is being fixed for. */}
          {how && (
            <details className="text-sm group">
              <summary className="inline-flex items-center gap-1.5 text-ink-soft hover:text-ink">
                <span aria-hidden className="text-ink-mute transition-transform group-open:rotate-90">›</span>
                Як це працює
              </summary>
              <div className="mt-2 space-y-2 text-ink-mute max-w-[70ch]">{how}</div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * «Оновити» — re-runs one check and replaces the card's status.
 *
 * The toast matters most on the FAILING path: a check that comes back red only
 * repaints a word in the card header, and «Надіслати тест» in particular is a
 * button whose whole purpose is to tell you whether something arrived.
 */
function RefreshButton({ kind, onResult, label = 'Оновити' }: {
  kind: CheckKind; onResult: (o: CheckOutcome) => void; label?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button" className="btn-outline btn-sm" disabled={busy}
      onClick={async () => {
        setBusy(true);
        onResult({ ok: false, message: '', pending: true });
        try {
          const out = await refreshCheck(kind);
          onResult(out);
          toastResult(out, out.ok ? `${label}: готово` : `${label}: не вдалося`);
        } catch (err) {
          const out = { ok: false, message: `Перевірка впала: ${String(err).slice(0, 160)}` };
          onResult(out);
          toastError(out.message);
        }
        setBusy(false);
      }}
    >
      {busy ? 'Перевіряю…' : label}
    </button>
  );
}

// ─── Interactive CLI flow (Claude / Codex) ───────────────────────────────────

/**
 * Drives one `/internal/accounts/:provider/*` session.
 *
 * Polling rather than streaming: the human step in the middle is unbounded (he
 * has to open a browser and sign in), and a 1.5s poll over a server action is
 * both simpler and more robust than holding a stream open across a container
 * boundary for five minutes.
 *
 * A HOOK rather than a component, because its two outputs belong in two
 * different places on the card: the trigger goes in the action row (where its
 * prominence depends on whether the account is already connected — something
 * this hook does not know), and the progress panel goes below it, in the card
 * body. As a component it could only return both together, which put a status
 * panel inside a flex row of buttons.
 */
function useCliFlow({ provider, needsCode, onDone }: {
  provider: 'claude' | 'codex';
  /** Claude blocks on a "Paste code here" prompt; Codex does not. */
  needsCode: boolean;
  onDone: (check: CheckOutcome) => void;
}): { start: () => void; cancel: () => void; busy: boolean; live: boolean; panel: React.ReactNode } {
  const [session, setSession] = useState<AccountSession | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const live = Boolean(session
    && session.phase !== 'done' && session.phase !== 'error' && session.phase !== 'cancelled');

  const stopPolling = useCallback(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
  }, []);

  // Poll while a flow is in flight; stop the moment it reaches a terminal phase.
  useEffect(() => {
    if (!live) { stopPolling(); return; }
    if (timer.current) return;
    timer.current = setInterval(() => {
      void pollAccount(provider).then((s) => {
        if (!s) return;
        setSession(s);
        if (s.phase === 'done' || s.phase === 'error') {
          stopPolling();
          if (s.check) onDone(s.check);
          // THE outcome of the whole flow, and the one moment Roman is most
          // likely to have looked away — an interactive login takes minutes.
          toastResult(
            { ok: s.phase === 'done', message: s.message },
            s.phase === 'done' ? 'Акаунт підключено' : 'Підключити не вдалося',
          );
        }
      });
    }, 1500);
    return stopPolling;
  }, [live, provider, stopPolling, onDone]);

  // A component unmounting (page nav) must not leave an interval running.
  useEffect(() => stopPolling, [stopPolling]);

  const start = useCallback(() => {
    setBusy(true);
    setCode('');
    void startAccount(provider).then((s) => {
      setSession(s);
      setBusy(false);
      // Only the failure is toasted here. A started flow is not an outcome —
      // the panel below now shows a login URL and a code box, which is far
      // louder than a toast, and the outcome toast comes on `done`/`error`.
      if (s.phase === 'error') toastError(s.message);
    });
  }, [provider]);

  const cancel = useCallback(() => {
    stopPolling();
    void cancelAccount(provider).then((s) => {
      setSession(s);
      toastResult({ ok: true, message: s.message }, 'Підключення скасовано');
    });
  }, [provider, stopPolling]);

  async function submit() {
    if (!code.trim()) return;
    setBusy(true);
    const s = await submitAccountCode(provider, code);
    setSession(s);
    if (s.phase === 'error') toastError(s.message);
    setCode('');
    setBusy(false);
  }

  const url = safeHttpUrl(session?.url);

  const panel = session && session.phase !== 'cancelled'
    ? (
        <div className={`rounded-lg border px-3 py-2.5 text-sm space-y-2 ${
          session.phase === 'error'
            ? 'border-dot-stop/30 bg-dot-stop/8 text-dot-stop'
            : session.phase === 'done'
              ? 'border-dot-go/30 bg-dot-go/8 text-dot-go'
              : 'border-line bg-paper-sunk text-ink-soft'
        }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{session.message}</span>
            {live && session.expiresInMs ? (
              <span className="text-sm text-ink-mute">
                лишилось ~{Math.ceil(session.expiresInMs / 60_000)} хв
              </span>
            ) : null}
          </div>

          {session.cliTail && (session.phase === 'submitting' || session.phase === 'error') && (
            <details className="group">
              {/* globals.css hides the native marker, so the triangle is drawn
                  explicitly — otherwise this is an ordinary line of text that
                  happens to respond to clicks. */}
              <summary className="inline-flex items-center gap-1.5 text-sm opacity-80 hover:opacity-100">
                <span aria-hidden className="transition-transform group-open:rotate-90">›</span>
                Що пише CLI
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-black/5 p-2 text-[11px] font-mono">{session.cliTail}</pre>
            </details>
          )}

          {url && (session.phase === 'awaiting' || session.phase === 'submitting') && (
            <div className="space-y-2">
              <a
                href={url} target="_blank" rel="noreferrer"
                className="btn-outline btn-sm no-underline"
              >
                Відкрити сторінку входу ↗
              </a>
              {/* The full URL in copyable form: the button opens a new tab, but
                  if Roman is doing this on a headless server over SSH he needs
                  the text to paste into a browser on another machine. */}
              <label className="block">
                <span className="label">Або скопіюй посилання</span>
                <input
                  readOnly value={url} onFocus={(e) => e.currentTarget.select()}
                  className="w-full font-mono text-[11px]"
                />
              </label>

              {session.userCode && (
                <div className="text-sm text-ink">
                  Одноразовий код на сторінці:{' '}
                  <code className="bg-paper-card border border-line rounded px-2 py-1 text-base tracking-widest">
                    {session.userCode}
                  </code>
                </div>
              )}
            </div>
          )}

          {needsCode && session.phase === 'awaiting' && (
            <label className="block">
              <span className="label">Код зі сторінки входу</span>
              <div className="flex flex-wrap gap-2 items-center">
                <input
                  type="text" value={code} onChange={(e) => setCode(e.target.value)}
                  placeholder="встав код сюди"
                  autoComplete="off" spellCheck={false}
                  className="flex-1 min-w-[14rem] font-mono text-sm"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
                />
                <button type="button" className="btn-primary btn-sm" disabled={busy || !code.trim()} onClick={() => void submit()}>
                  {busy ? 'Надсилаю…' : 'Надіслати код'}
                </button>
              </div>
            </label>
          )}
        </div>
      )
    : null;

  return { start, cancel, busy, live, panel };
}

/**
 * Claude and Codex: one card shape, because they are the same job — an
 * interactive CLI login driven from the browser. They differ only in whether a
 * code comes back here (Claude) or is entered on the provider's own page
 * (Codex). Both can be disconnected through their CLI/runtime-owned store; the
 * shared component never reaches into credential files itself.
 *
 * The action row is where Roman's "кнопки в ряд" complaint is answered.
 * Connected means the status is the hero and no button is filled: «Оновити» is
 * an outline and «Перепідключити» is quiet, because reconnecting a working
 * account is a recovery action and must never sit filled and inviting next to a
 * green status. Quiet, not hidden — see rule 3 in the block comment above.
 */
function CliAccountRow({
  provider, title, identity, blurb, verdict, checkedAt, needsCode, canDisconnect,
  open, onToggle, onResult, onDisconnect, footnote, how,
}: {
  provider: 'claude' | 'codex';
  title: string;
  identity?: string | null;
  blurb: string;
  verdict: Verdict;
  checkedAt: string | null;
  needsCode: boolean;
  canDisconnect: boolean;
  open: boolean;
  onToggle: () => void;
  onResult: (o: CheckOutcome) => void;
  onDisconnect?: () => void;
  footnote?: React.ReactNode;
  how?: React.ReactNode;
}) {
  const flow = useCliFlow({ provider, needsCode, onDone: onResult });

  return (
    <AccountRow
      title={title}
      identity={identity}
      blurb={blurb}
      verdict={verdict}
      checkedAt={checkedAt}
      // A live login flow pins the row open: collapsing it mid-login would hide
      // the URL and the code box while the CLI is still waiting on them.
      open={open || flow.live}
      onToggle={onToggle}
      footnote={footnote}
      how={how}
      actions={flow.live ? (
        <button type="button" className="btn-outline btn-sm" onClick={flow.cancel}>Скасувати</button>
      ) : verdict.connected ? (
        // Two secondary actions at most here, so they sit inline as buttons.
        // «···» is for three or more (Roman, 2026-08-22: a one-item dropdown is
        // a button wearing a costume — it hides the action AND costs a click).
        // They stay quiet/danger rather than filled: re-connecting a working
        // account is a recovery action, never an invitation.
        <>
          <RefreshButton kind={provider} onResult={onResult} />
          <button type="button" className="btn-quiet btn-sm" disabled={flow.busy} onClick={flow.start}>
            Перепідключити
          </button>
          {canDisconnect && onDisconnect && (
            <button type="button" className="btn-danger btn-sm" onClick={onDisconnect}>
              Відключити
            </button>
          )}
        </>
      ) : (
        <>
          <button type="button" className="btn-primary btn-sm" disabled={flow.busy} onClick={flow.start}>
            {flow.busy ? 'Запускаю…' : 'Підключити'}
          </button>
          <RefreshButton kind={provider} onResult={onResult} />
        </>
      )}
    >
      {flow.panel}
    </AccountRow>
  );
}

// ─── Telegram ────────────────────────────────────────────────────────────────

/**
 * Bot token, then chat id, then a test message — three labelled rows in that
 * order, each unlocked by the one above it.
 *
 * They used to be four buttons on one line with an unlabelled password box,
 * which is the row Roman could not read. The ordering is not decoration: a chat
 * id cannot be found without a token, and a test message needs both, so a
 * disabled button here is telling him what to do next.
 */
function TelegramFlow({ status, chatId, onCheck }: {
  status: AccountStatus;
  /** Current chat id, so the row can show it instead of hiding it in `detail`. */
  chatId: string | null;
  onCheck: (o: CheckOutcome) => void;
}) {
  const [token, setToken] = useState('');
  const [chats, setChats] = useState<TelegramChat[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const hasToken = status.readiness !== 'missing' || token.trim() !== '';
  const hasChat = Boolean(chatId);

  async function saveToken() {
    setBusy('token');
    const r = await saveTelegramToken(token);
    setMsg({ ok: r.ok, text: r.message });
    toastResult(r, 'Токен бота збережено');
    if (r.ok) setToken('');
    setBusy(null);
  }

  async function find() {
    setBusy('find');
    setChats(null);
    // An unsaved token in the box wins, so "paste → знайти" works before saving.
    const r = await findTelegramChats(token.trim() || undefined);
    setMsg({ ok: r.ok, text: r.message });
    // The found chats are the answer and they render right below, so only the
    // "nothing came back" case needs saying out loud.
    if (!r.ok || !r.chats.length) {
      toastResult(r, 'Жодного чату не знайшлось — напиши боту повідомлення і спробуй ще');
    }
    setChats(r.chats);
    setBusy(null);
  }

  async function pick(id: string) {
    setBusy(id);
    const r = await useTelegramChat(id);
    setMsg({ ok: r.ok, text: r.message });
    toastResult(r, 'Chat id збережено');
    setBusy(null);
    if (r.ok) {
      // Saved id + saved token = the only thing left worth knowing is whether a
      // message actually arrives, so run that immediately.
      onCheck({ ok: false, message: '', pending: true });
      onCheck(await runCheck('telegram'));
    }
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="label">Токен бота</span>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            type="password" value={token} onChange={(e) => setToken(e.target.value)}
            placeholder={status.readiness === 'missing' ? 'токен від @BotFather' : 'новий токен (порожньо = лишити поточний)'}
            autoComplete="new-password" className="flex-1 min-w-[16rem] font-mono text-sm"
          />
          <button
            type="button" className="btn-outline btn-sm"
            disabled={busy !== null || !token.trim()} onClick={() => void saveToken()}
          >
            {busy === 'token' ? 'Зберігаю…' : 'Зберегти'}
          </button>
        </div>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-soft">
          Chat ID: {chatId ? <code className="text-ink">{chatId}</code> : <span className="text-ink-mute">не заданий</span>}
        </span>
        <button
          type="button" className="btn-outline btn-sm"
          disabled={busy !== null || !hasToken}
          title={hasToken ? undefined : 'Спершу збережи токен бота'}
          onClick={() => void find()}
        >
          {busy === 'find' ? 'Шукаю…' : 'Знайти'}
        </button>
        {hasToken && hasChat && (
          <RefreshButton kind="telegram-send" onResult={onCheck} label="Надіслати тест" />
        )}
      </div>

      {chats && chats.length > 0 && (
        <div className="space-y-1">
          {chats.map((c) => (
            <button
              key={c.id} type="button" disabled={busy !== null}
              onClick={() => void pick(c.id)}
              // A pick-one row, so it carries the button chrome rather than
              // inventing a third clickable style: btn-outline plus the
              // left-aligned two-column layout the list needs.
              className="btn-outline w-full justify-between text-left gap-2"
            >
              <span className="truncate text-ink">{c.title}</span>
              <span className="text-sm text-ink-mute shrink-0">{c.type} · {c.id}</span>
            </button>
          ))}
        </div>
      )}

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${
          msg.ok ? 'border-dot-go/30 bg-dot-go/8 text-dot-go' : 'border-dot-wait/30 bg-dot-wait/8 text-dot-wait'
        }`}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

// ─── Gmail ───────────────────────────────────────────────────────────────────

/** «Оновити» for Gmail: both protocols, one click, because it is one account. */
function GmailRefreshButton({ onSmtp, onImap }: {
  onSmtp: (o: CheckOutcome) => void; onImap: (o: CheckOutcome) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button" className="btn-outline btn-sm" disabled={busy}
      onClick={async () => {
        setBusy(true);
        onSmtp({ ok: false, message: '', pending: true });
        onImap({ ok: false, message: '', pending: true });
        // In parallel: two independent handshakes to the same host, and doing
        // them one after the other doubles the wait for no reason.
        const [smtp, imap] = await Promise.all([refreshCheck('smtp'), refreshCheck('imap')]);
        onSmtp(smtp);
        onImap(imap);
        // ONE toast for one click, even though two handshakes ran: two toasts
        // saying almost the same thing is what a person reads as noise.
        toastResult(
          { ok: smtp.ok && imap.ok, message: '' },
          smtp.ok && imap.ok
            ? 'Gmail працює: і надсилання, і читання пошти'
            : `Gmail: ${[!smtp.ok && `надсилання — ${smtp.message}`, !imap.ok && `читання — ${imap.message}`]
              .filter(Boolean).join('; ')}`,
        );
        setBusy(false);
      }}
    >
      {busy ? 'Перевіряю…' : 'Оновити'}
    </button>
  );
}

function GmailFlow({ connected, onSmtp, onImap }: {
  connected: boolean;
  onSmtp: (o: CheckOutcome) => void; onImap: (o: CheckOutcome) => void;
}) {
  const [addr, setAddr] = useState('');
  const [pass, setPass] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const r = await saveGmail(addr, pass);
    setMsg({ ok: r.ok, text: r.message });
    toastResult(r, 'Gmail збережено');
    if (r.ok) setPass('');
    setBusy(false);
    if (r.ok) {
      // Both halves use the same app password, so both are worth proving at once.
      onSmtp({ ok: false, message: '', pending: true });
      onImap({ ok: false, message: '', pending: true });
      onSmtp(await runCheck('smtp'));
      onImap(await runCheck('imap'));
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">Адреса Gmail</span>
          <input
            type="email" value={addr} onChange={(e) => setAddr(e.target.value)}
            placeholder="you@gmail.com" autoComplete="off" className="w-full text-sm"
          />
        </label>
        <label className="block">
          <span className="label">App password (16 символів)</span>
          <input
            type="password" value={pass} onChange={(e) => setPass(e.target.value)}
            placeholder="xxxx xxxx xxxx xxxx" autoComplete="new-password"
            className="w-full font-mono text-sm"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <button
          type="button"
          className={connected ? 'btn-outline btn-sm' : 'btn-primary btn-sm'}
          disabled={busy} onClick={() => void save()}
        >
          {busy ? 'Зберігаю…' : connected ? 'Замінити пароль' : 'Підключити'}
        </button>
      </div>

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${
          msg.ok ? 'border-dot-go/30 bg-dot-go/8 text-dot-go' : 'border-dot-wait/30 bg-dot-wait/8 text-dot-wait'
        }`}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

// ─── Block ───────────────────────────────────────────────────────────────────

export function ConnectedAccounts({ accounts, checks, checksError }: {
  accounts: AccountsSnapshot;
  /** Real, cached check results loaded on the server at render time. */
  checks: ChecksByKind;
  checksError: string | null;
}) {
  const [live, setLive] = useState<Partial<Record<CheckKind, CheckOutcome>>>({});
  const set = useCallback(
    (kind: CheckKind) => (o: CheckOutcome) => setLive((c) => ({ ...c, [kind]: o })),
    [],
  );

  // The accordion: one account expanded at a time, none by default. The
  // collapsed list IS the answer for working accounts; expanding is for the one
  // being connected or debugged right now.
  const [openRow, setOpenRow] = useState<string | null>(null);
  const row = (id: string) => ({
    open: openRow === id,
    onToggle: () => setOpenRow((cur) => (cur === id ? null : id)),
  });

  const [disc, setDisc] = useState<string | null>(null);
  async function doDisconnect(provider: CheckKind) {
    const r = await disconnectAccount(provider);
    setDisc(r.message);
    toastResult(r, r.ok ? `${provider} відключено` : 'Відключити не вдалося');
    if (r.ok) setLive((c) => ({ ...c, [provider]: { ok: false, message: 'Відключено.' } }));
  }

  const at = (kind: CheckKind) => (live[kind] ? null : checks[kind]?.at ?? null);
  const v = (kind: CheckKind, status: AccountStatus | null) => verdictOf(status, checks[kind], live[kind]);

  const claude = v('claude', accounts.claude);
  const codex = v('codex', accounts.codex);
  const telegram = v('telegram', accounts.telegram);
  const waha = v('waha', accounts.whatsapp);
  const smtp = v('smtp', accounts.gmail);
  const imap = v('imap', accounts.gmail);
  const gmail = gmailVerdict(smtp, imap);
  // Keep the known identity while a refresh is in flight, but clear it when a
  // fresh check says the session is no longer valid. A nullish fallback here
  // would otherwise pair a red «помилка» with the stale cached email.
  const codexEmailValue = live.codex
    ? live.codex.pending
      ? checks.codex?.detail?.accountEmail
      : live.codex.detail?.accountEmail
    : checks.codex?.detail?.accountEmail;
  const codexEmail = typeof codexEmailValue === 'string' ? codexEmailValue : null;

  // WAHA drives the QR: the check reports `needsQr` when the session is
  // unpaired, and the QR appears right there instead of on another port.
  const wahaNeedsQr = Boolean(live.waha?.needsQr ?? checks.waha?.needsQr);
  const wahaReachable = wahaQrAvailable(waha, wahaNeedsQr);

  return (
    <section className="card p-5 space-y-4">
      <div>
        <h2 className="h-section">Підключені акаунти</h2>
        <p className="text-sm text-ink-mute mt-1 max-w-[70ch]">
          Стан — результат справжньої перевірки при відкритті сторінки (кеш 10 хв).
          Клікни рядок, щоб підключити, перевірити чи налаштувати.
        </p>
      </div>

      {checksError && (
        <div className="rounded-lg border border-dot-wait/30 bg-dot-wait/8 px-3 py-2 text-sm text-dot-wait">
          {checksError}
        </div>
      )}

      {!accounts.masterKey && (
        <div className="rounded-lg border border-dot-stop/30 bg-dot-stop/8 px-3 py-2 text-sm text-dot-stop">
          <code>SETTINGS_MASTER_KEY</code> не заданий — DB-секрети Telegram, Gmail і WAHA
          не збережуться. Claude/Codex credentials у runner volume від цього ключа не залежать.
        </div>
      )}

      <div>
        <CliAccountRow
          provider="claude"
          {...row('claude')}
          title="Claude Code"
          blurb="Агентні етапи: brief, контент, збірка сайту, visual QA. По підписці Pro/Max."
          verdict={claude}
          checkedAt={at('claude')}
          needsCode
          canDisconnect
          onResult={set('claude')}
          onDisconnect={() => void doDisconnect('claude')}
          footnote="Токен зберігається у закритому credential volume runner-а (файл 0600) і діє без перезапуску."
          how={(
            <p>
              «Підключити» запускає <code>claude setup-token</code> в ізольованому runner executor, показує
              посилання на сторінку входу і чекає на код звідти. Код вводиться тут — CLI стоїть на
              запиті, доки не отримає його.
            </p>
          )}
        />

        <CliAccountRow
          provider="codex"
          {...row('codex')}
          title="Codex CLI"
          identity={codexEmail}
          blurb="Генерація зображень (gen-image) по підписці ChatGPT."
          verdict={codex}
          checkedAt={at('codex')}
          needsCode={false}
          canDisconnect
          onResult={set('codex')}
          onDisconnect={() => void doDisconnect('codex')}
          footnote="Логін лягає у volume codexhome і переживає ребілди образу."
          how={(
            <p>
              Код вводиться на сторінці OpenAI, а не тут: CLI сам опитує їхній сервер і сюди
              повертати нічого не треба — статус оновиться самостійно.
            </p>
          )}
        />

        {/*
          OpenCode has NO browser-driven login flow here on purpose: its
          `auth login` is an interactive TUI with per-provider steps we
          cannot drive honestly from a button. The row is status + refresh;
          the check's error message names the exact command when a login is
          what is missing. If AGENT_RUNTIME=opencode, this card is the one to
          watch — the ping goes through the same runtime the workers use.
        */}
        <AccountRow
          {...row('opencode')}
          title="OpenCode"
          blurb="Агентні етапи через провайдерів, залогінених в opencode. Модель — у Налаштуваннях → Агенти, формат provider/model."
          verdict={v('opencode', accounts.opencode)}
          checkedAt={at('opencode')}
          actions={<RefreshButton kind="opencode" onResult={set('opencode')} />}
          how={(
            <p>
              Підключення вручну, один раз: <code>docker compose exec agent-runner-executor opencode auth login</code> —
              вибери провайдера і заверши вхід. Список підключень: <code>docker compose exec agent-runner-executor opencode auth list</code>.
              Перевірка тут робить справжній виклик тією моделлю, що записана в налаштуваннях.
            </p>
          )}
        />

        {/* ── Telegram ── */}
        <AccountRow
          title="Telegram"
          {...row('telegram')}
          blurb="Тільки сповіщення з лінками в цей UI (рішення №9). Approve тут не робиться."
          verdict={telegram}
          checkedAt={at('telegram')}
          // The re-check for this card is «Надіслати тест» inside the flow
          // below — it IS the check (the only way to prove a token and a chat id
          // together is to send a message). A second «Оновити» here would be the
          // same button twice under two names.
          actions={telegram.connected ? (
            <button type="button" className="btn-danger btn-sm" onClick={() => void doDisconnect('telegram')}>
              Відключити
            </button>
          ) : null}
          how={(
            <p>
              Перед пошуком chat id <strong>надішли боту будь-яке повідомлення</strong> — Telegram
              віддає список чатів через <code>getUpdates</code>, а туди потрапляють лише ті, хто
              боту вже писав.
            </p>
          )}
        >
          <TelegramFlow
            status={accounts.telegram}
            chatId={accounts.telegramChatId}
            onCheck={set('telegram')}
          />
          <Outcome outcome={live.telegram} />
        </AccountRow>

        {/* ── WhatsApp ── */}
        <AccountRow
          title="WhatsApp (WAHA)"
          {...row('waha')}
          blurb="Self-hosted WAHA, не Meta Cloud API (рішення №2). Головний канал outreach."
          verdict={waha}
          checkedAt={at('waha')}
          // Scanning is the whole card when the session is unpaired, so the QR
          // leads and «Оновити» follows it. Once WhatsApp is connected there is
          // nothing to scan and re-checking is the only action left.
          actions={(
            <>
              {/* The QR only exists when WAHA answered. An unreachable WAHA has
                  no QR to show, and rendering the panel anyway produced a screen
                  of empty space with a stranded «Оновити» (Roman, 2026-08-22). */}
              <WahaQr autoShow={wahaNeedsQr} primary={wahaNeedsQr} reachable={wahaReachable} />
              <RefreshButton kind="waha" onResult={set('waha')} />
            </>
          )}
          footnote="Скануй виділеним номером, не особистим: протокол неофіційний і номер можуть заблокувати."
          how={(
            <p>
              <code>WAHA_API_KEY</code> і HMAC-ключ живуть у «Розширених» нижче — це той самий
              ключ, що в <code>.env</code> контейнера WAHA.
            </p>
          )}
        />

        {/* ── Gmail ── */}
        <AccountRow
          title="Gmail"
          {...row('gmail')}
          blurb="Резервний канал; месенджери мають пріоритет (рішення №8). IMAP ловить відповіді."
          verdict={gmail}
          checkedAt={at('smtp')}
          // ONE «Оновити», not one per protocol: Gmail is a single account with
          // a single app password, and two buttons here would make Roman decide
          // which half he cares about when the answer is always "both".
          actions={(
            <GmailRefreshButton onSmtp={set('smtp')} onImap={set('imap')} />
          )}
          footnote="Пробіли в паролі можна лишати — вони прибираються автоматично. Один app password заповнює і SMTP, і IMAP."
          how={(
            <ol className="list-decimal pl-5 space-y-1">
              <li>Увімкни двофакторну автентифікацію — без неї app password недоступний.</li>
              <li>
                На{' '}
                <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
                  myaccount.google.com/apppasswords ↗
                </a>{' '}
                створи пароль «websites-factory» (16 символів).
              </li>
              <li>Gmail → Settings → Forwarding and POP/IMAP → <strong>Enable IMAP</strong>.</li>
            </ol>
          )}
        >
          <GmailFlow connected={gmail.connected} onSmtp={set('smtp')} onImap={set('imap')} />
          <Outcome outcome={live.smtp} prefix="SMTP" />
          <Outcome outcome={live.imap} prefix="IMAP" />
        </AccountRow>

      </div>

      {disc && <p className="text-sm text-ink-soft">{disc}</p>}
    </section>
  );
}
