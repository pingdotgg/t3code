import type { DatabaseStorageStatus } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveHostCliCommand } from "../cli/invocation.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { forkParked } from "../serverActivation.ts";

// Bound each reclaim pass to one minute of churn.
const RECLAIM_PAGES_PER_PASS = 1024;
const COMPACTION_INTERVAL = Duration.hours(6);

export class DatabaseStorage extends Context.Service<
  DatabaseStorage,
  {
    /** Return free pages to the filesystem on databases with incremental auto_vacuum. */
    readonly reclaim: Effect.Effect<void>;
    /** Current file accounting, re-published after each maintenance pass. Null until first read. */
    readonly status: Stream.Stream<DatabaseStorageStatus | null>;
  }
>()("t3/persistence/DatabaseStorage") {}

// Deleted events have newer retained replacements; old cursors replay to the same state.
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statusRef = yield* SubscriptionRef.make<DatabaseStorageStatus | null>(null);

  // The notice shows host-shell quoting verbatim; desktop needs its launcher because t3 is absent from PATH.
  const { command: compactCommand } = yield* resolveHostCliCommand("doctor", [
    "--base-dir",
    config.baseDir,
  ]);
  // doctor --base-dir targets userdata, not implicit dev homes; suppress status to avoid touching the live install.
  const doctorTargetsThisDatabase =
    path.resolve(config.dbPath) ===
    path.resolve(config.baseDir, "userdata", path.basename(config.dbPath));
  const publishStatus = Effect.gen(function* () {
    if (!doctorTargetsThisDatabase) return;
    const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    const pageSize = size[0]?.page_size ?? 0;
    const next: DatabaseStorageStatus = {
      databaseBytes: (pages[0]?.page_count ?? 0) * pageSize,
      reclaimableBytes: (free[0]?.freelist_count ?? 0) * pageSize,
      incrementalVacuumEnabled: mode[0]?.auto_vacuum === 2,
      compactCommand,
    };
    // Every set reaches each open Storage page; most passes change nothing.
    if (!Equal.equals(yield* SubscriptionRef.get(statusRef), next)) {
      yield* SubscriptionRef.set(statusRef, next);
    }
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Database storage inspection failed", { cause })),
  );

  const reclaim = Effect.gen(function* () {
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    if (mode[0]?.auto_vacuum !== 2) return;
    // The driver steps once per statement; incremental_vacuum frees one page per step. Yield between pages.
    for (let page = 0; page < RECLAIM_PAGES_PER_PASS; page++) {
      const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      if ((free[0]?.freelist_count ?? 0) === 0) break;
      yield* sql`PRAGMA incremental_vacuum(1)`;
      yield* Effect.yieldNow;
    }
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Database space reclamation failed", { cause })),
  );

  // Even a pass that deletes nothing scans the event store. Persist completion
  // so restarting does not trigger another scan before the six-hour interval.
  const compactedAtPath = path.join(path.dirname(config.dbPath), "compacted-at");
  const compact = Effect.gen(function* () {
    let sliceStarted = yield* Clock.monotonicTimeNanos;
    const betweenPages = Effect.gen(function* () {
      const elapsed = (yield* Clock.monotonicTimeNanos) - sliceStarted;
      if (elapsed < 25_000_000n) return;
      // Keep background maintenance at 10% duty, including pages that exceed the budget.
      yield* Effect.sleep((Number(elapsed) / 1_000_000) * 9);
      sliceStarted = yield* Clock.monotonicTimeNanos;
    });
    const result = yield* maintenance.compactEventStore(betweenPages);
    const completedAt = yield* Clock.currentTimeMillis;
    yield* fs.writeFileString(compactedAtPath, String(completedAt)).pipe(Effect.ignore);
    if (result.deletedEventCount > 0 || result.deletedReceiptCount > 0) {
      yield* Effect.logInfo("Compacted orchestration history", result);
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Orchestration history compaction failed", { cause }),
    ),
  );
  const lastCompactedAt = yield* fs.readFileString(compactedAtPath).pipe(
    Effect.map(Number),
    Effect.orElseSucceed(() => Number.NaN),
  );
  const intervalMs = Duration.toMillis(COMPACTION_INTERVAL);
  const untilDueMs = Number.isFinite(lastCompactedAt)
    ? lastCompactedAt + intervalMs - (yield* Clock.currentTimeMillis)
    : 0;
  const firstCompactionDelay = Duration.millis(
    Math.min(intervalMs, Math.max(Duration.toMillis(Duration.minutes(1)), untilDueMs)),
  );

  yield* forkParked(
    Effect.sleep(firstCompactionDelay).pipe(
      Effect.andThen(
        compact.pipe(
          Effect.andThen(publishStatus),
          Effect.repeat(Schedule.spaced(COMPACTION_INTERVAL)),
        ),
      ),
    ),
  );
  yield* forkParked(
    publishStatus.pipe(
      Effect.andThen(Effect.sleep("1 minute")),
      Effect.andThen(
        reclaim.pipe(Effect.andThen(publishStatus), Effect.repeat(Schedule.spaced("1 minute"))),
      ),
    ),
  );

  return DatabaseStorage.of({ reclaim, status: SubscriptionRef.changes(statusRef) });
});

export const layer = Layer.effect(DatabaseStorage, make);
