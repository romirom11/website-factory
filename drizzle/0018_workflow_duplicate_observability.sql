-- An enqueue collision is successful idempotency, not an error. Persist its
-- count on the canonical run so the operator can see that commands were
-- intentionally collapsed instead of disappearing into process logs.
ALTER TABLE workflow_job_runs
  ADD COLUMN IF NOT EXISTS duplicate_suppressions integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE workflow_job_runs
  ADD COLUMN IF NOT EXISTS last_duplicate_at timestamp;
