import type { AsyncWorkerEnv } from "./stack.ts";

const STYLE = "async";

/**
 * Async (non-Effect) Worker fixture. The shared D1 database is declared on
 * the Worker `env` as `DB` (see `stack.ts`); `InferEnv` maps the
 * `Cloudflare.D1.Database` marker to the native `cf.D1Database`, so the
 * handler calls `env.DB.prepare(...)` / `env.DB.exec(...)` / `env.DB.batch(...)`
 * directly — proving the engine injected the native binding into `env`.
 *
 * Drives the same SQL surface as the effect-worker, stamping rows with
 * `style = "async"`. Mirrors the route contract in `routes.ts`.
 */
export default {
  async fetch(request: Request, env: AsyncWorkerEnv): Promise<Response> {
    const url = new URL(request.url, "http://x");
    const db = env.DB;

    if (request.method === "POST" && url.pathname === "/init") {
      const result = await db.exec(
        "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, style TEXT NOT NULL, name TEXT NOT NULL)",
      );
      return Response.json({ count: result.count, duration: result.duration });
    }

    if (request.method === "POST" && url.pathname === "/seed") {
      const insert = db.prepare(
        "INSERT OR REPLACE INTO users (id, style, name) VALUES (?, ?, ?)",
      );
      const results = await db.batch([
        insert.bind(1, STYLE, "alice"),
        insert.bind(2, STYLE, "bob"),
        insert.bind(3, STYLE, "carol"),
      ]);
      return Response.json({
        batches: results.length,
        success: results.every((r) => r.success),
      });
    }

    if (request.method === "POST" && url.pathname === "/users") {
      const body = (await request.json()) as { id: number; name: string };
      const result = await db
        .prepare(
          "INSERT OR REPLACE INTO users (id, style, name) VALUES (?, ?, ?)",
        )
        .bind(body.id, STYLE, body.name)
        .run();
      return Response.json({
        success: result.success,
        meta: { changes: result.meta.changes },
      });
    }

    if (request.method === "GET" && url.pathname === "/users") {
      const result = await db
        .prepare("SELECT id, name FROM users WHERE style = ? ORDER BY id")
        .bind(STYLE)
        .all<{ id: number; name: string }>();
      return Response.json({
        success: result.success,
        results: result.results,
      });
    }

    const userMatch = url.pathname.match(/^\/users\/(\d+)$/);
    if (request.method === "GET" && userMatch) {
      const id = Number(userMatch[1]);
      const row = await db
        .prepare("SELECT id, name FROM users WHERE id = ? AND style = ?")
        .bind(id, STYLE)
        .first<{ id: number; name: string }>();
      return Response.json({ row });
    }

    if (request.method === "GET" && url.pathname === "/raw") {
      const result = await db
        .prepare("SELECT COUNT(*) as count FROM users WHERE style = ?")
        .bind(STYLE)
        .first<{ count: number }>();
      return Response.json({ count: result?.count ?? 0 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
