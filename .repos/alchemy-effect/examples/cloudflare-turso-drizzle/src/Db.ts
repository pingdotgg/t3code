import * as Drizzle from "@alchemy.run/drizzle";
import * as Turso from "@alchemy.run/turso";
import * as Effect from "effect/Effect";

/** Every tenant database lives in this group. */
export const Tenants = Turso.Group("Tenants", { location: "aws-us-east-1" });

/**
 * A migrated, empty database. New tenants are forked from it, so each one
 * starts with the current schema.
 */
export const Template = Effect.gen(function* () {
  const group = yield* Tenants;
  const schema = yield* Drizzle.Schema("NotesSchema", {
    schema: "./src/schema.ts",
    out: "./migrations",
    dialect: "sqlite",
  });
  return yield* Turso.Database("Template", {
    group: group.name,
    migrations: schema,
  });
});
