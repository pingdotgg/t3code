import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import type * as Cloudflare from "@cloudflare/workers-types";
import type { Summary } from "./Summary.ts";

interface Totals {
  developer: string;
  host: string;
  platform: string;
  arch: string;
  ci: number;
  local_ms: number;
  unspecified_ms: number;
  unspecified_hits: number;
  remote_ms: number;
  local_hits: number;
  remote_hits: number;
  executed: number;
  restore_failures: number;
}

export class SavingsError extends Schema.TaggedError<SavingsError>()("SavingsError", {
  operation: Schema.Literals(["record", "read", "cleanup"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to ${this.operation} task-cache savings.`;
  }
}

export class Database extends Context.Service<Database, Cloudflare.D1Database>()(
  "@t3tools/task-cache/Savings/Database",
) {}

export class Savings extends Context.Service<
  Savings,
  {
    readonly record: (
      summary: typeof Summary.Type,
      developer: string,
    ) => Effect.Effect<void, SavingsError>;
    readonly emitTotals: (developer?: string, host?: string) => Effect.Effect<void, SavingsError>;
    readonly cleanup: Effect.Effect<void, SavingsError>;
  }
>()("@t3tools/task-cache/Savings") {}

const make = Effect.gen(function* () {
  const database = yield* Database;
  const record = Effect.fn("TaskCache.persistSavings")(function* (
    summary: typeof Summary.Type,
    developer: string,
  ) {
    const local = summary.tasks.filter((task) => task.source === "local");
    const unspecified = summary.tasks.filter((task) => task.source === "unspecified");
    const remote = summary.tasks.filter((task) => task.source === "remote");
    // D1 batch is transactional. changes() gates the increment on the preceding receipt insertion.
    yield* Effect.tryPromise({
      try: () =>
        database.batch([
          database
            .prepare("INSERT INTO receipts(id, recorded_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
            .bind(summary.id, summary.recordedAt),
          database
            .prepare(`INSERT INTO savings(developer, host, platform, arch, ci, local_ms, remote_ms, local_hits, remote_hits, executed, restore_failures, unspecified_ms, unspecified_hits) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1
      ON CONFLICT DO UPDATE SET
        local_ms = local_ms + excluded.local_ms, remote_ms = remote_ms + excluded.remote_ms,
        local_hits = local_hits + excluded.local_hits, remote_hits = remote_hits + excluded.remote_hits,
        executed = executed + excluded.executed, restore_failures = restore_failures + excluded.restore_failures,
        unspecified_ms = unspecified_ms + excluded.unspecified_ms, unspecified_hits = unspecified_hits + excluded.unspecified_hits`)
            .bind(
              developer,
              summary.host,
              summary.platform,
              summary.arch,
              Number(summary.ci),
              local.reduce((sum, task) => sum + task.savedMs, 0),
              remote.reduce((sum, task) => sum + task.savedMs, 0),
              local.length,
              remote.length,
              summary.tasks.filter((task) => task.source === "executed").length,
              summary.tasks.filter((task) => task.source === "failed").length,
              unspecified.reduce((sum, task) => sum + task.savedMs, 0),
              unspecified.length,
            ),
        ]),
      catch: (cause) => new SavingsError({ operation: "record", cause }),
    });
  });

  const emitTotals = Effect.fn("TaskCache.emitTotals")(function* (
    developer?: string,
    host?: string,
  ) {
    const rows = yield* Effect.tryPromise({
      try: () =>
        (developer === undefined
          ? database.prepare("SELECT * FROM savings")
          : database
              .prepare("SELECT * FROM savings WHERE developer = ? AND host = ?")
              .bind(developer, host)
        ).all<Totals>(),
      catch: (cause) => new SavingsError({ operation: "read", cause }),
    });
    yield* Effect.forEach(rows.results, (row) =>
      Effect.annotateCurrentSpan({
        "developer.id": row.developer,
        "host.name": row.host,
        "host.os": row.platform,
        "host.arch": row.arch,
        ci: Boolean(row.ci),
        "cache.local_saved_ms": row.local_ms,
        "cache.unspecified_saved_ms": row.unspecified_ms,
        "cache.unspecified_hits": row.unspecified_hits,
        "cache.remote_saved_ms": row.remote_ms,
        "cache.local_hits": row.local_hits,
        "cache.remote_hits": row.remote_hits,
        "cache.executed": row.executed,
        "cache.restore_failures": row.restore_failures,
      }).pipe(Effect.withSpan("TaskCache.lifetime")),
    );
  });

  const cleanup = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.tryPromise({
      try: () =>
        database
          .prepare("DELETE FROM receipts WHERE recorded_at < ?")
          .bind(now - 31 * 86400_000)
          .run(),
      catch: (cause) => new SavingsError({ operation: "cleanup", cause }),
    });
  });
  return Savings.of({ record, emitTotals, cleanup });
});

export const layer = Layer.effect(Savings, make);
