-- Durable join barrier for the two enrichment evidence branches. A generation
-- can enqueue scoring only once, after both assets and audit have succeeded.
CREATE TABLE IF NOT EXISTS enrichment_runs (
  id uuid PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id),
  campaign_id text NOT NULL REFERENCES campaigns(id),
  generation integer NOT NULL,
  source text NOT NULL DEFAULT 'native',
  status text NOT NULL DEFAULT 'running',
  assets_status text NOT NULL DEFAULT 'pending',
  audit_status text NOT NULL DEFAULT 'pending',
  blocking_reason text,
  score_enqueued_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp,
  CONSTRAINT enrichment_runs_status_check
    CHECK (status IN ('running', 'score_enqueued', 'completed', 'blocked', 'superseded')),
  CONSTRAINT enrichment_runs_source_check
    CHECK (source IN ('native', 'legacy')),
  CONSTRAINT enrichment_runs_assets_status_check
    CHECK (assets_status IN ('pending', 'succeeded', 'failed', 'blocked')),
  CONSTRAINT enrichment_runs_audit_status_check
    CHECK (audit_status IN ('pending', 'succeeded', 'failed', 'blocked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS enrichment_runs_business_generation_idx
  ON enrichment_runs (business_id, generation);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS enrichment_runs_current_business_idx
  ON enrichment_runs (business_id)
  WHERE status IN ('running', 'score_enqueued');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS enrichment_runs_status_idx ON enrichment_runs (status);
