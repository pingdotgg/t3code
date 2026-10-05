import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export const implementation = Effect.gen(function* () {
  const migrations = yield* Cloudflare.SqlMigrations({
    dir: "./migrations",
    table: "node_loader_history",
  });
  return Effect.succeed({
    captured: () => Effect.succeed(migrations),
  });
});

export default class SqlMigrationsUnitObject extends Cloudflare.DurableObject<SqlMigrationsUnitObject>()(
  "SqlMigrationsUnitObject",
  implementation,
) {}
