@AGENTS.md

## Fork rules (christinoleo/t3code)

- **No numbered database migrations.** This fork merges `pingdotgg/t3code` regularly, and the migrator skips every id up to the highest recorded and refuses to start on a name mismatch (`apps/server/src/persistence/Migrations.ts`). A fork-only migration id therefore breaks startup on a later upstream merge, whatever number it uses. Create fork-only schema idempotently at server startup instead (`CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`, after the numbered migrations, backfilling only when the object was just created). Decide this yourself; it is not a reason to stop for a human.
