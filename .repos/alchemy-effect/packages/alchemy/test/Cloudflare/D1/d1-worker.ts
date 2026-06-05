import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * D1 database created at deploy time and bound to the worker via
 * `Cloudflare.D1Connection.bind(...)`. The handlers below exercise
 * the full surface area of the Effect-native D1 client:
 *
 *   POST /init       — `db.exec("CREATE TABLE ...")`
 *   POST /seed       — `db.batch([prepare(...).bind(...), ...])`
 *   POST /users      — `db.prepare(...).bind(...).run()`
 *   GET  /users      — `db.prepare(...).all()`
 *   GET  /users/:id  — `db.prepare(...).bind(id).first()`
 *   GET  /raw        — `db.raw` -> direct runtime D1Database access
 */
export const TestDatabase = Cloudflare.D1Database("D1WorkerDatabase");

export default class D1Worker extends Cloudflare.Worker<D1Worker>()(
  "D1EffectWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const database = yield* TestDatabase;
    const db = yield* Cloudflare.D1Connection.bind(database);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "POST" && url.pathname === "/init") {
          const result = yield* db.exec(
            "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
          );
          return yield* HttpServerResponse.json({
            count: result.count,
            duration: result.duration,
          });
        }

        if (request.method === "POST" && url.pathname === "/seed") {
          const insert = db.prepare(
            "INSERT INTO users (id, name) VALUES (?, ?)",
          );
          const results = yield* db.batch([
            insert.bind(1, "alice"),
            insert.bind(2, "bob"),
            insert.bind(3, "carol"),
          ]);
          return yield* HttpServerResponse.json({
            batches: results.length,
            success: results.every((r) => r.success),
          });
        }

        if (request.method === "POST" && url.pathname === "/users") {
          const body = (yield* request.json) as { id: number; name: string };
          const result = yield* db
            .prepare("INSERT INTO users (id, name) VALUES (?, ?)")
            .bind(body.id, body.name)
            .run();
          return yield* HttpServerResponse.json({
            success: result.success,
            meta: { changes: result.meta.changes },
          });
        }

        if (request.method === "GET" && url.pathname === "/users") {
          const result = yield* db
            .prepare("SELECT id, name FROM users ORDER BY id")
            .all<{ id: number; name: string }>();
          return yield* HttpServerResponse.json({
            success: result.success,
            results: result.results,
          });
        }

        const userMatch = url.pathname.match(/^\/users\/(\d+)$/);
        if (request.method === "GET" && userMatch) {
          const id = Number(userMatch[1]);
          const row = yield* db
            .prepare("SELECT id, name FROM users WHERE id = ?")
            .bind(id)
            .first<{ id: number; name: string }>();
          return yield* HttpServerResponse.json({ row });
        }

        if (request.method === "GET" && url.pathname === "/raw") {
          // `db.raw` returns the underlying Cloudflare D1Database.
          // Run a prepared statement directly on it to prove `raw`
          // resolves to a working binding (this is the escape hatch
          // libraries like Better Auth/Drizzle rely on).
          const raw = yield* db.raw;
          const result = yield* Effect.promise(() =>
            raw.prepare("SELECT COUNT(*) as count FROM users").first<{
              count: number;
            }>(),
          );
          return yield* HttpServerResponse.json({ count: result?.count ?? 0 });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.D1ConnectionLive)),
) {}
