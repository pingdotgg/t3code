import type { QueryDatabaseClient } from "@/Cloudflare/D1/QueryDatabase.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Modality-agnostic D1 route handlers driving the Effect-native
 * {@link QueryDatabaseClient} interface. Reused by the effect-worker shell.
 * The async-worker shell drives the equivalent surface over the native
 * `D1Database` binding (see `async-worker.ts`).
 *
 * Every worker stamps its rows with a `style` value ("effect" | "async")
 * so the two workers can share one physical database. The table is shared;
 * the rows are partitioned by `style`.
 *
 *   POST /init       — db.exec(CREATE TABLE)
 *   POST /seed       — db.batch([prepare(...).bind(...), ...])
 *   POST /users      — db.prepare(...).bind(...).run()
 *   GET  /users      — db.prepare(...).all()
 *   GET  /users/:id  — db.prepare(...).bind(id).first()
 *   GET  /raw        — db.raw -> direct runtime D1Database access
 */
export const d1Routes = (db: QueryDatabaseClient, style: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const url = new URL(request.url, "http://x");

    if (request.method === "POST" && url.pathname === "/init") {
      const result = yield* db.exec(
        "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, style TEXT NOT NULL, name TEXT NOT NULL)",
      );
      return yield* HttpServerResponse.json({
        count: result.count,
        duration: result.duration,
      });
    }

    if (request.method === "POST" && url.pathname === "/seed") {
      const insert = db.prepare(
        "INSERT OR REPLACE INTO users (id, style, name) VALUES (?, ?, ?)",
      );
      const results = yield* db.batch([
        insert.bind(1, style, "alice"),
        insert.bind(2, style, "bob"),
        insert.bind(3, style, "carol"),
      ]);
      return yield* HttpServerResponse.json({
        batches: results.length,
        success: results.every((r) => r.success),
      });
    }

    if (request.method === "POST" && url.pathname === "/users") {
      const body = (yield* request.json) as { id: number; name: string };
      const result = yield* db
        .prepare(
          "INSERT OR REPLACE INTO users (id, style, name) VALUES (?, ?, ?)",
        )
        .bind(body.id, style, body.name)
        .run();
      return yield* HttpServerResponse.json({
        success: result.success,
        meta: { changes: result.meta.changes },
      });
    }

    if (request.method === "GET" && url.pathname === "/users") {
      const result = yield* db
        .prepare("SELECT id, name FROM users WHERE style = ? ORDER BY id")
        .bind(style)
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
        .prepare("SELECT id, name FROM users WHERE id = ? AND style = ?")
        .bind(id, style)
        .first<{ id: number; name: string }>();
      return yield* HttpServerResponse.json({ row });
    }

    if (request.method === "GET" && url.pathname === "/raw") {
      // `db.raw` returns the underlying Cloudflare D1Database — the escape
      // hatch libraries like Better Auth / Drizzle rely on.
      const raw = yield* db.raw;
      const result = yield* Effect.promise(() =>
        raw
          .prepare("SELECT COUNT(*) as count FROM users WHERE style = ?")
          .bind(style)
          .first<{ count: number }>(),
      );
      return yield* HttpServerResponse.json({ count: result?.count ?? 0 });
    }

    return HttpServerResponse.text("Not Found", { status: 404 });
  });
