ALTER TABLE "outreach_messages"
  ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE INDEX "outreach_budget_sent_idx"
  ON "outreach_messages" USING btree ("sent_at")
  WHERE "channel" in ('email', 'whatsapp')
    AND "state" in ('sent', 'delivered', 'simulated', 'delivery_unknown');
--> statement-breakpoint
CREATE INDEX "outreach_budget_queued_idx"
  ON "outreach_messages" USING btree ("created_at")
  WHERE "channel" in ('email', 'whatsapp')
    AND "state" = 'queued';
