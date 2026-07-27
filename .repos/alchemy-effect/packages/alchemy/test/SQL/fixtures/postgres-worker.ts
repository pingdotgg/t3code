import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as SQL from "@/SQL/Postgres.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { makeLayerUsers, makeSqlRoutes, type UserRow } from "./routes.ts";

export const Hyperdrive = Effect.gen(function* () {
  const project = yield* Neon.Project("SqlPostgresProject");
  return yield* Cloudflare.Hyperdrive.Connection("SqlPostgresEdge", {
    origin: project.origin,
    // The tests assert read-after-write; Hyperdrive's default SELECT caching
    // (~60s TTL) can serve a pre-insert empty result — and keep serving it
    // across retries — so caching is disabled for correctness assertions.
    caching: { disabled: true },
  });
});

const TABLE = "alchemy_sql_users";

const DDL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  id INT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL
)`;

class Rollback extends Data.TaggedError("Rollback")<{}> {}

/**
 * Init effect for the whole route surface: binds the Hyperdrive connection,
 * builds the `SQL.Postgres` client and the `SQL.PostgresLayer`-backed users
 * service, and returns a handler that serves the Postgres-only routes
 * (`withTransaction` commit/rollback, multi-row `sql.updateValues`) before
 * falling through to the shared dialect-agnostic table.
 */
const PostgresRoutes = Effect.gen(function* () {
  const hd = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
  const sql = yield* SQL.Postgres({ url: hd.connectionString });
  const layerUsers = yield* makeLayerUsers(TABLE).pipe(
    Effect.provide(SQL.PostgresLayer({ url: hd.connectionString })),
  );
  const shared = makeSqlRoutes({ sql, layerUsers, ddl: DDL, table: TABLE });

  const handle = Effect.fn(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    // POST /tx/commit — statements inside `withTransaction` share one
    // transaction and commit together.
    if (request.method === "POST" && request.url === "/tx/commit") {
      const rows = (yield* request.json) as UserRow[];
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const row of rows) {
            yield* sql`INSERT INTO ${sql(TABLE)} ${sql.insert(row)}`;
          }
        }),
      );
      const inserted = yield* sql`
        SELECT id, name, email FROM ${sql(TABLE)}
        WHERE ${sql.in(
          "id",
          rows.map((r) => r.id),
        )}
        ORDER BY id
      `;
      return yield* HttpServerResponse.json({ rows: inserted });
    }

    // POST /tx/rollback — a failure inside `withTransaction` rolls the
    // insert back; the row must not be visible afterwards.
    if (request.method === "POST" && request.url === "/tx/rollback") {
      const row = (yield* request.json) as UserRow;
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO ${sql(TABLE)} ${sql.insert(row)}`;
            return yield* Effect.fail(new Rollback());
          }),
        )
        .pipe(Effect.flip);
      const rows =
        yield* sql`SELECT id FROM ${sql(TABLE)} WHERE id = ${row.id}`;
      return yield* HttpServerResponse.json({
        error: (error as { _tag: string })._tag,
        rows,
      });
    }

    // PUT /users/values — multi-row `sql.updateValues` (not supported on
    // sqlite/D1, so it lives here rather than in the shared routes).
    if (request.method === "PUT" && request.url === "/users/values") {
      const rows = (yield* request.json) as UserRow[];
      // `updateValues` binds every value as text — cast the join key back
      // to int so `integer = text` doesn't reject the statement.
      yield* sql`
        UPDATE ${sql(TABLE)} AS t
        SET name = data.name, email = data.email
        FROM ${sql.updateValues(rows, "data")}
        WHERE t.id = data.id::int
      `;
      const updated = yield* sql`
        SELECT id, name, email FROM ${sql(TABLE)}
        WHERE ${sql.in(
          "id",
          rows.map((r) => r.id),
        )}
        ORDER BY id
      `;
      return yield* HttpServerResponse.json({ rows: updated });
    }

    return yield* shared.handle(request);
  });

  return { handle };
});

/**
 * Effect-native Worker driving `SQL.Postgres` (the raw `@effect/sql-pg`
 * client) over a Hyperdrive connection to a Neon Postgres origin.
 */
export default class SqlPostgresWorker extends Cloudflare.Worker<SqlPostgresWorker>()(
  "SqlPostgresWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const routes = yield* PostgresRoutes;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const response = yield* routes.handle(request);
        if (response !== undefined) {
          return response;
        }
        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
