-- Pruning never used this index (last scan 2026-10-16), but every DPoP proof insert maintained it.
DROP INDEX IF EXISTS "idx_relay_dpop_proofs_expires_at";--> statement-breakpoint
-- Each attempt is inserted, then completed moments later. Page headroom lets the completion,
-- which only touches unindexed columns, stay a HOT update instead of writing all three indexes.
-- Applies to pages written from now on, which is the whole table within the 1-day retention.
ALTER TABLE "relay_delivery_attempts" SET (fillfactor = 80);
