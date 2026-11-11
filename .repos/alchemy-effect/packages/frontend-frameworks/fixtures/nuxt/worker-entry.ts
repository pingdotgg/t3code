/**
 * The USER's own worker entry — the nitro entry/exports seam.
 *
 * The deploy target maps the configured `main` onto `nitro.options.entry`,
 * so nitro's rollup bundles THIS module as the worker entry: its exports are
 * the worker's exports. It wraps nitro's emitted cloudflare-module handler
 * (every framework route, API route, and asset check still works) and
 * ADDITIONALLY exports the `Counter` Durable Object class, which must live
 * on the same worker for the `COUNTER` namespace binding to resolve.
 */
import { DurableObject } from "cloudflare:workers";
// The wrappable-handler seam: nitro's cloudflare_module runtime entry,
// importable by its public specifier (bundled with the same virtuals and
// aliases as nitro's own default entry).
import nitroHandler from "nitropack/presets/cloudflare/runtime/cloudflare-module";

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

export default nitroHandler;
