import type { Hono, MiddlewareHandler } from 'hono';
import {
  OUTREACH_CHANNELS,
  type OutreachChannel,
} from '../channels/types.js';
import type {
  ApproveOutreachInput,
  ApproveOutreachResult,
  ConfirmManualSendResult,
  OutreachDecisionService,
  RejectOutreachResult,
} from '../orchestrator/outreachDecisionService.js';

export type OutreachDecisionExecutor = Pick<
  OutreachDecisionService,
  'approve' | 'reject' | 'confirmManualSend'
>;

function approvalId(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isOutreachChannel(value: unknown): value is OutreachChannel {
  return typeof value === 'string'
    && (OUTREACH_CHANNELS as readonly string[]).includes(value);
}

function conflictStatus(result: ApproveOutreachResult | RejectOutreachResult): 404 | 409 {
  return result.kind === 'not_found' ? 404 : 409;
}

function conflictMessage(result: ApproveOutreachResult | RejectOutreachResult): string {
  if (result.kind === 'not_found') return `outreach ${result.entity} not found`;
  if (result.kind === 'already_decided') return `outreach already decided as ${result.decision}`;
  return result.kind === 'state_conflict' ? result.message : 'outreach decision conflict';
}

/** Mount approval and manual-send commands behind the shared internal auth. */
export function registerOutreachDecisionCommandRoutes(
  app: Hono,
  internalAuth: MiddlewareHandler,
  execute: OutreachDecisionExecutor,
): void {
  app.post('/internal/outreach-approvals/:approvalId/decisions', internalAuth, async (context) => {
    const id = approvalId(context.req.param('approvalId'));
    if (!id) return context.json({ ok: false, message: 'invalid approval id' }, 400);
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || (body.decision !== 'approve' && body.decision !== 'reject')) {
      return context.json({ ok: false, message: 'decision must be approve or reject' }, 400);
    }

    if (body.decision === 'reject') {
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason) return context.json({ ok: false, message: 'reason is required' }, 400);
      const result = await execute.reject(id, reason);
      if (result.kind !== 'rejected') {
        return context.json({ ok: false, message: conflictMessage(result), result }, conflictStatus(result));
      }
      return context.json({ ok: true, message: 'outreach rejected', result });
    }

    const channel = body.channel;
    const toAddress = typeof body.toAddress === 'string' ? body.toAddress.trim() : '';
    const messageBody = typeof body.body === 'string' ? body.body.trim() : '';
    if (!isOutreachChannel(channel)) {
      return context.json({ ok: false, message: 'invalid outreach channel' }, 400);
    }
    if (!toAddress) return context.json({ ok: false, message: 'toAddress is required' }, 400);
    if (!messageBody) return context.json({ ok: false, message: 'body is required' }, 400);
    const input: ApproveOutreachInput = {
      approvalId: id,
      channel,
      toAddress,
      subject: typeof body.subject === 'string' ? body.subject.trim() || null : null,
      body: messageBody,
    };
    const result = await execute.approve(input);
    if (result.kind !== 'approved') {
      return context.json({ ok: false, message: conflictMessage(result), result }, conflictStatus(result));
    }
    return context.json({
      ok: true,
      message: result.job.kind === 'accepted' ? 'outreach approved and queued' : 'outreach already queued',
      result,
    }, result.job.kind === 'accepted' ? 202 : 200);
  });

  app.post('/internal/outreach-approvals/:approvalId/manual-sent', internalAuth, async (context) => {
    const id = approvalId(context.req.param('approvalId'));
    if (!id) return context.json({ ok: false, message: 'invalid approval id' }, 400);
    const result: ConfirmManualSendResult = await execute.confirmManualSend(id);
    if (result.kind === 'confirmed') {
      return context.json({ ok: true, message: 'manual send confirmed', result });
    }
    if (result.kind === 'already_confirmed') {
      return context.json({ ok: true, message: `manual send already ${result.state}`, result });
    }
    return context.json({
      ok: false,
      message: result.kind === 'not_found'
        ? `outreach ${result.entity} not found`
        : result.message,
      result,
    }, result.kind === 'not_found' ? 404 : 409);
  });
}
