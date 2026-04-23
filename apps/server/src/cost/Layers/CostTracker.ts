/**
 * CostTrackerLive - JSON-backed cost ledger.
 *
 * Writes three atomic files per recorded turn:
 *   - `session_<threadId>.json`
 *   - `<YYYY-MM>.json`  (local tz)
 *   - `alltime.json`
 *
 * Atomic pattern mirrors `serverSettings`: write `.tmp`, rename into place.
 * Errors never block orchestration — the caller wraps `recordUsage` in
 * `Effect.catchAll(logError)`.
 *
 * @module CostTrackerLive
 */
import { Data, Effect, FileSystem, Layer, Path, PubSub, Semaphore, Stream } from "effect";

class CostFileParseError extends Data.TaggedError("CostFileParseError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

import { ServerConfig } from "../../config.ts";
import { CostTrackerService, type CostTrackerShape } from "../Services/CostTracker.ts";
import {
  processTurn,
  sanitizePersistedFile,
  type ProcessTurnResult,
} from "../Reducer.ts";
import type {
  CostBucket,
  CostSummary,
  PersistedCostFile,
  PersistedCostFileKind,
  RecordUsageInput,
} from "../types.ts";
import { emptyCostBucket, localMonthKey } from "../types.ts";

function encodeFile(file: PersistedCostFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function sessionFilename(threadId: string): string {
  // Normalize threadId for a flat filename — threadIds are UUID-like, but
  // encodeURIComponent keeps us safe if a provider ever emits special chars.
  return `session_${encodeURIComponent(threadId)}.json`;
}

function monthFilename(monthKey: string): string {
  return `${monthKey}.json`;
}

const ALLTIME_FILENAME = "alltime.json";

/**
 * Ledger schema version. Bump when the on-disk format changes in a way that
 * makes older files incompatible with the new reducer — a sentinel file
 * `.schema-v<N>` is written to `usageDir` and, if missing on startup, the
 * ledger is wiped (only the JSON ledger files; untracked files in the
 * directory are left alone). Rationale for v2: prior versions fed mid-turn
 * `thread.token-usage.updated` snapshots into the cost reducer, which
 * double-counted token totals and inflated `turnCount` by N per real turn.
 * Those buckets can't be retroactively repaired, so we reset on upgrade.
 */
const LEDGER_SCHEMA_VERSION = 2 as const;
const LEDGER_SCHEMA_SENTINEL = `.schema-v${LEDGER_SCHEMA_VERSION}`;
const LEDGER_FILE_PATTERN = /^(session_.+|\d{4}-\d{2}|alltime)\.json$/;

const make = Effect.gen(function* () {
  const { usageDir } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // One writer at a time so concurrent turns don't clobber the same file.
  const writeSemaphore = yield* Semaphore.make(1);
  const updatesPubSub = yield* PubSub.unbounded<CostSummary>();

  // Ensure the directory exists even if config bootstrap skipped it.
  yield* fs.makeDirectory(usageDir, { recursive: true }).pipe(Effect.ignore({ log: true }));

  // Migration: wipe ledger files polluted by the pre-v2 reducer.  Idempotent
  // via the `.schema-vN` sentinel — once present, subsequent boots skip.
  yield* Effect.gen(function* () {
    const sentinelPath = path.join(usageDir, LEDGER_SCHEMA_SENTINEL);
    const sentinelExists = yield* fs
      .exists(sentinelPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (sentinelExists) return;

    const entries = yield* fs
      .readDirectory(usageDir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    const ledgerFiles = entries.filter((entry) => LEDGER_FILE_PATTERN.test(entry));
    if (ledgerFiles.length > 0) {
      yield* Effect.logInfo(
        `CostTracker: migrating usage ledger to schema v${LEDGER_SCHEMA_VERSION}; wiping ${ledgerFiles.length} pre-migration file(s)`,
      );
      yield* Effect.forEach(
        ledgerFiles,
        (entry) =>
          fs
            .remove(path.join(usageDir, entry), { force: true })
            .pipe(Effect.ignoreCause({ log: true })),
        { concurrency: "unbounded", discard: true },
      );
    }
    yield* fs
      .writeFileString(
        sentinelPath,
        `${JSON.stringify(
          {
            version: LEDGER_SCHEMA_VERSION,
            migratedAt: new Date().toISOString(),
            wipedFileCount: ledgerFiles.length,
          },
          null,
          2,
        )}\n`,
      )
      .pipe(Effect.ignoreCause({ log: true }));
  }).pipe(Effect.ignoreCause({ log: true }));

  const filePathFor = (kind: PersistedCostFileKind, key: string): string => {
    switch (kind) {
      case "session":
        return path.join(usageDir, sessionFilename(key));
      case "month":
        return path.join(usageDir, monthFilename(key));
      case "alltime":
        return path.join(usageDir, ALLTIME_FILENAME);
    }
  };

  const readFileIfExists = (absPath: string) =>
    Effect.gen(function* () {
      const exists = yield* fs.exists(absPath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return undefined;
      const raw = yield* fs.readFileString(absPath).pipe(Effect.orElseSucceed(() => ""));
      if (!raw.trim()) return undefined;
      return yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) => new CostFileParseError({ path: absPath, cause }),
      }).pipe(Effect.orElseSucceed(() => undefined));
    });

  const loadFile = (
    kind: PersistedCostFileKind,
    key: string,
    now: Date,
  ): Effect.Effect<PersistedCostFile> =>
    Effect.gen(function* () {
      const raw = yield* readFileIfExists(filePathFor(kind, key));
      return sanitizePersistedFile(raw, kind, key, now);
    });

  const writeFileAtomically = (file: PersistedCostFile) =>
    Effect.gen(function* () {
      const target = filePathFor(file.kind, file.key);
      const tempPath = `${target}.${process.pid}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2, 8)}.tmp`;
      const encoded = encodeFile(file);
      yield* fs.writeFileString(tempPath, encoded);
      yield* fs
        .rename(tempPath, target)
        .pipe(Effect.ensuring(fs.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true }))));
    }).pipe(Effect.ignoreCause({ log: true }));

  const summaryFromFiles = (
    session: PersistedCostFile | null,
    month: PersistedCostFile,
    allTime: PersistedCostFile,
    monthKey: string,
  ): CostSummary => ({
    thread: session?.bucket ?? null,
    month: month.bucket,
    allTime: allTime.bucket,
    monthKey,
  });

  const emptyBucketFile = (
    kind: PersistedCostFileKind,
    key: string,
    now: Date,
  ): PersistedCostFile => ({
    version: 1,
    kind,
    key,
    bucket: emptyCostBucket(now),
  });

  const getSummary: CostTrackerShape["getSummary"] = (input) =>
    Effect.gen(function* () {
      const now = input.at ?? new Date();
      const monthKey = localMonthKey(now);
      const [month, allTime, threadFile] = yield* Effect.all(
        [
          loadFile("month", monthKey, now),
          loadFile("alltime", "alltime", now),
          input.threadId ? loadFile("session", input.threadId, now) : Effect.succeed(null),
        ],
        { concurrency: "unbounded" },
      );
      return summaryFromFiles(threadFile, month, allTime, monthKey);
    });

  const recordUsage: CostTrackerShape["recordUsage"] = (input: RecordUsageInput) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const now = input.at ?? new Date();
        const monthKey = localMonthKey(now);
        const session = yield* loadFile("session", input.threadId, now);
        const month = yield* loadFile("month", monthKey, now);
        const allTime = yield* loadFile("alltime", "alltime", now);

        const result: ProcessTurnResult = processTurn({
          input,
          session,
          month,
          allTime,
          now,
        });

        if (result.applied) {
          yield* Effect.all(
            [
              writeFileAtomically(result.session),
              writeFileAtomically(result.month),
              writeFileAtomically(result.allTime),
            ],
            { concurrency: "unbounded" },
          );
        }

        const summary: CostSummary = {
          thread: result.session.bucket,
          month: result.month.bucket,
          allTime: result.allTime.bucket,
          monthKey: result.monthKey,
        };

        if (result.applied) {
          yield* PubSub.publish(updatesPubSub, summary).pipe(Effect.asVoid);
        }
        return summary;
      }),
    );

  const shape: CostTrackerShape = {
    recordUsage,
    getSummary,
    updates: Stream.fromPubSub(updatesPubSub),
  };
  return shape;
});

export const CostTrackerLive = Layer.effect(CostTrackerService, make);
