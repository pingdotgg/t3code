import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Planetscale from "@/Planetscale/index.ts";
import * as SQL from "@/SQL/MySQL.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { makeLayerUsers, makeSqlRoutes, type UserRow } from "./routes.ts";

export const Hyperdrive = Effect.gen(function* () {
  const database = yield* Planetscale.MySQLDatabase("SqlMySQLDb", {
    name: "alchemy-sql-mysql",
    region: { slug: "us-east" },
    clusterSize: "PS_10",
  });
  // `admin` because the fixture creates its table over the wire (`/init`
  // runs raw DDL); the default branch is `main`.
  const password = yield* Planetscale.MySQLPassword("SqlMySQLPassword", {
    database,
    role: "admin",
  });
  return yield* Cloudflare.Hyperdrive.Connection("SqlMySQLEdge", {
    origin: password.origin,
    // The tests assert read-after-write; Hyperdrive's default SELECT caching
    // (~60s TTL) can serve a pre-insert empty result — and keep serving it
    // across retries — so caching is disabled for correctness assertions.
    caching: { disabled: true },
  });
});

const TABLE = "alchemy_sql_users";

const DDL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  id INT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL
)`;

class Rollback extends Data.TaggedError("Rollback")<{}> {}

/**
 * Init effect for the whole route surface: binds the Hyperdrive connection,
 * builds the `SQL.MySQL` client and the `SQL.MySQLLayer`-backed users
 * service, and returns a handler that serves the MySQL transaction routes
 * (`withTransaction` commit/rollback) before falling through to the shared
 * dialect-agnostic table.
 */
const MySQLRoutes = Effect.gen(function* () {
  const hd = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
  const sql = yield* SQL.MySQL({ url: hd.connectionString });
  const layerUsers = yield* makeLayerUsers(TABLE).pipe(
    Effect.provide(SQL.MySQLLayer({ url: hd.connectionString })),
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

    return yield* shared.handle(request);
  });

  return { handle };
});

/**
 * Effect-native Worker driving `SQL.MySQL` (the raw `@effect/sql-mysql2`
 * client) over a Hyperdrive connection to a PlanetScale MySQL origin.
 */
export default class SqlMySQLWorker extends Cloudflare.Worker<SqlMySQLWorker>()(
  "SqlMySQLWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const routes = yield* MySQLRoutes;

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
