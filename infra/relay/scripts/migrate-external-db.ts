// Applies migrations/postgres to RELAY_DATABASE_URL when RELAY_DATABASE_PROVIDER=external.
// PlanetScale deploys migrate inside Alchemy; an external database migrates here, before deploy.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { runMigrations, withPgExecutor } from "@alchemy.run/sql/Migrations";
import { stripSslQueryParams } from "@alchemy.run/sql/PostgresDriver";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { relayDatabaseProviderConfig } from "../src/dbConfig.ts";

const main = Effect.gen(function* () {
  if ((yield* relayDatabaseProviderConfig) !== "external") {
    yield* Console.log("RELAY_DATABASE_PROVIDER is not external; Alchemy migrates PlanetScale.");
    return;
  }
  const url = Redacted.value(yield* Config.Redacted("RELAY_DATABASE_URL")).trim();
  // Hosted Postgres (Neon) needs verified TLS; `sslmode=disable` is for a local database.
  const tls = !/[?&]sslmode=disable(?:&|$)/u.test(url);
  const run = yield* runMigrations({
    input: {
      dir: new URL("../migrations/postgres", import.meta.url).pathname,
      table: "relay_migrations",
    },
    stamped: {},
    withExecutor: (apply) =>
      withPgExecutor(
        {
          connectionString: stripSslQueryParams(url),
          ssl: tls ? { rejectUnauthorized: true } : false,
        },
        apply,
      ),
  });
  yield* Console.log(
    `Relay database is at ${Object.keys(run.hashes).length} migrations (${run.resolved.table}).`,
  );
});

main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
