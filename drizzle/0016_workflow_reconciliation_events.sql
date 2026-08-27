-- Startup reconciliation adopts compatible pre-run attempts and closes live
-- duplicates. Every such repair is durable and operator-auditable.
CREATE TABLE IF NOT EXISTS workflow_reconciliation_events (
  id serial PRIMARY KEY,
  event_type text NOT NULL,
  job_type text NOT NULL,
  idempotency_key text,
  run_id uuid REFERENCES workflow_job_runs(id),
  attempt_id integer REFERENCES workflow_jobs(id),
  boss_job_id text,
  detail jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workflow_reconciliation_run_idx
  ON workflow_reconciliation_events (run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workflow_reconciliation_created_idx
  ON workflow_reconciliation_events (created_at);
