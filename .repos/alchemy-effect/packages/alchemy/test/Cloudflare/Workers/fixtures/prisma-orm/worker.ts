import * as Cloudflare from "@/Cloudflare/index.ts";
import * as PrismaPostgres from "@/Prisma/ORM/Postgres.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { contract } from "./contract.ts";
import { Hyperdrive } from "./db.ts";

/**
 * Worker exercising the Prisma ORM v8 Effect client on workerd. The client is
 * created once at init (no I/O — Prisma connects lazily), and each fetch
 * event builds (and closes) its own `pg` pool against its per-event scope via
 * the execution memo. The test hammers the query routes sequentially and
 * concurrently to pin cross-request pool isolation: no "Cannot perform I/O on
 * behalf of a different request", no "Cannot use a pool after calling end".
 *
 * Routes cover the Effect-native surfaces: the orm lane (`yield*` directly),
 * the pure sql builder lane through `db.execute`, transactions with typed
 * rollback, and the typed error taxonomy.
 */
export default class PrismaOrmWorker extends Cloudflare.Worker<PrismaOrmWorker>()(
  "PrismaOrmWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
    const db = yield* PrismaPostgres.Postgres(conn.connectionString, {
      contract,
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/widgets/create/")) {
          const name = request.url.split("/widgets/create/")[1] ?? "unnamed";
          const widget = yield* db.orm.public.Widget.create({ name }).pipe(
            Effect.orDie,
          );
          return yield* HttpServerResponse.json({
            id: widget.id,
            name: widget.name,
          });
        }

        if (request.url.startsWith("/widgets/get/")) {
          const id = Number(request.url.split("/widgets/get/")[1] ?? "0");
          const widget = yield* db.orm.public.Widget.where({ id })
            .first()
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            found: widget !== null,
            name: widget?.name ?? null,
          });
        }

        if (request.url.startsWith("/widgets/prepared/")) {
          const id = Number(request.url.split("/widgets/prepared/")[1] ?? "0");
          const query = yield* db
            .prepare({ id: "pg/int4@1" }, (sql, params) =>
              sql.public.widget
                .select("id", "name")
                .where((fields, fns) => fns.eq(fields.id, params.id))
                .build(),
            )
            .pipe(Effect.orDie);
          const rows = yield* query.query({ id }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            found: rows.length === 1,
            name: rows[0]?.name ?? null,
          });
        }

        if (request.url.startsWith("/widgets/sql")) {
          // Pure plan built by the static sql lane, run by the Effect executor.
          const rows = yield* db
            .execute(db.sql.public.widget.select("id", "name").build())
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ count: rows.length });
        }

        if (request.url.startsWith("/widgets/tx/")) {
          const name = request.url.split("/widgets/tx/")[1] ?? "tx-widget";
          // Round-trip a transaction: create + read back inside one tx.
          const readBack = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const created = yield* tx.orm.public.Widget.create({ name });
                return yield* tx.orm.public.Widget.where({
                  id: created.id,
                }).first();
              }),
            )
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            name: readBack?.name ?? null,
          });
        }

        if (request.url.startsWith("/widgets/rollback/")) {
          const name = request.url.split("/widgets/rollback/")[1] ?? "nope";
          const outcome = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.orm.public.Widget.create({ name });
                return yield* tx.rollback();
              }),
            )
            .pipe(
              Effect.as("committed" as const),
              Effect.catchTag("Prisma.RollbackError", () =>
                Effect.succeed("rolled-back" as const),
              ),
              Effect.orDie,
            );
          // Prove the write did not survive the rollback.
          const after = yield* db.orm.public.Widget.where({ name })
            .first()
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            outcome,
            visible: after !== null,
          });
        }

        if (request.url.startsWith("/widgets/error")) {
          // A duplicate-free probe of the typed taxonomy: querying with a
          // NaN id fails in the encode/query pipeline — the typed tags must
          // surface (not a defect).
          const outcome = yield* db.orm.public.Widget.where({
            id: Number.NaN,
          })
            .first()
            .pipe(
              Effect.as("ok" as const),
              Effect.catchTag(
                [
                  "Prisma.UnknownError",
                  "Prisma.QueryError",
                  "Prisma.OrmError",
                  "Prisma.RuntimeError",
                ],
                (error) => Effect.succeed(`caught:${error._tag}`),
              ),
              Effect.orDie,
            );
          return HttpServerResponse.text(String(outcome));
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
