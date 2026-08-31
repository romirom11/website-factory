/**
 * Data assembly for the approval queue.
 *
 * A queue item = a business at `site_ready` (or already approved and awaiting a
 * manual send) plus its pending approval row, demo project, audit verdict and
 * channel candidates. Everything Roman needs to decide is on one card, so he
 * never has to open a second tab to answer "why is this here".
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from './db';

export interface ChannelCandidate {
  channel: string;
  toAddress: string;
  evidence: string;
  verified: boolean;
  manual: boolean;
}

export interface ApprovalItem {
  approvalId: number | null;
  businessId: string;
  name: string;
  category: string | null;
  address: string | null;
  campaignId: string;
  status: string;
  score: number | null;
  scoreBreakdown: Record<string, number> | null;
  queueReason: string;
  websiteVerdict: string;
  websiteUrl: string | null;
  demoUrl: string | null;
  channel: string | null;
  toAddress: string | null;
  channelReason: string;
  manualChannel: boolean;
  candidates: ChannelCandidate[];
  subject: string | null;
  body: string;
  decision: string | null;
  decidedAt: Date | null;
  /** State of the outreach row keyed to this approval, when one exists. */
  sendState: string | null;
  createdAt: Date;
}

const AUTOMATED = new Set(['whatsapp', 'email']);

export async function loadApprovalQueue(): Promise<ApprovalItem[]> {
  // Pending decisions plus approved deliveries that still need operator
  // attention: manual confirmation, a known failure, or an uncertain result.
  const approvals = await db.select().from(schema.approvals)
    .where(eq(schema.approvals.kind, 'outreach'))
    .orderBy(desc(schema.approvals.createdAt));

  const relevant = approvals.filter((a) => a.decision === null || a.decision === 'approved');
  if (!relevant.length) return [];

  const businessIds = [...new Set(relevant.map((a) => a.businessId))];
  const businesses = await db.select().from(schema.businesses)
    .where(inArray(schema.businesses.id, businessIds));
  const bizById = new Map(businesses.map((b) => [b.id, b]));

  const audits = await db.select().from(schema.websiteAudits)
    .where(inArray(schema.websiteAudits.businessId, businessIds));
  const projects = await db.select().from(schema.siteProjects)
    .where(inArray(schema.siteProjects.businessId, businessIds));
  const messages = await db.select().from(schema.outreachMessages)
    .where(inArray(schema.outreachMessages.businessId, businessIds));

  const latestBy = <T extends { businessId: string }>(rows: T[], key: (r: T) => number) => {
    const m = new Map<string, T>();
    for (const r of rows) {
      const prev = m.get(r.businessId);
      if (!prev || key(r) > key(prev)) m.set(r.businessId, r);
    }
    return m;
  };
  const auditBy = latestBy(audits, (a) => a.auditedAt?.getTime() ?? 0);
  const projectBy = latestBy(projects, (p) => p.createdAt?.getTime() ?? 0);

  const items: ApprovalItem[] = [];
  const seenBusiness = new Set<string>();

  for (const a of relevant) {
    // Only the newest approval per business belongs in the queue.
    if (seenBusiness.has(a.businessId)) continue;
    seenBusiness.add(a.businessId);

    const biz = bizById.get(a.businessId);
    if (!biz) continue;

    const payload = (a.payload ?? {}) as any;
    const draft = payload.draft ?? {};
    const sendKey = `send-outreach:approval:${a.id}`;
    const sendRow = messages.find((m) => m.idempotencyKey === sendKey);

    // Only a confirmed delivery/simulation is done. Unknown and failed sends
    // stay visible because silently hiding them invites an unsafe duplicate.
    if (
      a.decision === 'approved'
      && sendRow
      && ['sent', 'delivered', 'simulated'].includes(sendRow.state)
    ) continue;
    // Approved with no row yet is still in flight, so keep it visible too.

    const audit = auditBy.get(a.businessId);
    const project = projectBy.get(a.businessId);
    const channel: string | null = draft.channel ?? null;

    items.push({
      approvalId: a.id,
      businessId: a.businessId,
      name: biz.name,
      category: biz.category,
      address: biz.address,
      campaignId: biz.campaignId,
      status: biz.status,
      score: biz.score,
      scoreBreakdown: biz.scoreBreakdown as Record<string, number> | null,
      queueReason: payload.queueReason
        ?? `${biz.status}: демо готове; поточний сайт — ${audit?.verdict ?? 'none'}`,
      websiteVerdict: payload.websiteVerdict ?? audit?.verdict ?? 'none',
      websiteUrl: biz.websiteUrl,
      demoUrl: payload.demoUrl ?? project?.deployUrl ?? null,
      channel,
      toAddress: draft.toAddress ?? null,
      channelReason: payload.channelReason ?? 'канал обрано автоматично',
      manualChannel: payload.manualChannel ?? (channel ? !AUTOMATED.has(channel) : false),
      candidates: (payload.candidates ?? []) as ChannelCandidate[],
      subject: draft.subject ?? null,
      body: draft.body ?? '',
      decision: a.decision,
      decidedAt: a.decidedAt,
      sendState: sendRow?.state ?? null,
      createdAt: a.createdAt,
    });
  }

  // Highest score first: the best lead is the one to decide on first.
  return items.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
}

/** Businesses sitting in site_ready with no approval row yet — the stage hasn't run. */
export async function loadUnrequested(): Promise<Array<{ id: string; name: string; status: string }>> {
  const pendingIds = (await db.select({ businessId: schema.approvals.businessId })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.kind, 'outreach'), isNull(schema.approvals.decision))))
    .map((r) => r.businessId);

  const rows = await db.select().from(schema.businesses)
    .where(eq(schema.businesses.status, 'site_ready'));
  return rows
    .filter((b) => !pendingIds.includes(b.id))
    .map((b) => ({ id: b.id, name: b.name, status: b.status }));
}
