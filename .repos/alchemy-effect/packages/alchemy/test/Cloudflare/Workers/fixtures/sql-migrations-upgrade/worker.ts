import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Config from "effect/Config";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

class UpgradeObject extends Cloudflare.DurableObject<UpgradeObject>()(
  "SqlMigrationUpgradeObject",
  Effect.gen(function* () {
    const dir = yield* Config.String("SQL_MIGRATIONS_DIRECTORY").pipe(
      Effect.orDie,
    );
    const migrations = yield* Cloudflare.SqlMigrations(dir);
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      yield* migrations.apply().pipe(Effect.orDie);
      return {
        inspect: () =>
          Effect.gen(function* () {
            const rows = yield* state.storage.sql
              .exec<{ value: string }>("SELECT value FROM items ORDER BY rowid")
              .pipe(Effect.flatMap((cursor) => cursor.toArray()));
            return {
              id: state.id.toString(),
              count: migrations.records.length,
              rows,
            };
          }),
        insert: () =>
          state.storage.sql
            .exec("INSERT INTO items VALUES ('user-data')")
            .pipe(Effect.asVoid),
      };
    });
  }),
) {}

export default class UpgradeWorker extends Cloudflare.Worker<UpgradeWorker>()(
  "SqlMigrationUpgradeWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* UpgradeObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const object = objects.getByName("persistent");
        if (request.method === "POST") yield* object.insert();
        return yield* HttpServerResponse.json(yield* object.inspect());
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(Cause.pretty(cause), { status: 500 }),
          ),
        ),
      ),
    };
  }),
) {}
