/**
 * UsageService - scans provider transcripts and returns priced usage buckets.
 *
 * The scan reads the provider CLIs' own session files rather than T3 Code's
 * orchestration projections, so usage covers turns driven outside T3 Code too.
 * This is the approach `ccusage` / OpenUsage take.
 *
 * Transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed.
 *
 * @module UsageService
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import {
  CURSOR_USAGE_CACHE_TTL_MS,
  fetchCursorUsageRecords,
  readCursorAuthTokens,
  resolveCursorStateDbPath,
} from "./usageCursor.ts";
import {
  listOpenCodeDatabases,
  readOpenCodeDatabaseRecords,
  resolveOpenCodeDataDir,
} from "./usageOpenCode.ts";
import { parseRateTable, type RateTable } from "./usagePricing.ts";
import {
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
} from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Longest window the UI offers, plus slack. Older entries are pruned. */
const CACHE_RETENTION_DAYS = 90;

/** On-disk shape of the rate snapshot. */
const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);

/** The scan cache is narrowed by hand in `usageScanCache`, so JSON is enough here. */
const ScanCacheJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeScanCacheFile = Schema.encodeEffect(ScanCacheJson);

type JsonlDirSource = {
  readonly kind: "jsonlDir";
  readonly provider: "claude" | "codex";
  readonly dir: string;
};

type JsonlFileSource = {
  readonly kind: "jsonlFile";
  readonly provider: "grok";
  readonly filePath: string;
  readonly homePath: string;
};

type OpenCodeSource = {
  readonly kind: "opencode";
  readonly provider: "opencode";
  readonly dataDir: string;
};

type CursorSource = {
  readonly kind: "cursor";
  readonly provider: "cursor";
  readonly stateDbPath: string;
};

type UsageSourceSpec = JsonlDirSource | JsonlFileSource | OpenCodeSource | CursorSource;

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
  }
>()("t3/usage/UsageService") {}

/** Empty summary, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  UsageService,
  UsageService.of({
    readSummary: (input) =>
      Effect.succeed({
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: [],
        sources: [],
        pricing: {
          status: "unavailable",
          source: LITELLM_RATES_URL,
          fetchedAt: null,
          knownModels: 0,
        },
        scanDurationMs: 0,
      }),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;

  const fileCache: ScanCache = new Map();
  let cacheDirty = false;

  /** Soft cache for Cursor CSV fetches — keyed separately from transcript files. */
  let cursorCache:
    | {
        readonly cacheKey: string;
        readonly fetchedAtMs: number;
        readonly records: readonly UsageRecord[];
        readonly status: "ok" | "failed";
        readonly message: string | null;
      }
    | undefined;

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsageSummary["pricing"]["status"] = "unavailable";

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing.
   */
  const ensureRates = Effect.fn("UsageService.ensureRates")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < RATES_TTL_MS) return;

    if (ratesFetchedAtMs === null) {
      const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
        Effect.flatMap((raw) => decodeRatesCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk !== null) {
        const parsed = parseRateTable(fromDisk.document);
        if (parsed.size > 0) {
          rates = parsed;
          ratesFetchedAtMs = fromDisk.fetchedAtMs;
          ratesStatus = "cached";
          if (now - fromDisk.fetchedAtMs < RATES_TTL_MS) return;
        }
      }
    }

    const fetched = yield* httpClient.get(LITELLM_RATES_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(10_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fetched === null) {
      // The refresh failed; whatever we are serving is now past its TTL and
      // must not keep claiming to be fresh.
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    const parsed = parseRateTable(fetched);
    if (parsed.size === 0) return;

    rates = parsed;
    ratesFetchedAtMs = now;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched }).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(ratesCachePath, serialized)),
      Effect.catchCause(() => Effect.void),
    );
  });

  /**
   * Claude's config dir is the home itself when overridden, but a default
   * install nests transcripts under `~/.claude/projects`. Probe both.
   */
  const resolveClaudeTranscriptDir = (homePath: string) =>
    Effect.gen(function* () {
      const nested = path.join(homePath, ".claude", "projects");
      const nestedExists = yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      return nestedExists ? nested : path.join(homePath, "projects");
    });

  const resolveGrokLogPath = (): { filePath: string; homePath: string } => {
    const grokHome = process.env["GROK_HOME"]?.trim();
    if (grokHome && grokHome.length > 0) {
      const homePath = grokHome.startsWith("~/")
        ? path.join(NodeOS.homedir(), grokHome.slice(2))
        : grokHome === "~"
          ? NodeOS.homedir()
          : grokHome;
      return {
        homePath,
        filePath: path.join(homePath, "logs", "unified.jsonl"),
      };
    }
    const homePath = path.join(NodeOS.homedir(), ".grok");
    return { homePath, filePath: path.join(homePath, "logs", "unified.jsonl") };
  };

  /** Resolves every provider source the Usage page knows how to read. */
  const resolveSources = Effect.fn("UsageService.resolveSources")(function* () {
    // A settings failure must surface as an error: swallowing it here would
    // present "zero usage from every provider" as a valid answer.
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            // Bounded description; the squashed failure travels as the cause.
            // Squashed, not the Cause tree: a full tree in a Defect field is
            // the unbounded wire payload the bounded detail exists to avoid.
            detail: "Server settings could not be read.",
            cause: Cause.squash(cause),
          }),
      ),
    );

    const claudeHome = yield* resolveClaudeHomePath(settings.providers.claudeAgent);
    const claudeDir = yield* resolveClaudeTranscriptDir(claudeHome);
    const codexLayout = yield* resolveCodexHomeLayout(settings.providers.codex);
    const grok = resolveGrokLogPath();

    return [
      { kind: "jsonlDir", provider: "claude", dir: claudeDir },
      {
        kind: "jsonlDir",
        provider: "codex",
        dir: path.join(codexLayout.sharedHomePath, "sessions"),
      },
      {
        kind: "jsonlFile",
        provider: "grok",
        filePath: grok.filePath,
        homePath: grok.homePath,
      },
      { kind: "opencode", provider: "opencode", dataDir: resolveOpenCodeDataDir() },
      { kind: "cursor", provider: "cursor", stateDbPath: resolveCursorStateDbPath() },
    ] satisfies readonly UsageSourceSpec[];
  });

  /**
   * Loads the persisted scan cache exactly once per process.
   *
   * `Effect.cached` makes concurrent first readers await the same load rather
   * than each seeing a "loaded" flag set before the read finished and cold
   * scanning against an empty cache.
   */
  const ensureScanCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const document = yield* fileSystem.readFileString(scanCachePath).pipe(
        Effect.flatMap((raw) => decodeScanCacheFile(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (document === null) return;
      for (const [path, entry] of decodeScanCache(document)) fileCache.set(path, entry);
    }),
  );

  const persistScanCache = Effect.fn("UsageService.persistScanCache")(function* () {
    if (!cacheDirty) return;
    // Cleared only after the write lands, so a failed persist is retried on
    // the next scan instead of leaving disk permanently stale.
    yield* encodeScanCacheFile(encodeScanCache(fileCache)).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(scanCachePath, serialized)),
      Effect.map(() => {
        cacheDirty = false;
      }),
      // A cache we cannot write is a slower next start, not a failed read.
      Effect.catchCause(() => Effect.void),
    );
  });

  /** Parses one transcript, reusing the cached result when it is unchanged. */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
  ): Effect.Effect<readonly UsageRecord[] | null> =>
    Effect.gen(function* () {
      const cached = fileCache.get(filePath);
      // Provider is part of the identity: if both providers were ever pointed
      // at one directory, a hit parsed by the other parser must not be reused.
      if (
        cached &&
        cached.size === size &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === provider
      ) {
        return cached.records;
      }

      const parsed = yield* Effect.promise(() => readTranscriptRecords(filePath, provider));
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null) return null;
      // Stored already de-duplicated within the file, which is 99% of all
      // duplicates. The aggregator still runs the cross-file dedupe pass.
      const records = dedupeWithinFile(parsed);

      fileCache.set(filePath, { size, mtimeMs, provider, records });
      cacheDirty = true;
      return records;
    });

  const readOpenCodeCached = (
    dbPath: string,
    size: number,
    mtimeMs: number,
  ): Effect.Effect<readonly UsageRecord[] | null> =>
    Effect.gen(function* () {
      const cached = fileCache.get(dbPath);
      if (
        cached &&
        cached.size === size &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === "opencode"
      ) {
        return cached.records;
      }

      const parsed = yield* Effect.sync(() => readOpenCodeDatabaseRecords(dbPath));
      if (parsed === null) return null;
      const records = dedupeWithinFile(parsed);
      fileCache.set(dbPath, { size, mtimeMs, provider: "opencode", records });
      cacheDirty = true;
      return records;
    });

  const ingestRecords = (
    aggregator: UsageAggregator,
    records: readonly UsageRecord[],
    sessionIds: Set<string>,
  ): number => {
    let contributed = 0;
    for (const record of records) {
      if (aggregator.add(record)) {
        contributed += 1;
        if (record.sessionId.length > 0) sessionIds.add(record.sessionId);
      }
    }
    return contributed;
  };

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage requires valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage window must be greater than zero and at most 24 hours",
        });
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureRates();
    yield* ensureScanCacheLoaded;

    const hostId = NodeOS.hostname();
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so `readSummary` stays context-free.
    const sourceSpecs = yield* resolveSources().pipe(Effect.provideService(Path.Path, path));
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;
    const windowEnd = DateTime.make(`${input.untilDay}T23:59:59.999Z`);
    // Pad the Cursor API window past UTC day bounds so viewer time zones west of
    // UTC still include local "untilDay" / "today" when untilDay is UTC-shaped.
    const windowEndMs = Option.isSome(windowEnd)
      ? DateTime.toEpochMillis(windowEnd.value) + MTIME_SLACK_MS
      : startedAtMs;

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
    });

    const sources: UsageSource[] = [];
    const livePaths = new Set<string>();
    const walkedRoots: string[] = [];

    for (const source of sourceSpecs) {
      if (source.kind === "jsonlDir") {
        const { provider, dir } = source;
        const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
        const exists = yield* fileSystem
          .exists(dir)
          .pipe(Effect.catchCause(() => Effect.succeed(false)));

        if (!exists) {
          sources.push({
            fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
            status: "missing",
            scannedFiles: 0,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 0,
            message: "No transcript directory on this environment.",
          });
          continue;
        }

        walkedRoots.push(dir);
        const files = yield* Effect.promise(() => listTranscriptFiles(dir, windowStartMs));
        let scannedFiles = 0;
        let skippedFiles = 0;
        let readFailed = false;
        const sessionIds = new Set<string>();

        for (const file of files) {
          livePaths.add(file.path);
          const records = yield* readFileRecords(file.path, file.size, file.mtimeMs, provider);
          if (records === null) {
            readFailed = true;
            skippedFiles += 1;
            continue;
          }
          if (records.length === 0) {
            skippedFiles += 1;
            continue;
          }
          scannedFiles += 1;
          ingestRecords(aggregator, records, sessionIds);
        }

        const status = readFailed ? (scannedFiles > 0 ? "partial" : "failed") : "ok";
        sources.push({
          fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
          status,
          scannedFiles,
          skippedFiles,
          malformedRecords: 0,
          distinctSessions: sessionIds.size,
          message: readFailed ? "Some transcript files could not be read." : null,
        });
        continue;
      }

      if (source.kind === "jsonlFile") {
        const { provider, filePath, homePath } = source;
        const volumeId = yield* Effect.promise(() =>
          readDirectoryVolumeId(NodePath.dirname(filePath)),
        );
        const exists = yield* fileSystem
          .exists(filePath)
          .pipe(Effect.catchCause(() => Effect.succeed(false)));

        if (!exists) {
          sources.push({
            fingerprint: { hostId, provider, resolvedHomePath: homePath, volumeId },
            status: "missing",
            scannedFiles: 0,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 0,
            message: "No Grok unified log on this environment.",
          });
          continue;
        }

        walkedRoots.push(NodePath.dirname(filePath));
        livePaths.add(filePath);

        const stats = yield* fileSystem.stat(filePath).pipe(
          Effect.map((stat) => ({
            size: Number(stat.size),
            mtimeMs: Option.match(stat.mtime, {
              onNone: () => 0,
              onSome: (mtime) => mtime.getTime(),
            }),
          })),
          Effect.catchCause(() => Effect.succeed(null)),
        );

        const sessionIds = new Set<string>();
        if (stats === null) {
          sources.push({
            fingerprint: { hostId, provider, resolvedHomePath: homePath, volumeId },
            status: "failed",
            scannedFiles: 0,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 0,
            message: "Grok unified log could not be read.",
          });
          continue;
        }

        const records = yield* readFileRecords(filePath, stats.size, stats.mtimeMs, provider);
        if (records === null) {
          sources.push({
            fingerprint: { hostId, provider, resolvedHomePath: homePath, volumeId },
            status: "failed",
            scannedFiles: 0,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 0,
            message: "Grok unified log could not be parsed.",
          });
          continue;
        }
        ingestRecords(aggregator, records, sessionIds);

        sources.push({
          fingerprint: { hostId, provider, resolvedHomePath: homePath, volumeId },
          status: "ok",
          scannedFiles: records.length > 0 ? 1 : 0,
          skippedFiles: records.length === 0 ? 1 : 0,
          malformedRecords: 0,
          distinctSessions: sessionIds.size,
          message: null,
        });
        continue;
      }

      if (source.kind === "opencode") {
        const { provider, dataDir } = source;
        const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dataDir));
        const exists = yield* fileSystem
          .exists(dataDir)
          .pipe(Effect.catchCause(() => Effect.succeed(false)));

        if (!exists) {
          sources.push({
            fingerprint: { hostId, provider, resolvedHomePath: dataDir, volumeId },
            status: "missing",
            scannedFiles: 0,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 0,
            message: "No OpenCode data directory on this environment.",
          });
          continue;
        }

        walkedRoots.push(dataDir);
        const databases = yield* Effect.promise(() => listOpenCodeDatabases(dataDir));
        let scannedFiles = 0;
        let skippedFiles = 0;
        let readFailed = false;
        const sessionIds = new Set<string>();

        for (const db of databases) {
          livePaths.add(db.path);
          const records = yield* readOpenCodeCached(db.path, db.size, db.mtimeMs);
          if (records === null) {
            readFailed = true;
            skippedFiles += 1;
            continue;
          }
          if (records.length === 0) {
            skippedFiles += 1;
            continue;
          }
          scannedFiles += 1;
          ingestRecords(aggregator, records, sessionIds);
        }

        sources.push({
          fingerprint: { hostId, provider, resolvedHomePath: dataDir, volumeId },
          status: readFailed ? (scannedFiles > 0 ? "partial" : "failed") : "ok",
          scannedFiles,
          skippedFiles,
          malformedRecords: 0,
          distinctSessions: sessionIds.size,
          message: readFailed
            ? scannedFiles > 0
              ? "Some OpenCode databases could not be read."
              : "OpenCode database could not be read."
            : databases.length === 0
              ? "No OpenCode database files found."
              : null,
        });
        continue;
      }

      // cursor
      {
        const { provider, stateDbPath } = source;
        const volumeId = yield* Effect.promise(() =>
          readDirectoryVolumeId(NodePath.dirname(stateDbPath)),
        );
        const auth = yield* Effect.sync(() => readCursorAuthTokens(stateDbPath));

        if (auth === null) {
          sources.push({
            fingerprint: { hostId, provider, resolvedHomePath: stateDbPath, volumeId },
            status: "missing",
            scannedFiles: 0,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 0,
            message: "Cursor is not signed in on this environment.",
          });
          continue;
        }

        const cacheKey = `${stateDbPath}:${auth.stateDbMtimeMs}:${input.sinceDay}:${input.untilDay}`;
        const now = yield* Clock.currentTimeMillis;
        let cursorResult = cursorCache;
        if (
          cursorResult === undefined ||
          cursorResult.cacheKey !== cacheKey ||
          now - cursorResult.fetchedAtMs >= CURSOR_USAGE_CACHE_TTL_MS
        ) {
          const fetched = yield* fetchCursorUsageRecords({
            auth,
            sinceMs: windowStartMs,
            untilMs: windowEndMs,
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
          cursorResult = {
            cacheKey,
            fetchedAtMs: now,
            records: fetched.records,
            status: fetched.status === "ok" ? "ok" : "failed",
            message: fetched.message,
          };
          // Only cache successful fetches: a transient failure must not sit
          // for the full TTL and hide recovered usage.
          if (fetched.status === "ok") {
            cursorCache = cursorResult;
          }
        }

        const sessionIds = new Set<string>();
        if (cursorResult.status === "ok") {
          ingestRecords(aggregator, cursorResult.records, sessionIds);
        }

        sources.push({
          fingerprint: { hostId, provider, resolvedHomePath: stateDbPath, volumeId },
          status: cursorResult.status,
          scannedFiles: cursorResult.status === "ok" ? 1 : 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: sessionIds.size,
          message: cursorResult.message,
        });
      }
    }

    const pruned = pruneScanCache(fileCache, {
      livePaths,
      walkedRoots,
      windowStartMs,
      retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    });
    if (pruned > 0) cacheDirty = true;
    yield* persistScanCache();

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      pricing: {
        status: ratesStatus,
        source: LITELLM_RATES_URL,
        fetchedAt:
          ratesFetchedAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
        knownModels: rates.size,
      },
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  return { readSummary } as const;
});

export const layer = Layer.effect(UsageService, make);
