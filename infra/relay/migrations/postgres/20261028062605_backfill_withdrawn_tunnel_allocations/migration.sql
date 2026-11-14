-- Teardown claims used to bump updated_at past the link's revoke or publish-only write, so a
-- failed deprovision now reads as an unfinished relink. Give those rows the updated_at the
-- current write rule would have left. Touches only withdrawn links' live tunnels; idempotent.
UPDATE "relay_managed_endpoint_allocations" AS a
SET "updated_at" = l."updated_at"
FROM "relay_environment_links" AS l
WHERE l."user_id" = a."user_id"
  AND l."environment_id" = a."environment_id"
  AND a."tunnel_id" IS NOT NULL
  AND a."tunnel_released_at" IS NULL
  AND (l."revoked_at" IS NOT NULL OR l."managed_tunnels_enabled" = false)
  AND l."updated_at" < a."updated_at";
