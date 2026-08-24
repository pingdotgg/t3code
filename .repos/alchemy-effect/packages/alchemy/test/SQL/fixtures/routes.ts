import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Sql from "effect/unstable/sql/SqlClient";

/**
 * Dialect-agnostic route handlers exercising the full `SqlClient` constructor
 * surface through an alchemy `SQL.*` client (a `proxyChain`-wrapped client,
 * so every helper call below also regression-tests deferred-proxy replay —
 * nested fragments used to be handed to the driver as opaque proxies).
 *
 * Each fixture worker defines an init effect that pulls its own bindings,
 * builds the clients, and calls {@link makeSqlRoutes} to get the handler
 * interface; `fetch` just delegates to it.
 */
export interface SqlRoutesOptions {
  /** The `proxyChain`-wrapped client under test. */
  readonly sql: Sql.SqlClient;
  /**
   * The users service built against the generic `SqlClient` tag with
   * `SQL.D1Layer` / `SQL.PostgresLayer` provided (see {@link makeLayerUsers})
   * — proves the Layer wiring end-to-end.
   */
  readonly layerUsers: LayerUsers;
  /** Dialect-specific `CREATE TABLE IF NOT EXISTS` DDL for {@link table}. */
  readonly ddl: string;
  /** Users table name — always referenced via the `sql(table)` identifier helper. */
  readonly table: string;
}

export type UserRow = {
  id: number;
  name: string;
  email: string;
};

export interface LayerUsers {
  readonly list: Effect.Effect<ReadonlyArray<UserRow>, unknown>;
}

/**
 * A tiny cloud-agnostic service written against the generic `SqlClient` tag —
 * the idiomatic consumer of `SQL.D1Layer` / `SQL.PostgresLayer`. Fixtures
 * build it with the dialect's layer provided:
 *
 * ```typescript
 * const layerUsers = yield* makeLayerUsers(TABLE).pipe(
 *   Effect.provide(SQL.D1Layer(d1)),
 * );
 * ```
 */
export const makeLayerUsers = (
  table: string,
): Effect.Effect<LayerUsers, never, Sql.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* Sql.SqlClient;
    return {
      list: sql<UserRow>`SELECT id, name, email FROM ${sql(table)} ORDER BY id`,
    };
  });

export interface SqlRoutes {
  /**
   * Handle one request against the shared route table. Returns the response,
   * or `undefined` when the route is not part of the shared surface (so the
   * caller can fall through to its own routes / 404).
   */
  readonly handle: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse | undefined,
    unknown
  >;
}

export const makeSqlRoutes = (options: SqlRoutesOptions): SqlRoutes => {
  const { sql, layerUsers, ddl, table } = options;

  return {
    handle: Effect.fn(function* (request) {
      const [path, query] = request.url.split("?") as [
        string,
        string | undefined,
      ];
      const params = new URLSearchParams(query);

      // POST /init — `sql.unsafe` (raw DDL, no params).
      if (request.method === "POST" && path === "/init") {
        yield* sql.unsafe(ddl);
        return yield* HttpServerResponse.json({ ok: true });
      }

      // POST /reset — identifier helper `sql(table)`.
      if (request.method === "POST" && path === "/reset") {
        yield* sql`DELETE FROM ${sql(table)}`;
        return yield* HttpServerResponse.json({ ok: true });
      }

      // POST /users — single-row `sql.insert(row)` nested in an outer template
      // (the original proxyChain regression), read back with `sql.and` over
      // nested `sql\`...\`` fragments.
      if (request.method === "POST" && path === "/users") {
        const row = (yield* request.json) as UserRow;
        yield* sql`INSERT INTO ${sql(table)} ${sql.insert(row)}`;
        const rows = yield* sql`
          SELECT id, name, email FROM ${sql(table)}
          WHERE ${sql.and([sql`name = ${row.name}`, sql`email = ${row.email}`])}
        `;
        return yield* HttpServerResponse.json({ rows });
      }

      // POST /users/batch — multi-row `sql.insert(rows)`, counted back with
      // `sql.literal` (raw select-list text).
      if (request.method === "POST" && path === "/users/batch") {
        const rows = (yield* request.json) as UserRow[];
        yield* sql`INSERT INTO ${sql(table)} ${sql.insert(rows)}`;
        const [count] = yield* sql<{
          n: number;
        }>`SELECT ${sql.literal("COUNT(*) AS n")} FROM ${sql(table)}`;
        return yield* HttpServerResponse.json({ count: Number(count!.n) });
      }

      // PUT /users — single-row `sql.update(row, omit)` keyed by a bound id.
      if (request.method === "PUT" && path === "/users") {
        const row = (yield* request.json) as UserRow;
        yield* sql`
          UPDATE ${sql(table)}
          SET ${sql.update(row, ["id"])}
          WHERE id = ${row.id}
        `;
        const rows =
          yield* sql`SELECT id, name, email FROM ${sql(table)} WHERE id = ${row.id}`;
        return yield* HttpServerResponse.json({ rows });
      }

      // GET /users/in?ids=1,2 — `sql.in(column, values)`.
      if (request.method === "GET" && path === "/users/in") {
        const ids = (params.get("ids") ?? "").split(",").map(Number);
        const rows = yield* sql`
          SELECT id, name, email FROM ${sql(table)}
          WHERE ${sql.in("id", ids)}
          ORDER BY id
        `;
        return yield* HttpServerResponse.json({ rows });
      }

      // GET /users/filter?name=&email=&id= — `sql.or` over a nested `sql.and`
      // and a plain fragment (fragments nested two levels deep in arrays).
      if (request.method === "GET" && path === "/users/filter") {
        const rows = yield* sql`
          SELECT id, name, email FROM ${sql(table)}
          WHERE ${sql.or([
            sql.and([
              sql`name = ${params.get("name")}`,
              sql`email = ${params.get("email")}`,
            ]),
            sql`id = ${Number(params.get("id"))}`,
          ])}
          ORDER BY id
        `;
        return yield* HttpServerResponse.json({ rows });
      }

      // GET /users/ordered — prefix-form `sql.csv("ORDER BY", ...)` mixing a
      // raw-string clause with a fragment clause.
      if (request.method === "GET" && path === "/users/ordered") {
        const rows = yield* sql`
          SELECT id, name FROM ${sql(table)}
          ${sql.csv("ORDER BY", [sql`name DESC`, "id ASC"])}
        `;
        return yield* HttpServerResponse.json({ rows });
      }

      // GET /layer/users — the same table through the generic `SqlClient`
      // service (see makeLayerUsers).
      if (request.method === "GET" && path === "/layer/users") {
        const rows = yield* layerUsers.list;
        return yield* HttpServerResponse.json({ rows });
      }

      return undefined;
    }),
  };
};
