/**
 * The user's own worker entry — the whole point of this fixture.
 *
 * It wraps waku's emitted fetch handler (so every framework route still
 * works) and ADDITIONALLY exports the `Counter` Durable Object class, which
 * must live on the same worker for the `COUNTER` namespace binding to
 * resolve. This mirrors alchemy's Website.Vite "Custom Worker Entry"
 * pattern (`main: "worker/index.ts"` re-exporting DO classes).
 *
 * `virtual:waku/server-entry` is the import seam for waku's server handler
 * (waku's real entry, `dist/lib/vite-entries/entry.server.js`, is not on
 * waku's exports map, so the integration exposes it — the same way React
 * Router exposes `virtual:react-router/server-build`).
 */
import { DurableObject } from "cloudflare:workers";
import wakuHandler from "virtual:waku/server-entry";

/** A SQLite-backed Durable Object owned by the user app, not the framework. */
export class Counter extends DurableObject {
  #ensureTable() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
    );
  }

  async get(): Promise<number> {
    this.#ensureTable();
    const rows = this.ctx.storage.sql.exec("SELECT value FROM counter WHERE id = 0").toArray();
    return Number(rows[0]?.value ?? 0);
  }

  async increment(): Promise<number> {
    this.#ensureTable();
    const rows = this.ctx.storage.sql
      .exec(
        "INSERT INTO counter (id, value) VALUES (0, 1) ON CONFLICT (id) DO UPDATE SET value = value + 1 RETURNING value",
      )
      .toArray();
    return Number(rows[0]!.value);
  }
}

export default {
  fetch: (request: Request, env: unknown, ctx: unknown) => wakuHandler.fetch(request, env, ctx),
};
