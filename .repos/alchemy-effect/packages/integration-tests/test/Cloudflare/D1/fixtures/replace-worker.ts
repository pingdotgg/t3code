import type { D1Database } from "@cloudflare/workers-types";

/**
 * Async Worker bound to a D1 database as `DB`, used by the
 * same-name replacement test in `Database.test.ts`. `/write` inserts a row
 * and `/read` counts them, so the test can prove which physical database
 * the deployed binding points at.
 */
export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/write") {
      await env.DB.exec("CREATE TABLE IF NOT EXISTS entries (v TEXT NOT NULL)");
      await env.DB.prepare("INSERT INTO entries (v) VALUES ('hello')").run();
      return new Response("ok");
    }
    if (url.pathname === "/read") {
      const row = await env.DB.prepare("SELECT count(*) AS n FROM entries").first<{
        n: number;
      }>();
      return Response.json({ rows: row?.n ?? 0 });
    }
    return new Response("not found", { status: 404 });
  },
};
