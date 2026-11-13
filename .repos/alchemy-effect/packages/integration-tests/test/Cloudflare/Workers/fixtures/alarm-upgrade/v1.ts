import { DurableObject } from "cloudflare:workers";
import type {
  Column,
  Delivery,
  LegacyRow,
  SchemaObject,
  SchemaVersion,
  Snapshot,
} from "./types.ts";

// Freeze the pre-callback scheduler; importing Alchemy here would weaken the upgrade test.
export class UpgradeObject extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS alchemy_scheduled_events (
        id TEXT PRIMARY KEY,
        run_at INTEGER NOT NULL,
        repeat_ms INTEGER,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_alchemy_scheduled_events_run_at
        ON alchemy_scheduled_events (run_at);
    `);
    ctx.blockConcurrencyWhile(async () => {
      const constructors = (await ctx.storage.get<string[]>("constructors")) ?? [];
      await ctx.storage.put("constructors", [...constructors, "v1"]);
    });
  }

  private reconcileAlarm() {
    const next = this.ctx.storage.sql
      .exec<{ run_at: number | null }>("SELECT MIN(run_at) AS run_at FROM alchemy_scheduled_events")
      .one().run_at;
    return next === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(next);
  }

  async seed(proof = true) {
    if (await this.ctx.storage.get("marker")) {
      throw new Error("Upgrade fixture must start with an unseeded object");
    }
    await this.ctx.storage.put("marker", "written-by-v1");
    const now = Date.now();
    for (const [id, runAt, repeatMs] of [
      ["v1-proof", now + 500, null],
      ["legacy-one", now + 300_000, null],
      ["legacy-repeat", now + 301_000, 2_000],
      ["legacy-cancel", now + 302_000, null],
    ] as const) {
      if (id === "v1-proof" && !proof) continue;
      this.ctx.storage.sql.exec(
        `INSERT INTO alchemy_scheduled_events (id, run_at, repeat_ms, payload)
         VALUES (?, ?, ?, ?)`,
        id,
        runAt,
        repeatMs,
        JSON.stringify({ callback: "archive", value: id }),
      );
    }
    await this.reconcileAlarm();
    return this.snapshot();
  }

  async alarm() {
    const now = Date.now();
    const due = this.ctx.storage.sql
      .exec<LegacyRow>(
        "SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events WHERE run_at <= ? ORDER BY run_at ASC",
        now,
      )
      .toArray();
    const deliveries = (await this.ctx.storage.get<Delivery[]>("deliveries")) ?? [];
    for (const event of due) {
      if (event.repeat_ms !== null) {
        this.ctx.storage.sql.exec(
          "UPDATE alchemy_scheduled_events SET run_at = ? WHERE id = ?",
          now + event.repeat_ms,
          event.id,
        );
      } else {
        this.ctx.storage.sql.exec("DELETE FROM alchemy_scheduled_events WHERE id = ?", event.id);
      }
      deliveries.push({
        version: "v1",
        channel: "legacy",
        id: event.id,
        payload: JSON.parse(event.payload),
      });
    }
    await this.ctx.storage.put("deliveries", deliveries);
    await this.reconcileAlarm();
  }

  async snapshot(): Promise<Snapshot> {
    const schema = this.ctx.storage.sql
      .exec<SchemaObject>(
        "SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'alchemy_%' OR name LIKE 'idx_alchemy_%' ORDER BY name",
      )
      .toArray();
    const schemaRows = schema.some((row) => row.name === "alchemy_alarm_schema")
      ? this.ctx.storage.sql
          .exec<SchemaVersion>("SELECT id, version FROM alchemy_alarm_schema ORDER BY id")
          .toArray()
      : [];
    return {
      schema,
      schemaRows,
      schemaVersion: schemaRows[0]?.version ?? null,
      version: "v1",
      id: this.ctx.id.toString(),
      marker: (await this.ctx.storage.get<string>("marker")) ?? null,
      constructors: (await this.ctx.storage.get<string[]>("constructors")) ?? [],
      legacyRows: this.ctx.storage.sql
        .exec<LegacyRow>(
          "SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events ORDER BY id",
        )
        .toArray(),
      legacyColumns: this.ctx.storage.sql
        .exec<Column>(
          "SELECT name, type, \"notnull\", pk FROM pragma_table_info('alchemy_scheduled_events') ORDER BY cid",
        )
        .toArray(),
      callbacks: [],
      tables: this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'alchemy_%' ORDER BY name",
        )
        .toArray()
        .map((row) => row.name),
      alarm: await this.ctx.storage.getAlarm(),
      deliveries: (await this.ctx.storage.get<Delivery[]>("deliveries")) ?? [],
    };
  }
}

export default {
  async fetch(request: Request, env: { UpgradeObject: DurableObjectNamespace<UpgradeObject> }) {
    if (
      request.headers.get("x-alarm-worker-version") !== null &&
      request.headers.get("x-alarm-worker-version") !== "v1"
    ) {
      return new Response("Alarm worker version mismatch", {
        status: 409,
        headers: { "x-alarm-worker-version": "v1" },
      });
    }
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "persisted-object";
    const object = env.UpgradeObject.getByName(name);
    const path = url.pathname;
    if (path === "/seed" && request.method === "POST") {
      return Response.json(await object.seed(name === "persisted-object"));
    }
    if (path === "/snapshot") {
      return Response.json(await object.snapshot());
    }
    return new Response("Not Found", { status: 404 });
  },
};
