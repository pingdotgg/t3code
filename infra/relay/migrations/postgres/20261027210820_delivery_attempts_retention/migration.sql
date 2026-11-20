-- Alchemy runs migrations in a transaction, so CONCURRENTLY is unavailable here. Build
-- idx_relay_delivery_attempts_created concurrently before deploying so this is a no-op.
DROP INDEX IF EXISTS "idx_relay_delivery_attempts_environment";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_relay_agent_activity_rows_updated";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_relay_environment_credentials_environment";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_relay_delivery_attempts_created" ON "relay_delivery_attempts" ("created_at");
