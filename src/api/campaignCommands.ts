import type { Hono, MiddlewareHandler } from 'hono';
import {
  normalizeBuildPolicy,
} from '../orchestrator/buildPolicy.js';
import type {
  CampaignCommandService,
  CreateCampaignInput,
} from '../orchestrator/campaignCommandService.js';

export type CampaignCommandExecutor = Pick<CampaignCommandService, 'create'>;

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Mount campaign creation behind the factory's shared internal auth. */
export function registerCampaignCommandRoutes(
  app: Hono,
  internalAuth: MiddlewareHandler,
  execute: CampaignCommandExecutor,
): void {
  app.post('/internal/campaigns', internalAuth, async (context) => {
    const body = await context.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return context.json({ ok: false, message: 'request body must be JSON' }, 400);
    const country = typeof body.country === 'string' ? body.country.trim() : '';
    const city = typeof body.city === 'string' ? body.city.trim() : '';
    const niche = typeof body.niche === 'string' ? body.niche.trim() : '';
    const language = typeof body.language === 'string' ? body.language.trim() : '';
    const queries = Array.isArray(body.queries)
      ? body.queries.filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim()).filter(Boolean)
      : [];
    const targetCount = finiteNumber(body.targetCount);
    const lat = finiteNumber(body.lat);
    const lng = finiteNumber(body.lng);
    const radiusKm = finiteNumber(body.radiusKm);
    if (!country || !city || !niche || !language || !queries.length) {
      return context.json({ ok: false, message: 'country, city, niche, language and queries are required' }, 400);
    }
    if (
      targetCount === null || !Number.isInteger(targetCount) || targetCount < 1 || targetCount > 10_000
      || lat === null || lat < -90 || lat > 90
      || lng === null || lng < -180 || lng > 180
      || radiusKm === null || radiusKm <= 0 || radiusKm > 1_000
    ) {
      return context.json({ ok: false, message: 'invalid campaign numeric fields' }, 400);
    }
    const input: CreateCampaignInput = {
      country,
      city,
      niche,
      language,
      queries,
      targetCount,
      geofence: { lat, lng, radiusKm },
      autoBuild: normalizeBuildPolicy(typeof body.autoBuild === 'string' ? body.autoBuild : ''),
    };
    const result = await execute.create(input);
    if (result.kind === 'exists') {
      return context.json({ ok: false, message: `campaign ${result.campaignId} already exists`, result }, 409);
    }
    return context.json({ ok: true, message: 'campaign created and discovery queued', result }, 201);
  });
}
