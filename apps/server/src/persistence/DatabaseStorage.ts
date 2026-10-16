import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { forkParked } from "../serverActivation.ts";

/** Pages returned per reclaim pass; one minute of churn, not a backlog. */
const RECLAIM_PAGES_PER_PASS = 1024;

export class DatabaseStorage extends Context.Service<
  DatabaseStorage,
  {
    /** Return free pages to the filesystem on databases with incremental auto_vacuum. */
    readonly reclaim: Effect.Effect<void>;
  }
>()("t3/persistence/DatabaseStorage") {}

/**
 * Deletes superseded history every few hours and hands freed pages back to
 * the filesystem every minute. Deleted events are always superseded by a
 * retained event with a higher sequence, so a client replaying from an older
 * cursor still reaches the same state; no replay boundary is published.
 */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;

  const reclaim = Effect.gen(function* () {
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    if (mode[0]?.auto_vacuum !== 2) return;
    // The driver steps a statement without result columns once, and each
    // step of incremental_vacuum frees one page. Yield between pages so
    // client requests can run.
    for (let page = 0; page < RECLAIM_PAGES_PER_PASS; page++) {
      const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      if ((free[0]?.freelist_count ?? 0) === 0) break;
      yield* sql`PRAGMA incremental_vacuum(1)`;
      yield* Effect.yieldNow;
    }
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Database space reclamation failed", { cause })),
  );

  const compact = maintenance.compactEventStore.pipe(
    Effect.tap((result) =>
      result.deletedEventCount > 0 || result.deletedReceiptCount > 0
        ? Effect.logInfo("Compacted orchestration history", result)
        : Effect.void,
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Orchestration history compaction failed", { cause }),
    ),
  );

  yield* forkParked(
    Effect.sleep("1 minute").pipe(
      Effect.andThen(compact.pipe(Effect.repeat(Schedule.spaced("6 hours")))),
    ),
  );
  yield* forkParked(
    Effect.sleep("1 minute").pipe(
      Effect.andThen(reclaim.pipe(Effect.repeat(Schedule.spaced("1 minute")))),
    ),
  );

  return DatabaseStorage.of({ reclaim });
});

export const layer = Layer.effect(DatabaseStorage, make);
