import * as Drizzle from "alchemy/Drizzle/Postgres";
import * as Fly from "alchemy/Fly";
import { eq, sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { relations, Users } from "./schema.ts";
import { API_PORT, Db, MIGRATE_TOKEN, Site } from "./shared.ts";

/**
 * HTTP Service that binds Managed Postgres via {@link Fly.ConnectPostgres}
 * and queries through Drizzle.
 *
 * Also exposes `POST /migrate`: MPG is only reachable on the org's private
 * network, so DDL is applied through this in-network Service — the deploy
 * (or test) posts the generated migration SQL here instead of connecting
 * to the cluster directly.
 */
export default class Api extends Fly.Service<Api>()(
  "Api",
  {
    app: Site,
    main: import.meta.url,
    region: "iad",
    port: API_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
    // `pg` is CommonJS — bundling it breaks `Client` under Rolldown's
    // interop. Install it into the image so `@effect/sql-pg` /
    // `Drizzle.Postgres` load it with Node's CJS semantics.
    build: { install: ["pg"] },
  },
  Effect.gen(function* () {
    const conn = yield* Fly.ConnectPostgres(Db);
    const db = yield* Drizzle.Postgres(conn.connectionString, {
      relations,
    });
    // DDL and other session-scoped statements need the direct
    // (non-PgBouncer) connection.
    const directDb = yield* Drizzle.Postgres(conn.directConnectionString);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        if (path === "/migrate" && request.method === "POST") {
          if (request.headers["x-migrate-token"] !== MIGRATE_TOKEN) {
            return yield* HttpServerResponse.json(
              { error: "unauthorized" },
              { status: 401 },
            );
          }
          // drizzle-kit emits one file per migration with statements
          // separated by `--> statement-breakpoint`. Apply each statement,
          // tolerating re-runs (the client retries through service warmup,
          // so a statement may already have been applied).
          const body = yield* request.text;
          const statements = body
            .split("--> statement-breakpoint")
            .map((statement) => statement.trim())
            .filter((statement) => statement.length > 0);
          for (const statement of statements) {
            yield* directDb.execute(sql.raw(statement)).pipe(
              Effect.catch((error) =>
                String(error).includes("already exists")
                  ? Effect.void
                  : Effect.fail(error),
              ),
            );
          }
          return yield* HttpServerResponse.json({
            applied: statements.length,
          });
        }
        if (path === "/health") {
          const users = yield* db.select().from(Users);
          return yield* HttpServerResponse.json({
            ok: true,
            users: users.length,
          });
        }
        switch (request.method) {
          case "GET": {
            if (path === "/" || path === "/users") {
              const users = yield* db.select().from(Users);
              return yield* HttpServerResponse.json({ users });
            }
            const id = Number(path.split("/").pop());
            if (Number.isNaN(id)) {
              return yield* HttpServerResponse.json(
                { error: "Invalid user ID" },
                { status: 400 },
              );
            }
            const user = yield* db.query.Users.findFirst({
              where: { id },
              with: { posts: true },
            });
            return yield* HttpServerResponse.json({ user });
          }
          case "POST": {
            const user = yield* db
              .insert(Users)
              .values({
                name: crypto.randomUUID(),
                email: crypto.randomUUID(),
              })
              .returning();
            return yield* HttpServerResponse.json({ user });
          }
          case "DELETE": {
            const id = Number(path.split("/").pop());
            if (Number.isNaN(id)) {
              return yield* HttpServerResponse.json(
                { error: "Invalid user ID" },
                { status: 400 },
              );
            }
            const [user] = yield* db
              .delete(Users)
              .where(eq(Users.id, id))
              .returning();
            return yield* HttpServerResponse.json({ user });
          }
          default: {
            return yield* HttpServerResponse.json(
              { error: "Method not allowed" },
              { status: 405 },
            );
          }
        }
      }).pipe(
        Effect.catch((cause: unknown) =>
          HttpServerResponse.json(
            { ok: false, error: String(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Fly.ConnectPostgresHttp)),
) {}
