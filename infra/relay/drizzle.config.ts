import { defineConfig } from "drizzle-kit";

// MySQL migrations are generated manually and checked in (alchemy's
// Drizzle.Schema auto-generation is Postgres-only). After changing
// src/persistence/schema.ts run `pnpm exec drizzle-kit generate` and commit
// the new migrations/mysql/<timestamp>_*/ directory; deploys apply it.
export default defineConfig({
  schema: "./src/persistence/schema.ts",
  out: "./migrations/mysql",
  dialect: "mysql",
});
