-- Logical workflow runs own idempotency; workflow_jobs records physical
-- pg-boss attempts. Existing attempt rows remain valid with NULL linkage until
-- startup reconciliation adopts or closes them.
CREATE TABLE IF NOT EXISTS workflow_job_runs (
  id uuid PRIMARY KEY,
  job_type text NOT NULL,
  idempotency_key text NOT NULL,
  business_id text,
  campaign_id text,
  status text NOT NULL DEFAULT 'queued',
  current_attempt_sequence integer NOT NULL DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_active_idem_idx
  ON workflow_job_runs (job_type, idempotency_key)
  WHERE status IN ('queued', 'running', 'retry_wait');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workflow_runs_status_idx ON workflow_job_runs (status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workflow_runs_business_idx ON workflow_job_runs (business_id);
--> statement-breakpoint
ALTER TABLE workflow_jobs ADD COLUMN IF NOT EXISTS run_id uuid;
--> statement-breakpoint
ALTER TABLE workflow_jobs ADD COLUMN IF NOT EXISTS attempt_sequence integer;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE workflow_jobs
    ADD CONSTRAINT workflow_jobs_run_id_workflow_job_runs_id_fk
    FOREIGN KEY (run_id) REFERENCES workflow_job_runs(id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS job_run_idx ON workflow_jobs (run_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS job_run_sequence_idx
  ON workflow_jobs (run_id, attempt_sequence)
  WHERE run_id IS NOT NULL;
