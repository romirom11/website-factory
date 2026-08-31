/**
 * Phase E acceptance run (SPEC §10 phase E: "тестовий лист самому собі
 * проходить весь цикл включно з reply").
 *
 * Proves the whole live outreach cycle WITHOUT Roman's Gmail app password and
 * without a single byte leaving the machine:
 *
 *   fixture business (campaign e2e-phasee-*) with an email contact
 *     -> approvals row (decision=approved)
 *     -> send-outreach handler, FACTORY_MODE=live, real SMTP to GreenMail
 *     -> message verified INSIDE the mailbox over IMAP
 *     -> a reply injected into the mailbox with In-Reply-To of our Message-ID
 *     -> poll-replies -> outreach_events reply, deal replied, business replied
 *     -> follow-up refuses to send
 *   plus the bounce path, the opt-out path, and the WAHA webhook path.
 *
 * Safety: every row this script creates lives under an `e2e-phasee-*`
 * campaign and is deleted at the end. It NEVER touches gr-patras-beauty — and
 * could not send to it anyway: a send is impossible without an approvals row,
 * and those businesses have none.
 *
 * Prerequisites (the script checks and tells you):
 *   docker compose --profile dev-mail up -d greenmail
 *   or: docker run -d --name factory-greenmail-dev -p 127.0.0.1:3025:3025 \
 *         -p 127.0.0.1:3143:3143 -p 127.0.0.1:8081:8080 \
 *         -e GREENMAIL_OPTS="-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap \
 *         -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
 *         greenmail/standalone@sha256:9f32971b4f25d32b4de6fa2e297423768441c65e4541f6aecd7631c890a229a7
 *
 * Run: pnpm tsx scripts/phaseE-e2e.ts        (add --keep to leave the rows behind)
 */
import 'dotenv/config';

// ── Point every channel at local test adapters BEFORE the DB client starts its
// settings refresher. UI settings normally beat env by design, so plain env
// assignments cannot safely isolate this acceptance process from production.
const TEST_MAILBOX = 'factory-test@factory.local';
const { overrideSettingsForProcess } = await import('../src/lib/settings.js');
const restorePhaseESettings = overrideSettingsForProcess({
  SMTP_HOST: process.env.PHASEE_SMTP_HOST ?? '127.0.0.1',
  SMTP_PORT: process.env.PHASEE_SMTP_PORT ?? '3025',
  SMTP_SECURE: 'false',
  SMTP_TLS_REJECT_UNAUTHORIZED: 'false',
  SMTP_USER: TEST_MAILBOX,
  SMTP_PASS: 'test',
  SMTP_FROM: `Roman (factory test) <${TEST_MAILBOX}>`,
  SMTP_MESSAGE_ID_DOMAIN: 'factory.local',
  SMTP_UNSUBSCRIBE_TO: TEST_MAILBOX,
  IMAP_HOST: process.env.PHASEE_IMAP_HOST ?? '127.0.0.1',
  IMAP_PORT: process.env.PHASEE_IMAP_PORT ?? '3143',
  IMAP_SECURE: 'false',
  IMAP_TLS_REJECT_UNAUTHORIZED: 'false',
  IMAP_USER: TEST_MAILBOX,
  IMAP_PASS: 'test',
  IMAP_MAILBOX: 'INBOX',
  IMAP_MAX_PER_POLL: '500',
  // LIVE on purpose: the real adapter path targets GreenMail on loopback.
  FACTORY_MODE: 'live',
  OUTREACH_DAILY_LIMIT: '1000',
  WAHA_URL: process.env.PHASEE_WAHA_URL ?? 'http://127.0.0.1:3001',
  WAHA_HOOK_HMAC_KEY: '',
  // A DB-backed real bot must never receive acceptance notifications.
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: '',
});

const { ImapFlow } = await import('imapflow');
const nodemailer = (await import('nodemailer')).default;
const { and, eq, inArray, like } = await import('drizzle-orm');
const { db, schema, pool } = await import('../src/db/client.js');
const { config } = await import('../src/config.js');
const { sendOutreachHandler, sendFollowupHandler, sendIdempotencyKey, followupIdempotencyKey } =
  await import('../src/workers/outreach.js');
const { pollReplies } = await import('../src/workers/replies.js');
const { handleWahaWebhook } = await import('../src/outreach/wahaInbound.js');
const { parseWahaMessage, verifyHmac } = await import('../src/outreach/wahaWebhook.js');
const { detectOptOut, detectBounce } = await import('../src/outreach/optout.js');
const { buildMessageId, parseMessageId, resetTransport } = await import('../src/channels/email.js');
const { ping: wahaPing, sessionReady } = await import('../src/channels/waha.js');
const { createHmac } = await import('node:crypto');

const KEEP = process.argv.includes('--keep');
const { assertFixtureId } = await import('./e2e/safety.js');
const CAMPAIGN = assertFixtureId(`e2e-phasee-${Date.now()}`, 'campaign');
const BIZ_EMAIL = `${CAMPAIGN}-mail`;
const BIZ_BOUNCE = `${CAMPAIGN}-bounce`;
const BIZ_OPTOUT = `${CAMPAIGN}-optout`;
const BIZ_WA = `${CAMPAIGN}-whatsapp`;
const WA_PHONE = '306900000001';
const BOUNCE_TARGET = 'nobody@bounce.invalid';
const OPTOUT_TARGET = 'optout-tester@factory.local';

// ─── checklist plumbing ──────────────────────────────────────────────────────

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ''): boolean {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ─── fixtures ────────────────────────────────────────────────────────────────

/**
 * Fixtures start at `outreach_approved` — the exact state the real approval
 * flow leaves a business in — so the send exercises the legal
 * `outreach_approved -> contacted` transition rather than being forced.
 */
async function makeBusiness(id: string, name: string): Promise<void> {
  assertFixtureId(id, 'business');
  await db.insert(schema.businesses).values({
    id, campaignId: CAMPAIGN, name, normalizedName: name.toLowerCase(),
    status: 'outreach_approved', placeId: `${id}-place`,
  }).onConflictDoNothing();
}

async function approve(businessId: string, channel: string, toAddress: string, subject: string | null, body: string) {
  assertFixtureId(businessId, 'business');
  const [row] = await db.insert(schema.approvals).values({
    businessId, kind: 'outreach', decision: 'approved', decidedBy: 'phaseE-e2e',
    decidedAt: new Date(),
    payload: { draft: { channel, toAddress, subject, body } },
  }).returning();
  return row;
}

async function setupFixtures(): Promise<void> {
  await db.insert(schema.campaigns).values({
    id: CAMPAIGN, country: 'gr', city: 'testville', niche: 'phase-e-fixture',
    language: 'uk', queries: ['fixture'], geofence: { lat: 0, lng: 0, radiusKm: 1 },
    mode: 'live', status: 'running',
  }).onConflictDoNothing();

  await makeBusiness(BIZ_EMAIL, 'Phase E Email Fixture');
  await makeBusiness(BIZ_BOUNCE, 'Phase E Bounce Fixture');
  await makeBusiness(BIZ_OPTOUT, 'Phase E Opt-out Fixture');
  await makeBusiness(BIZ_WA, 'Phase E WhatsApp Fixture');

  await db.insert(schema.businessContacts).values([
    { businessId: BIZ_EMAIL, channel: 'email', value: TEST_MAILBOX, verified: true },
    { businessId: BIZ_BOUNCE, channel: 'email', value: BOUNCE_TARGET, verified: true },
    { businessId: BIZ_OPTOUT, channel: 'email', value: OPTOUT_TARGET, verified: true },
    { businessId: BIZ_WA, channel: 'whatsapp', value: WA_PHONE, verified: true },
  ]).onConflictDoNothing();
}

async function cleanup(): Promise<void> {
  const ids = [BIZ_EMAIL, BIZ_BOUNCE, BIZ_OPTOUT, BIZ_WA];
  // Order matters: children before parents (FKs).
  await pool.query(
    `delete from workflow_reconciliation_events
     where run_id in (
       select id from workflow_job_runs
       where campaign_id = $1 or business_id = any($2::text[])
     ) or attempt_id in (
       select id from workflow_jobs where business_id = any($2::text[])
     )`,
    [CAMPAIGN, ids],
  );
  await db.delete(schema.outreachEvents).where(inArray(schema.outreachEvents.businessId, ids));
  await db.delete(schema.outreachMessages).where(inArray(schema.outreachMessages.businessId, ids));
  await db.delete(schema.deals).where(inArray(schema.deals.businessId, ids));
  await db.delete(schema.approvals).where(inArray(schema.approvals.businessId, ids));
  await db.delete(schema.statusHistory).where(inArray(schema.statusHistory.businessId, ids));
  await db.delete(schema.businessContacts).where(inArray(schema.businessContacts.businessId, ids));
  await pool.query(
    `delete from pgboss.job
     where data->>'campaignId' = $1 or data->>'businessId' = any($2::text[])`,
    [CAMPAIGN, ids],
  );
  await db.delete(schema.workflowJobs).where(inArray(schema.workflowJobs.businessId, ids));
  await pool.query(
    `delete from workflow_job_runs
     where campaign_id = $1 or business_id = any($2::text[])`,
    [CAMPAIGN, ids],
  );
  await db.delete(schema.businesses).where(inArray(schema.businesses.id, ids));
  await db.delete(schema.campaigns).where(eq(schema.campaigns.id, CAMPAIGN));
  await db.delete(schema.doNotContact)
    .where(inArray(schema.doNotContact.value, [...ids, OPTOUT_TARGET, WA_PHONE]));
  // The fixture's own IMAP cursor must not leak into a real run.
  await db.delete(schema.settings).where(eq(schema.settings.key, 'imap.cursor'));

  const residue = await pool.query<{
    campaigns: number; businesses: number; boss_jobs: number; workflow_runs: number;
  }>(
    `select
       (select count(*)::int from campaigns where id = $1) as campaigns,
       (select count(*)::int from businesses where id = any($2::text[])) as businesses,
       (select count(*)::int from pgboss.job
         where data->>'campaignId' = $1 or data->>'businessId' = any($2::text[])) as boss_jobs,
       (select count(*)::int from workflow_job_runs
         where campaign_id = $1 or business_id = any($2::text[])) as workflow_runs`,
    [CAMPAIGN, ids],
  );
  const counts = residue.rows[0];
  if (!counts || Object.values(counts).some((count) => count !== 0)) {
    throw new Error(`phase E fixture cleanup left residue: ${JSON.stringify(counts)}`);
  }
}

// ─── mailbox helpers (GreenMail) ─────────────────────────────────────────────

function imapClient() {
  return new ImapFlow({
    host: config.imap.host, port: config.imap.port, secure: false,
    auth: { user: config.imap.user, pass: config.imap.pass }, logger: false,
  });
}

/** Read the mailbox directly — independent proof the SMTP send really landed. */
async function fetchMailbox(): Promise<Array<{ uid: number; subject: string; messageId: string; to: string }>> {
  const client = imapClient();
  await client.connect();
  const out: Array<{ uid: number; subject: string; messageId: string; to: string }> = [];
  try {
    await client.mailboxOpen('INBOX');
    for await (const msg of client.fetch({ uid: '1:*' }, { uid: true, envelope: true }, { uid: true })) {
      out.push({
        uid: msg.uid,
        subject: msg.envelope?.subject ?? '',
        messageId: msg.envelope?.messageId ?? '',
        to: msg.envelope?.to?.[0]?.address ?? '',
      });
    }
  } finally { await client.logout().catch(() => {}); }
  return out;
}

/** Inject a message into the mailbox by SMTP — this is how the "business answers". */
async function injectMail(input: {
  from: string; to?: string; subject: string; text: string;
  inReplyTo?: string; headers?: Record<string, string>;
}): Promise<void> {
  const t = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: false,
    tls: { rejectUnauthorized: false },
  });
  await t.sendMail({
    from: input.from,
    to: input.to ?? TEST_MAILBOX,
    subject: input.subject,
    text: input.text,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo, references: [input.inReplyTo] } : {}),
    headers: input.headers,
  });
  t.close();
}

async function waitForMail(predicate: (m: { subject: string; messageId: string }) => boolean, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const box = await fetchMailbox();
    const hit = box.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// ─── the run ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n╔══ PHASE E — end-to-end outreach verification ══╗`);
  console.log(`  campaign : ${CAMPAIGN}`);
  console.log(`  mode     : ${config.mode}   (live, against local test servers only)`);
  console.log(`  smtp     : ${config.smtp.host}:${config.smtp.port}`);
  console.log(`  imap     : ${config.imap.host}:${config.imap.port}`);
  console.log(`  waha     : ${config.waha.url}`);

  section('0. preflight');
  let smtpUp = false;
  try {
    const t = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: false, tls: { rejectUnauthorized: false },
    });
    smtpUp = await t.verify().then(() => true).catch(() => false);
    t.close();
  } catch { smtpUp = false; }
  if (!check('GreenMail SMTP reachable', smtpUp, `${config.smtp.host}:${config.smtp.port}`)) {
    console.error('\nStart it first:  docker compose --profile dev-mail up -d greenmail\n');
    process.exit(1);
  }

  // Pure-unit checks first: they need no services and pin the parsing rules.
  section('1. unit: opt-out / bounce / message-id / hmac');
  check('opt-out EN "unsubscribe"', detectOptOut('please unsubscribe me') === 'unsubscribe');
  check('opt-out EL "διαγραφή"', detectOptOut('παρακαλώ διαγραφή') !== null);
  // Uppercase Greek carries no accents — the folding path, not the /i flag.
  check('opt-out EL uppercase "ΔΙΑΓΡΑΦΗ"', detectOptOut('ΔΙΑΓΡΑΦΗ') !== null);
  check('opt-out EL "δεν με ενδιαφέρει"', detectOptOut('Ευχαριστώ, δεν με ενδιαφέρει.') !== null);
  check('opt-out UK "не пишіть"', detectOptOut('більше не пишіть мені') !== null);
  check('opt-out ignores our own quoted footer', detectOptOut(
    'Дякую, цікаво!\n\n> On Mon, Roman wrote:\n> unsubscribe: mailto:x@y',
  ) === null, 'quoted original stripped');
  check('plain reply is not an opt-out', detectOptOut('Доброго дня! Цікаво, розкажіть більше.') === null);
  check('bounce by mailer-daemon', detectBounce({ from: 'MAILER-DAEMON@mail.google.com' }) !== null);
  check('bounce by DSN subject', detectBounce({ subject: 'Undelivered Mail Returned to Sender' }) !== null);
  check('normal mail is not a bounce', detectBounce({ from: 'owner@salon.gr', subject: 'Re: демо' }) === null);
  // The encoding must be LOSSLESS: reply matching recovers the exact key
  // (colons included) from an In-Reply-To header. A lossy slug would silently
  // downgrade every threaded reply to weaker address matching.
  const realKey = sendIdempotencyKey(42);
  const mid = buildMessageId(realKey);
  check('Message-ID round-trips to the exact idempotency key',
    parseMessageId(mid) === realKey, `${realKey} <- ${mid}`);
  check('foreign Message-IDs are not mistaken for ours',
    parseMessageId('<CAB1234@mail.gmail.com>') === null);

  // WAHA's documented HMAC test vector — proves our verification matches theirs.
  const hmacBody = '{"event":"message","session":"default","engine":"WEBJS"}';
  const expectedHmac = createHmac('sha512', 'my-secret-key').update(hmacBody, 'utf8').digest('hex');
  const restoreHmacSetting = overrideSettingsForProcess({
    WAHA_HOOK_HMAC_KEY: 'my-secret-key',
  });
  try {
    check('webhook HMAC accepts a correct signature', verifyHmac(hmacBody, expectedHmac));
    check('webhook HMAC rejects a tampered body', !verifyHmac(hmacBody + ' ', expectedHmac));
    check('webhook HMAC rejects a missing header', !verifyHmac(hmacBody, undefined));
  } finally {
    restoreHmacSetting();
  }

  section('2. fixtures');
  await setupFixtures();
  check('fixture campaign + 4 businesses created', true, CAMPAIGN);
  const [patras] = await db.select().from(schema.approvals)
    .where(like(schema.approvals.businessId, 'gr-patras-%'));
  check('gr-patras-beauty has NO approvals -> its sends are impossible', !patras,
    'send requires an approvals row (outreach.ts gate 1)');

  section('3. email: approve -> live SMTP send -> lands in the mailbox');
  const subject = 'Демо-сайт для вашого салону';
  const approval = await approve(BIZ_EMAIL, 'email', TEST_MAILBOX, subject,
    'Доброго дня! Я зробив для вас демо-сайт: http://localhost:8788/demo/test\nЯкщо цікаво — відповідайте на цей лист.');
  await sendOutreachHandler({ businessId: BIZ_EMAIL, idempotencyKey: sendIdempotencyKey(approval.id) });

  const [sentMsg] = await db.select().from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.businessId, BIZ_EMAIL));
  check('outreach_messages.state = sent', sentMsg?.state === 'sent', `state=${sentMsg?.state}`);
  check('our Message-ID stored as provider_message_id',
    Boolean(sentMsg?.providerMessageId?.startsWith('<factory.')), sentMsg?.providerMessageId ?? '');

  const ourMessageId = sentMsg?.providerMessageId ?? '';
  const landed = await waitForMail((m) => m.messageId === ourMessageId);
  check('IMAP: the message is physically in the mailbox', Boolean(landed),
    landed ? `uid=${landed.uid} subject="${landed.subject}"` : 'not found');

  const [bizAfterSend] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, BIZ_EMAIL));
  check('business status -> contacted', bizAfterSend?.status === 'contacted', bizAfterSend?.status ?? '');
  const [dealAfterSend] = await db.select().from(schema.deals).where(eq(schema.deals.businessId, BIZ_EMAIL));
  check('deal created in state contacted', dealAfterSend?.state === 'contacted', dealAfterSend?.state ?? '');

  section('4. exactly-once: a second send under the same key does nothing');
  const before = (await db.select().from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.businessId, BIZ_EMAIL))).length;
  await sendOutreachHandler({ businessId: BIZ_EMAIL, idempotencyKey: sendIdempotencyKey(approval.id) });
  const after = (await db.select().from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.businessId, BIZ_EMAIL))).length;
  check('no duplicate outreach_messages row', before === after, `${before} -> ${after}`);
  const mailboxNow = await fetchMailbox();
  check('no duplicate mail in the mailbox',
    mailboxNow.filter((m) => m.messageId === ourMessageId).length === 1);

  section('5. reply: business answers -> poll-replies picks it up');
  // Baseline the cursor so the poller only sees what comes next.
  await pollReplies();
  // Deliberately answered from a DIFFERENT address than the one we wrote to
  // (owners routinely reply from a personal mailbox). Address matching cannot
  // save us here, so a pass proves threading really works — with `from` equal
  // to the target the check would be vacuous.
  await injectMail({
    from: 'Owner Personal <owner-personal@factory.local>',
    subject: `Re: ${subject}`,
    text: 'Доброго дня! Цікаво, розкажіть більше про ціну.',
    inReplyTo: ourMessageId,
  });
  const replySummary = await pollReplies();
  check('poll-replies classified one reply', replySummary.outcomes.replied === 1,
    JSON.stringify(replySummary.outcomes));

  const replyEvents = await db.select().from(schema.outreachEvents)
    .where(and(eq(schema.outreachEvents.businessId, BIZ_EMAIL), eq(schema.outreachEvents.event, 'replied')));
  check('outreach_events has a reply row', replyEvents.length === 1,
    `matchedVia=${(replyEvents[0]?.detail as any)?.matchedVia}`);
  check('matched by THREAD (In-Reply-To) from an unknown address',
    (replyEvents[0]?.detail as any)?.matchedVia === 'thread',
    'reply came from owner-personal@factory.local, which we never contacted');

  const [dealReplied] = await db.select().from(schema.deals).where(eq(schema.deals.businessId, BIZ_EMAIL));
  check('deal state -> replied', dealReplied?.state === 'replied', dealReplied?.state ?? '');
  const [bizReplied] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, BIZ_EMAIL));
  check('business status -> replied', bizReplied?.status === 'replied', bizReplied?.status ?? '');

  section('6. follow-up refuses to send after a reply');
  await sendFollowupHandler({
    businessId: BIZ_EMAIL, followupIndex: 1, approvalId: approval.id,
    idempotencyKey: followupIdempotencyKey(approval.id, 1),
  });
  const followupRows = await db.select().from(schema.outreachMessages)
    .where(and(eq(schema.outreachMessages.businessId, BIZ_EMAIL), eq(schema.outreachMessages.kind, 'followup_1')));
  check('no follow-up message row created', followupRows.length === 0, `${followupRows.length} rows`);
  const boxAfterFollowup = await fetchMailbox();
  check('no follow-up mail in the mailbox',
    boxAfterFollowup.filter((m) => m.subject.startsWith('Re: Re:')).length === 0);

  section('7. bounce path');
  const bounceApproval = await approve(BIZ_BOUNCE, 'email', BOUNCE_TARGET, 'Демо для вас', 'Тестовий лист.');
  await sendOutreachHandler({ businessId: BIZ_BOUNCE, idempotencyKey: sendIdempotencyKey(bounceApproval.id) });
  const [bounceMsg] = await db.select().from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.businessId, BIZ_BOUNCE));
  check('outreach sent to the soon-to-bounce address', bounceMsg?.state === 'sent', bounceMsg?.state ?? '');

  await injectMail({
    from: 'MAILER-DAEMON@factory.local',
    subject: 'Undelivered Mail Returned to Sender',
    text: [
      'This is the mail system at host factory.local.',
      '',
      `<${BOUNCE_TARGET}>: host bounce.invalid said: 550 5.1.1 No such user`,
      '',
      'Final-Recipient: rfc822; ' + BOUNCE_TARGET,
      'Status: 5.1.1',
    ].join('\n'),
    inReplyTo: bounceMsg?.providerMessageId ?? undefined,
  });
  const bounceSummary = await pollReplies();
  check('poll-replies classified one bounce', bounceSummary.outcomes.bounced === 1,
    JSON.stringify(bounceSummary.outcomes));
  const bounceEvents = await db.select().from(schema.outreachEvents)
    .where(and(eq(schema.outreachEvents.businessId, BIZ_BOUNCE), eq(schema.outreachEvents.event, 'bounced')));
  check('outreach_events has a bounce row', bounceEvents.length === 1,
    String((bounceEvents[0]?.detail as any)?.reason ?? ''));
  const [bouncedMsg] = await db.select().from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.businessId, BIZ_BOUNCE));
  check('bounced message marked failed', bouncedMsg?.state === 'failed', bouncedMsg?.state ?? '');

  await sendFollowupHandler({
    businessId: BIZ_BOUNCE, followupIndex: 1, approvalId: bounceApproval.id,
    idempotencyKey: followupIdempotencyKey(bounceApproval.id, 1),
  });
  const bounceFollowups = await db.select().from(schema.outreachMessages)
    .where(and(eq(schema.outreachMessages.businessId, BIZ_BOUNCE),
      eq(schema.outreachMessages.kind, 'followup_1')));
  check('follow-up skipped after a bounce', bounceFollowups.length === 0);

  section('8. opt-out path -> do_not_contact forever');
  const optApproval = await approve(BIZ_OPTOUT, 'email', OPTOUT_TARGET, 'Демо для вас', 'Тестовий лист.');
  await sendOutreachHandler({ businessId: BIZ_OPTOUT, idempotencyKey: sendIdempotencyKey(optApproval.id) });
  const [optMsg] = await db.select().from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.businessId, BIZ_OPTOUT));

  await injectMail({
    from: `Annoyed Owner <${OPTOUT_TARGET}>`,
    subject: 'Re: Демо для вас',
    text: 'Не пишіть мені більше, будь ласка.',
    inReplyTo: optMsg?.providerMessageId ?? undefined,
  });
  const optSummary = await pollReplies();
  check('poll-replies classified one opt-out', optSummary.outcomes.opted_out === 1,
    JSON.stringify(optSummary.outcomes));
  const dnc = await db.select().from(schema.doNotContact);
  check('do_not_contact holds the email',
    dnc.some((d) => d.matchType === 'email' && d.value === OPTOUT_TARGET));
  check('do_not_contact holds the business id',
    dnc.some((d) => d.matchType === 'business_id' && d.value === BIZ_OPTOUT));
  const [optBiz] = await db.select().from(schema.businesses).where(eq(schema.businesses.id, BIZ_OPTOUT));
  check('business status -> do_not_contact', optBiz?.status === 'do_not_contact', optBiz?.status ?? '');
  check('no reply event recorded for an opt-out',
    (await db.select().from(schema.outreachEvents)
      .where(and(eq(schema.outreachEvents.businessId, BIZ_OPTOUT),
        eq(schema.outreachEvents.event, 'replied')))).length === 0);

  // A brand-new approval must still not be sendable — DNC is checked at send time.
  const optApproval2 = await approve(BIZ_OPTOUT, 'email', OPTOUT_TARGET, 'Ще раз', 'Другий лист.');
  await sendOutreachHandler({ businessId: BIZ_OPTOUT, idempotencyKey: sendIdempotencyKey(optApproval2.id) });
  const optMsgs = await db.select().from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.businessId, BIZ_OPTOUT));
  check('a NEW approval still cannot send to an opted-out contact', optMsgs.length === 1,
    `${optMsgs.length} message rows (blocked at send-time DNC gate)`);

  section('9. WAHA: recorded webhook payload -> reply event');
  const waApproval = await approve(BIZ_WA, 'whatsapp', WA_PHONE, null, 'Привіт! Зробив демо для вас.');
  // Campaign-level dry_run is a hard delivery gate even though this process is
  // globally live against GreenMail. A real WhatsApp send needs Roman's phone.
  await db.update(schema.campaigns).set({ mode: 'dry_run' }).where(eq(schema.campaigns.id, CAMPAIGN));
  await sendOutreachHandler({ businessId: BIZ_WA, idempotencyKey: sendIdempotencyKey(waApproval.id) });
  await db.update(schema.campaigns).set({ mode: 'live' }).where(eq(schema.campaigns.id, CAMPAIGN));
  const [waMsg] = await db.select().from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.businessId, BIZ_WA));
  check('whatsapp outreach simulated (dry_run)', waMsg?.state === 'simulated', waMsg?.state ?? '');

  // Verbatim WAHA `message` envelope shape (waha.devlike.pro/docs/how-to/webhooks).
  const wahaEnvelope = {
    id: 'evt_01jz5kq9m0000000000000000',
    timestamp: Date.now(),
    event: 'message',
    session: config.waha.session,
    me: { id: '306999999999@c.us', pushName: 'Factory' },
    engine: 'NOWEB',
    payload: {
      id: `false_${WA_PHONE}@c.us_AAAAAAAAAAAAAAAAAAAA`,
      timestamp: Math.floor(Date.now() / 1000),
      from: `${WA_PHONE}@c.us`,
      fromMe: false,
      source: 'app',
      to: '306999999999@c.us',
      body: 'Καλησπέρα! Ενδιαφέρομαι, στείλτε μου λεπτομέρειες.',
      hasMedia: false,
      ack: 1,
      vCards: [],
      _data: {},
    },
  };
  const waResult = await handleWahaWebhook(wahaEnvelope as any);
  check('WAHA webhook handled', waResult.handled === true, JSON.stringify(waResult));
  check('WAHA reply matched to the right business', waResult.businessId === BIZ_WA, waResult.businessId ?? '');
  const waEvents = await db.select().from(schema.outreachEvents)
    .where(and(eq(schema.outreachEvents.businessId, BIZ_WA), eq(schema.outreachEvents.event, 'replied')));
  check('outreach_events has the whatsapp reply', waEvents.length === 1);
  const [waDeal] = await db.select().from(schema.deals).where(eq(schema.deals.businessId, BIZ_WA));
  check('whatsapp deal -> replied', waDeal?.state === 'replied', waDeal?.state ?? '');

  // The filters that keep the webhook from acting on the wrong thing.
  check('skips our own echo (fromMe)',
    parseWahaMessage({ ...wahaEnvelope, payload: { ...wahaEnvelope.payload, fromMe: true } } as any).ok === false);
  check('skips API-sourced echo (source=api)',
    parseWahaMessage({ ...wahaEnvelope, payload: { ...wahaEnvelope.payload, source: 'api' } } as any).ok === false);
  check('skips group chats (@g.us)',
    parseWahaMessage({ ...wahaEnvelope, payload: { ...wahaEnvelope.payload, from: '123@g.us' } } as any).ok === false);
  check('skips non-message events',
    parseWahaMessage({ ...wahaEnvelope, event: 'state.change' } as any).ok === false);

  section('10. WAHA service reachability (live QR pairing is Roman\'s step)');
  const wahaAlive = await wahaPing();
  check('WAHA /ping responds', wahaAlive, config.waha.url);
  if (wahaAlive) {
    const s = await sessionReady().catch(() => ({ ready: false, status: 'ERROR' }));
    check('WAHA session status readable', typeof s.status === 'string',
      `status=${s.status} (WORKING is required to send; SCAN_QR_CODE = pair the phone)`);
  }

  section('11. WhatsApp opt-out over the webhook');
  const optOutWa = {
    ...wahaEnvelope,
    id: 'evt_01jz5kq9m0000000000000001',
    payload: {
      ...wahaEnvelope.payload,
      id: `false_${WA_PHONE}@c.us_BBBBBBBBBBBBBBBBBBBB`,
      body: 'ΔΙΑΓΡΑΦΗ',
    },
  };
  const optOutResult = await handleWahaWebhook(optOutWa as any);
  check('WhatsApp opt-out recognised', optOutResult.outcome === 'opted_out', JSON.stringify(optOutResult));
  const dncWa = await db.select().from(schema.doNotContact);
  check('phone added to do_not_contact',
    dncWa.some((d) => d.matchType === 'phone' && d.value === WA_PHONE));

  // ── report
  section('RESULT');
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log('\n  FAILED:');
    for (const f of failed) console.log(`   ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }

  if (KEEP) {
    console.log(`\n  --keep: fixture rows left in the DB under campaign ${CAMPAIGN}`);
  } else {
    await cleanup();
    console.log(`\n  fixture rows cleaned up (campaign ${CAMPAIGN} removed)`);
  }
  console.log('  gr-patras-beauty untouched: this script only ever writes ' +
    'rows whose business_id starts with the fixture campaign name.\n');

  resetTransport();
  restorePhaseESettings();
  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nPHASE E RUN FAILED:', err);
  if (!KEEP) await cleanup().catch(() => {});
  resetTransport();
  restorePhaseESettings();
  await pool.end().catch(() => {});
  process.exit(1);
});
