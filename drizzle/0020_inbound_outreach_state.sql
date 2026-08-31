ALTER TABLE "outreach_events"
  ADD COLUMN "idempotency_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_event_idem_idx"
  ON "outreach_events" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "dnc_email_normalized_idx"
  ON "do_not_contact" USING btree (lower(trim("value")))
  WHERE "match_type" = 'email';
--> statement-breakpoint
CREATE INDEX "dnc_phone_normalized_idx"
  ON "do_not_contact" USING btree (regexp_replace("value", '[^0-9]', '', 'g'))
  WHERE "match_type" = 'phone';
