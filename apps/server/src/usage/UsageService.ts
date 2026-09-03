// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics preferSchemaOverJson:off
/**
 * UsageService - scans provider transcripts and returns priced usage buckets.
 *
 * The scan reads the provider CLIs' own session files (Claude Code, Codex, and
 * Grok Build) rather than T3 Code's orchestration projections, so usage covers
 * turns driven outside T3 Code too. This is the approach `ccusage` takes.
 *
 * Transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed, and a file that merely grew resumes
 * from its cached parse position so only the appended bytes are read.
 *
 * @module UsageService
 */
import * as NodeOS from "node:os";

import {
  USAGE_CONTRACT_VERSION,
  UsageDay,
  UsageSummary as UsageSummarySchema,
  UsageSource as UsageSourceSchema,
  type UsageProviderKind,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { makeDayFormatter } from "./usageAggregation.ts";
import { addTotals, EMPTY_TOTALS, type UsageRecord } from "./usageTranscripts.ts";
import { parseRateTable, priceUsage, type RateTable } from "./usagePricing.ts";
import {
  listTranscriptFilesDetailed,
  readDirectoryVolumeIdDetailed,
  readTranscriptRecords,
} from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type ScanCache,
} from "./usageScanCache.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
// Covers the full supported UTC offset spread plus DST and filesystem write
// skew when a remote viewer's calendar day differs from the server's.
const MTIME_SLACK_MS = 72 * 60 * 60 * 1000;
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

const UsageSnapshotFile = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      summary: UsageSummarySchema,
    }),
  ),
});
const UsageLedgerRecord = Schema.Struct({
  hostId: Schema.String,
  provider: Schema.Literals(["claude", "codex", "grok"]),
  resolvedHomePath: Schema.String,
  volumeId: Schema.String,
  record: Schema.Struct({
    provider: Schema.Literals(["claude", "codex", "grok"]),
    timestampMs: Schema.Number,
    model: Schema.String,
    sessionId: Schema.String,
    totals: Schema.Struct({
      uncachedInputTokens: Schema.Number,
      cachedInputTokens: Schema.Number,
      cacheCreationTokens: Schema.Number,
      outputTokens: Schema.Number,
      reasoningTokens: Schema.Number,
    }),
    reportedCostUsd: Schema.NullOr(Schema.Number),
    dedupeKey: Schema.NullOr(Schema.String),
  }),
});
const UsageLedgerAggregate = Schema.Struct({
  hostId: Schema.String,
  provider: Schema.Literals(["claude", "codex", "grok"]),
  resolvedHomePath: Schema.String,
  volumeId: Schema.String,
  /** UTC quarter-hour containing the source records. */
  bucketStartMs: Schema.Number,
  model: Schema.String,
  totals: Schema.Struct({
    uncachedInputTokens: Schema.Number,
    cachedInputTokens: Schema.Number,
    cacheCreationTokens: Schema.Number,
    outputTokens: Schema.Number,
    reasoningTokens: Schema.Number,
  }),
  pricedTotals: Schema.Struct({
    uncachedInputTokens: Schema.Number,
    cachedInputTokens: Schema.Number,
    cacheCreationTokens: Schema.Number,
    outputTokens: Schema.Number,
    reasoningTokens: Schema.Number,
  }),
  reportedCostUsd: Schema.Number,
  records: Schema.Number,
  unpricedRecords: Schema.Number,
  providerReportedRecords: Schema.Number,
  sessions: Schema.Array(Schema.String),
});
const UsageLedgerFileV1 = Schema.Struct({
  version: Schema.Literal(1),
  generatedAtMs: Schema.Number,
  records: Schema.Array(UsageLedgerRecord),
});
const UsageLedgerFile = Schema.Struct({
  version: Schema.Literal(2),
  generatedAtMs: Schema.Number,
  aggregates: Schema.Array(UsageLedgerAggregate),
  sources: Schema.Array(UsageSourceSchema),
});
const decodeUsageSnapshotFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    UsageSnapshotFile as unknown as Schema.Codec<typeof UsageSnapshotFile.Type>,
  ),
);
const encodeUsageSnapshotFile = Schema.encodeEffect(
  Schema.fromJsonString(
    UsageSnapshotFile as unknown as Schema.Codec<typeof UsageSnapshotFile.Type>,
  ),
);
const decodeUsageLedgerFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([UsageLedgerFile, UsageLedgerFileV1]) as unknown as Schema.Codec<
      typeof UsageLedgerFile.Type | typeof UsageLedgerFileV1.Type
    >,
  ),
);
const encodeUsageLedgerFile = Schema.encodeEffect(
  Schema.fromJsonString(UsageLedgerFile as unknown as Schema.Codec<typeof UsageLedgerFile.Type>),
);

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKGROUND_REFRESH_INTERVAL = "30 minutes";
const BACKGROUND_REFRESH_TIMEOUT = "5 minutes";
const MAX_USAGE_SNAPSHOTS = 16;
// Keep two days of timezone slack so a 90-day calendar window can be rebuilt
// after a UTC/local-midnight rollover without losing its first day.
const USAGE_LEDGER_RETENTION_MS = 92 * DAY_MS;

function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function previousCalendarDay(timeZone: string, nowMs: number): string {
  const today = makeDayFormatter(timeZone)(nowMs);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  return new Date(todayMs - DAY_MS).toISOString().slice(0, 10);
}

function formatInstant(epochMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(epochMs));
}

function snapshotKey(input: UsageSummaryInput): string {
  return JSON.stringify([
    input.timeZone,
    input.sinceDay,
    input.untilDay,
    input.resolution ?? "day",
    input.sinceTime ?? null,
    input.untilTime ?? null,
  ]);
}

function isCommonPreset(input: UsageSummaryInput): boolean {
  if (input.resolution === "hour") {
    if (input.sinceTime === undefined || input.untilTime === undefined) return false;
    return Date.parse(input.untilTime) - Date.parse(input.sinceTime) === DAY_MS;
  }
  const days =
    (Date.parse(`${input.untilDay}T00:00:00Z`) - Date.parse(`${input.sinceDay}T00:00:00Z`)) /
      DAY_MS +
    1;
  return days === 1 || days === 7 || days === 30 || days === 90;
}

function isCanonicalLedgerInput(input: UsageSummaryInput): boolean {
  if (input.resolution === "hour") return false;
  const days =
    (Date.parse(`${input.untilDay}T00:00:00Z`) - Date.parse(`${input.sinceDay}T00:00:00Z`)) /
      DAY_MS +
    1;
  return days === 90;
}

type SourceFingerprint = {
  readonly hostId: string;
  readonly provider: UsageProviderKind;
  readonly resolvedHomePath: string;
  readonly volumeId: string;
};

function sourceKey(source: SourceFingerprint): string {
  return JSON.stringify([source.hostId, source.provider, source.resolvedHomePath, source.volumeId]);
}

function ledgerAggregateKey(aggregate: {
  readonly hostId: string;
  readonly provider: UsageProviderKind;
  readonly resolvedHomePath: string;
  readonly volumeId: string;
  readonly bucketStartMs: number;
  readonly model: string;
}): string {
  return JSON.stringify([
    aggregate.hostId,
    aggregate.provider,
    aggregate.resolvedHomePath,
    aggregate.volumeId,
    aggregate.bucketStartMs,
    aggregate.model,
  ]);
}

function ledgerAggregateFromRecord(entry: {
  readonly hostId: string;
  readonly provider: UsageProviderKind;
  readonly resolvedHomePath: string;
  readonly volumeId: string;
  readonly record: UsageRecord;
}): LedgerAggregate {
  const { record } = entry;
  const reported = record.reportedCostUsd === null ? 0 : record.reportedCostUsd;
  return {
    hostId: entry.hostId,
    provider: entry.provider,
    resolvedHomePath: entry.resolvedHomePath,
    volumeId: entry.volumeId,
    bucketStartMs: Math.floor(record.timestampMs / (15 * 60 * 1000)) * (15 * 60 * 1000),
    model: record.model,
    totals: record.totals,
    // v1 did not persist pricing provenance. Preserve token totals and any
    // reported cost, but do not guess that unreported records were priced.
    pricedTotals: EMPTY_TOTALS,
    reportedCostUsd: reported,
    records: 1,
    unpricedRecords: record.reportedCostUsd === null ? 1 : 0,
    providerReportedRecords: record.reportedCostUsd === null ? 0 : 1,
    sessions: record.sessionId.length === 0 ? [] : [record.sessionId],
  };
}

function mergeLedgerAggregate(
  ledger: Map<string, LedgerAggregate>,
  incoming: LedgerAggregate,
): void {
  const key = ledgerAggregateKey(incoming);
  const existing = ledger.get(key);
  if (existing === undefined) {
    ledger.set(key, incoming);
    return;
  }
  const sessions = new Set(existing.sessions);
  for (const session of incoming.sessions) sessions.add(session);
  ledger.set(key, {
    ...existing,
    totals: addTotals(existing.totals, incoming.totals),
    pricedTotals: addTotals(existing.pricedTotals, incoming.pricedTotals),
    reportedCostUsd: existing.reportedCostUsd + incoming.reportedCostUsd,
    records: existing.records + incoming.records,
    unpricedRecords: existing.unpricedRecords + incoming.unpricedRecords,
    providerReportedRecords: existing.providerReportedRecords + incoming.providerReportedRecords,
    sessions: [...sessions],
  });
}

interface LedgerAggregate {
  readonly hostId: string;
  readonly provider: UsageProviderKind;
  readonly resolvedHomePath: string;
  readonly volumeId: string;
  readonly bucketStartMs: number;
  readonly model: string;
  readonly totals: UsageRecord["totals"];
  readonly pricedTotals: UsageRecord["totals"];
  readonly reportedCostUsd: number;
  readonly records: number;
  readonly unpricedRecords: number;
  readonly providerReportedRecords: number;
  readonly sessions: readonly string[];
}

interface ScanResult {
  readonly summary: UsageSummary;
  readonly ledgerAggregates: readonly LedgerAggregate[];
  readonly ledgerSources: UsageSummary["sources"];
  readonly scanStartedAtMs: number;
}

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    readonly refreshSummary: (
      input: UsageSummaryInput,
    ) => Effect.Effect<UsageSummary, UsageReadError>;
    readonly startBackgroundRefresh: Effect.Effect<void>;
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
        coverage: {
          availableThroughDay: input.untilDay,
          availableThroughTime: null,
          generatedAt: "1970-01-01T00:00:00.000Z",
        },
        scanDurationMs: 0,
      }),
    startBackgroundRefresh: Effect.void,
    refreshSummary: (_input) =>
      Effect.fail(
        new UsageReadError({ reason: "scanFailed", detail: "Usage refresh is unavailable." }),
      ),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcessEnvironment;

  const fileCache: ScanCache = new Map();
  let cacheDirty = false;
  const usageSnapshots = new Map<string, UsageSummary>();
  let snapshotsDirty = false;
  const scanSemaphore = yield* Semaphore.make(1);

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
  const usageSnapshotPath = path.join(config.stateDir, "usage-snapshot.json");
  const usageLedgerPath = path.join(config.stateDir, "usage-record-ledger.json");
  const usageLedger = new Map<string, LedgerAggregate>();
  const usageLedgerSources = new Map<string, UsageSummary["sources"][number]>();
  let usageLedgerGeneratedAtMs = 0;
  let usageLedgerDirty = false;
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsageSummary["pricing"]["status"] = "unavailable";

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing.
   */
  const ensureRates = Effect.fn("UsageService.ensureRates")(function* (allowNetwork = true) {
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

    if (!allowNetwork) return;

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

  /** Resolves the transcript directory for each provider. */
  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* () {
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
    // Grok Settings only expose the binary path; home is `$GROK_HOME` or `~/.grok`.
    // Empty/whitespace GROK_HOME must fall back: coalescing alone would scan cwd.
    const grokHomeEnv = hostEnvironment["GROK_HOME"]?.trim() ?? "";
    const grokHome =
      grokHomeEnv.length > 0
        ? path.resolve(expandHomePath(grokHomeEnv))
        : path.join(NodeOS.homedir(), ".grok");

    return [
      { provider: "claude" as const, dir: claudeDir },
      { provider: "codex" as const, dir: path.join(codexLayout.sharedHomePath, "sessions") },
      {
        provider: "grok" as const,
        dir: path.join(grokHome, "sessions"),
        fileName: "updates.jsonl",
      },
    ];
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

  /** Loads final summaries before serving the first usage request. */
  const ensureUsageSnapshotsLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const document = yield* fileSystem.readFileString(usageSnapshotPath).pipe(
        Effect.flatMap((raw) => decodeUsageSnapshotFile(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (document === null) return;
      for (const entry of document.entries) {
        usageSnapshots.set(entry.key, entry.summary);
      }
      for (const [key] of [...usageSnapshots.entries()]
        .toSorted(([, left], [, right]) =>
          (right.coverage?.generatedAt ?? right.readAt).localeCompare(
            left.coverage?.generatedAt ?? left.readAt,
          ),
        )
        .slice(MAX_USAGE_SNAPSHOTS)) {
        usageSnapshots.delete(key);
      }
    }),
  );

  const ensureUsageLedgerLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const document = yield* fileSystem.readFileString(usageLedgerPath).pipe(
        Effect.flatMap((raw) => decodeUsageLedgerFile(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (document === null) return;
      usageLedgerGeneratedAtMs = document.generatedAtMs;
      if (document.version === 2) {
        for (const source of document.sources) {
          usageLedgerSources.set(sourceKey(source.fingerprint), source);
        }
        for (const entry of document.aggregates) {
          usageLedger.set(ledgerAggregateKey(entry), entry);
        }
        return;
      }
      // Migrate the pre-v2 raw record ledger in memory. It is rewritten in
      // compact form after the next successful canonical refresh.
      for (const entry of document.records) {
        const aggregate = ledgerAggregateFromRecord(entry);
        mergeLedgerAggregate(usageLedger, aggregate);
      }
    }),
  );

  const persistUsageSnapshots = Effect.fn("UsageService.persistUsageSnapshots")(function* () {
    if (!snapshotsDirty) return;
    const entries = [...usageSnapshots.entries()]
      .toSorted(([, left], [, right]) =>
        (right.coverage?.generatedAt ?? right.readAt).localeCompare(
          left.coverage?.generatedAt ?? left.readAt,
        ),
      )
      .slice(0, MAX_USAGE_SNAPSHOTS)
      .map(([key, summary]) => ({ key, summary }));
    yield* encodeUsageSnapshotFile({ version: 1, entries }).pipe(
      Effect.flatMap((serialized) =>
        writeFileStringAtomically({ filePath: usageSnapshotPath, contents: serialized }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      ),
      Effect.map(() => {
        snapshotsDirty = false;
      }),
      // A durable snapshot is an optimization. A failed write leaves the
      // previous last-good file intact and the next refresh retries it.
      Effect.catchCause(() => Effect.void),
    );
  });

  const persistUsageLedger = Effect.fn("UsageService.persistUsageLedger")(function* () {
    if (!usageLedgerDirty) return;
    const aggregates = [...usageLedger.values()];
    yield* encodeUsageLedgerFile({
      version: 2,
      generatedAtMs: usageLedgerGeneratedAtMs,
      aggregates,
      sources: [...usageLedgerSources.values()],
    }).pipe(
      Effect.flatMap((serialized) =>
        writeFileStringAtomically({ filePath: usageLedgerPath, contents: serialized }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      ),
      Effect.map(() => {
        usageLedgerDirty = false;
      }),
      Effect.catchCause(() => Effect.void),
    );
  });

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

  /**
   * Parses one transcript, reusing the cached result when it is unchanged.
   *
   * A file that only grew re-parses from the cached position, so an actively
   * written multi-hundred-megabyte rollout costs its appended bytes per scan
   * rather than a full re-read. The reader verifies the position's guard bytes
   * and silently restarts from byte 0 when they no longer match.
   */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
  ): Effect.Effect<{ readonly records: readonly UsageRecord[]; readonly complete: boolean }> =>
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
        return {
          records:
            cached.tailRecords.length === 0
              ? cached.records
              : [...cached.records, ...cached.tailRecords],
          complete: true,
        };
      }

      // Only a strictly grown file may resume. Same size with a new mtime, or
      // a shrunken file, means rewritten content; re-parse it whole.
      const resumeFrom =
        cached !== undefined && cached.provider === provider && size > cached.size
          ? cached.position
          : undefined;

      const parsed = yield* Effect.promise(() =>
        readTranscriptRecords(filePath, provider, resumeFrom),
      );
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null) return { records: [], complete: false };

      // Stored already de-duplicated within the file, which is 99% of all
      // duplicates. The aggregator still runs the cross-file dedupe pass. One
      // seen set spans the cached base, the new lines, and the tail so a
      // resumed parse dedupes exactly like a full one.
      const base = parsed.resumed && cached !== undefined ? cached.records : [];
      const seen = new Set<string>();
      const records = dedupeWithinFile([...base, ...parsed.records], seen);
      const tailRecords = dedupeWithinFile(parsed.tailRecords, seen);

      fileCache.set(filePath, {
        size,
        mtimeMs,
        provider,
        records,
        tailRecords,
        position: parsed.position,
      });
      cacheDirty = true;
      return {
        records: tailRecords.length === 0 ? records : [...records, ...tailRecords],
        complete: true,
      };
    });

  /** One provider directory's walk and parse, before rates are involved. */
  interface ScannedDir {
    readonly provider: UsageProviderKind;
    readonly dir: string;
    readonly volumeId: string;
    /** Parsed records per file, or `null` when the directory does not exist. */
    readonly files:
      | readonly { readonly path: string; readonly records: readonly UsageRecord[] }[]
      | null;
    readonly complete: boolean;
  }

  const collectDirs = Effect.fn("UsageService.collectDirs")(function* (windowStartMs: number) {
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so the scan stays context-free.
    const dirs = yield* resolveTranscriptDirs().pipe(Effect.provideService(Path.Path, path));
    const scanned: ScannedDir[] = [];
    for (const { provider, dir, fileName } of dirs) {
      const volume = yield* Effect.promise(() => readDirectoryVolumeIdDetailed(dir));
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        scanned.push({
          provider,
          dir,
          volumeId: volume.volumeId,
          files: null,
          // Only stat's explicit ENOENT is a confirmed missing source. An
          // exists/stat disagreement can be a permission or I/O failure.
          complete: volume.status !== "failed",
        });
        continue;
      }
      const walk = yield* Effect.promise(() =>
        listTranscriptFilesDetailed(
          dir,
          windowStartMs,
          fileName === undefined ? undefined : { fileName },
        ),
      );
      let complete = volume.status === "ok" && walk.complete;
      const parsedFiles: { path: string; records: readonly UsageRecord[] }[] = [];
      for (const file of walk.files) {
        const result = yield* readFileRecords(file.path, file.size, file.mtimeMs, provider);
        if (!result.complete) complete = false;
        parsedFiles.push({ path: file.path, records: result.records });
      }
      scanned.push({ provider, dir, volumeId: volume.volumeId, files: parsedFiles, complete });
    }
    return scanned;
  });

  const scanSummary = Effect.fn("UsageService.scanSummary")(function* (input: UsageSummaryInput) {
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
    const completeThroughDay = previousCalendarDay(input.timeZone, startedAtMs);
    yield* ensureScanCacheLoaded;

    const hostId = NodeOS.hostname();
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    // Pricing only matters once records are aggregated, so the rate table
    // loads while transcripts stream instead of gating them: a cold rates
    // fetch on a slow network no longer delays the scan by its own timeout.
    const [, scannedDirs] = yield* Effect.all([ensureRates(), collectDirs(windowStartMs)], {
      concurrency: 2,
    });

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay:
        input.resolution === "hour" || input.untilDay < completeThroughDay
          ? input.untilDay
          : UsageDay.make(completeThroughDay),
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
    });

    const sources: UsageSource[] = [];
    const ledgerAggregates = new Map<string, LedgerAggregate>();
    const ledgerSeen = new Set<string>();
    const ledgerStartMs = startedAtMs - USAGE_LEDGER_RETENTION_MS;
    const livePaths = new Set<string>();
    const walkedRoots: string[] = [];

    let scanComplete = true;
    for (const { provider, dir, volumeId, files, complete } of scannedDirs) {
      if (!complete) scanComplete = false;
      if (files === null) {
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
      let scannedFiles = 0;
      let skippedFiles = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();

      for (const file of files) {
        livePaths.add(file.path);
        if (file.records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        for (const record of file.records) {
          // Only sessions that contributed in-window count: the mtime slack
          // admits boundary files whose records fall outside the range.
          if (aggregator.add(record) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }

          // The canonical ledger is normalized independently of the requested
          // viewer zone. Keep quarter-hour cells so IANA offsets at :30/:45
          // and rolling windows aligned to the half hour can be rebucketed
          // without retaining every transcript record.
          const dedupeKey =
            record.dedupeKey === null
              ? null
              : `${hostId}\u0000${provider}\u0000${dir}\u0000${volumeId}\u0000${record.dedupeKey}`;
          if (dedupeKey !== null) {
            if (ledgerSeen.has(dedupeKey)) continue;
            ledgerSeen.add(dedupeKey);
          }
          if (record.timestampMs < ledgerStartMs || record.timestampMs >= startedAtMs) continue;

          const priced = priceUsage(rates, record.model, record.totals, record.reportedCostUsd);
          const aggregate: LedgerAggregate = {
            hostId,
            provider,
            resolvedHomePath: dir,
            volumeId,
            bucketStartMs: Math.floor(record.timestampMs / (15 * 60 * 1000)) * (15 * 60 * 1000),
            model: record.model,
            totals: record.totals,
            pricedTotals: priced.costSource === "modelPriced" ? record.totals : EMPTY_TOTALS,
            reportedCostUsd:
              priced.costSource === "providerReported" ? (record.reportedCostUsd ?? 0) : 0,
            records: 1,
            unpricedRecords: priced.costSource === "unpriced" ? 1 : 0,
            providerReportedRecords: priced.costSource === "providerReported" ? 1 : 0,
            sessions: record.sessionId.length === 0 ? [] : [record.sessionId],
          };
          mergeLedgerAggregate(ledgerAggregates, aggregate);
        }
      }

      sources.push({
        fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
        status: "ok",
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message: null,
      });
    }

    if (!scanComplete) {
      return yield* new UsageReadError({
        reason: "scanFailed",
        detail:
          "Usage refresh could not read every transcript file; the last-good snapshot remains active.",
      });
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
    const availableThroughDay =
      hourlyWindow === null
        ? input.untilDay < completeThroughDay
          ? input.untilDay
          : UsageDay.make(completeThroughDay)
        : UsageDay.make(makeDayFormatter(input.timeZone)(hourlyWindow.untilTimeMs - 1));
    const availableThroughTime =
      hourlyWindow === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(Math.min(hourlyWindow.untilTimeMs, startedAtMs)));

    return {
      summary: {
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
        coverage: {
          availableThroughDay,
          availableThroughTime,
          generatedAt: DateTime.formatIso(DateTime.makeUnsafe(startedAtMs)),
        },
        scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
      },
      ledgerAggregates: [...ledgerAggregates.values()],
      ledgerSources: sources,
      scanStartedAtMs: startedAtMs,
    } satisfies ScanResult;
  });

  /**
   * In-flight scans by window, so concurrent identical requests (the usage
   * page open on two clients at once) share one scan instead of racing over
   * the same corpus twice.
   */
  const inflightScans = new Map<string, Deferred.Deferred<UsageSummary, UsageReadError>>();
  let canonicalRefreshWaiter: Deferred.Deferred<
    Exit.Exit<UsageSummary, UsageReadError>,
    never
  > | null = null;

  const scanKey = snapshotKey;

  const scanAndPersist = (input: UsageSummaryInput) => {
    const scan = (isCanonicalLedgerInput(input) ? ensureUsageLedgerLoaded : Effect.void).pipe(
      Effect.andThen(scanSummary(input)),
      Effect.tap((result) =>
        Effect.sync(() => {
          const summary = result.summary;
          usageSnapshots.set(scanKey(input), summary);
          while (usageSnapshots.size > MAX_USAGE_SNAPSHOTS) {
            const oldest = [...usageSnapshots.entries()].toSorted(([, left], [, right]) =>
              (left.coverage?.generatedAt ?? left.readAt).localeCompare(
                right.coverage?.generatedAt ?? right.readAt,
              ),
            )[0];
            if (oldest === undefined) break;
            usageSnapshots.delete(oldest[0]);
          }
          snapshotsDirty = true;
          if (isCanonicalLedgerInput(input)) {
            // A complete canonical scan is a replacement, not a merge. This
            // removes records for deleted or rewritten transcripts while the
            // last-good file remains intact if the scan failed above.
            usageLedger.clear();
            usageLedgerSources.clear();
            for (const aggregate of result.ledgerAggregates) {
              usageLedger.set(ledgerAggregateKey(aggregate), aggregate);
            }
            for (const source of result.ledgerSources) {
              usageLedgerSources.set(sourceKey(source.fingerprint), source);
            }
            usageLedgerGeneratedAtMs = result.scanStartedAtMs;
            usageLedgerDirty = true;
          }
        }).pipe(Effect.andThen(persistUsageSnapshots), Effect.andThen(persistUsageLedger)),
      ),
    );
    // Reject malformed day ranges before entering the serialized lane. This
    // keeps invalid requests synchronous and cannot consume the scan permit.
    const summary = scan.pipe(Effect.map((result) => result.summary));
    return input.sinceDay > input.untilDay ? summary : scanSemaphore.withPermits(1)(summary);
  };

  const runBackgroundRefresh = (input: UsageSummaryInput) => {
    const requestedCommonPreset = isCommonPreset(input);
    if (!requestedCommonPreset && !isCanonicalLedgerInput(input)) return scanAndPersist(input);
    // Do not enroll a waiter while merely constructing the effect. An
    // unauthorized RPC can construct and discard this effect before it ever
    // executes, which would otherwise wedge all later canonical refreshes.
    return Effect.suspend(() =>
      Effect.gen(function* () {
        const canonicalSummary = (summary: UsageSummary) =>
          requestedCommonPreset && !isCanonicalLedgerInput(input)
            ? readPresetFromLedger(input).pipe(
                Effect.flatMap((preset) =>
                  preset === null
                    ? Effect.fail(
                        new UsageReadError({
                          reason: "scanFailed",
                          detail: "The canonical usage refresh did not complete.",
                        }),
                      )
                    : Effect.succeed(preset),
                ),
              )
            : Effect.succeed(summary);

        if (canonicalRefreshWaiter !== null) {
          const summary = yield* awaitCanonicalRefresh();
          return yield* summary === null
            ? Effect.fail(
                new UsageReadError({
                  reason: "scanFailed",
                  detail: "The canonical usage refresh did not complete.",
                }),
              )
            : canonicalSummary(summary);
        }

        const waiter = Deferred.makeUnsafe<Exit.Exit<UsageSummary, UsageReadError>, never>();
        canonicalRefreshWaiter = waiter;
        const canonicalInput = isCanonicalLedgerInput(input)
          ? input
          : (yield* defaultDailyInputs)[0]!;
        const summary = yield* scanAndPersist(canonicalInput).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (canonicalRefreshWaiter === waiter) canonicalRefreshWaiter = null;
            }).pipe(Effect.andThen(Deferred.succeed(waiter, exit))),
          ),
        );
        return yield* canonicalSummary(summary);
      }),
    );
  };

  const awaitCanonicalRefresh = () =>
    canonicalRefreshWaiter === null
      ? Effect.succeed(null)
      : Deferred.await(canonicalRefreshWaiter).pipe(
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.succeed(null),
          ),
        );

  /** Derives a requested preset from the durable normalized record ledger. */
  const readPresetFromLedger = Effect.fn("UsageService.readPresetFromLedger")(function* (
    input: UsageSummaryInput,
  ) {
    yield* ensureUsageLedgerLoaded;
    if (usageLedgerGeneratedAtMs <= 0 && canonicalRefreshWaiter !== null) {
      yield* awaitCanonicalRefresh();
    }
    // `generatedAtMs` is the scan marker. An empty ledger is a valid complete
    // zero snapshot and must not be confused with a never-scanned ledger.
    if (usageLedgerGeneratedAtMs <= 0) return null;
    // Preset reads are foreground-fast and may use a durable cached rate
    // table, but never perform a network fetch. Background/manual scans own
    // rate refreshes.
    yield* ensureRates(false);

    const generatedAtMs = usageLedgerGeneratedAtMs;
    const completeThroughDay = previousCalendarDay(input.timeZone, generatedAtMs);
    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      if (input.sinceTime === undefined || input.untilTime === undefined) return null;
      const sinceTimeMs = Date.parse(input.sinceTime);
      const observedUntilMs = Math.min(Date.parse(input.untilTime), generatedAtMs);
      if (!Number.isFinite(sinceTimeMs) || observedUntilMs <= sinceTimeMs) return null;
      const completeHours = Math.floor((observedUntilMs - sinceTimeMs) / (60 * 60 * 1000));
      const untilTimeMs = sinceTimeMs + completeHours * 60 * 60 * 1000;
      if (untilTimeMs <= sinceTimeMs) return null;
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const effectiveUntil =
      input.resolution === "hour"
        ? input.untilDay
        : input.untilDay < completeThroughDay
          ? input.untilDay
          : UsageDay.make(completeThroughDay);
    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: effectiveUntil,
      resolution: input.resolution ?? "day",
      ...(hourlyWindow ?? {}),
      rates,
    });
    const sessions = new Map<string, Set<string>>();
    for (const entry of usageLedger.values()) {
      if (!aggregator.addAggregate(entry)) continue;
      const key = sourceKey(entry);
      const sourceSessions = sessions.get(key) ?? new Set<string>();
      for (const session of entry.sessions) sourceSessions.add(session);
      sessions.set(key, sourceSessions);
    }
    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const availableThroughTime =
      hourlyWindow === null ? null : formatInstant(hourlyWindow.untilTimeMs);
    const sourceEntries = new Map<string, UsageSource>();
    for (const [key, source] of usageLedgerSources) {
      sourceEntries.set(key, {
        ...source,
        distinctSessions: sessions.get(key)?.size ?? 0,
      });
    }
    // v1 ledgers had no source metadata. Reconstruct it from the aggregates so
    // old installs remain readable until their next canonical refresh.
    for (const entry of usageLedger.values()) {
      const key = sourceKey(entry);
      if (sourceEntries.has(key)) continue;
      sourceEntries.set(key, {
        fingerprint: {
          hostId: entry.hostId,
          provider: entry.provider,
          resolvedHomePath: entry.resolvedHomePath,
          volumeId: entry.volumeId,
        },
        status: "ok",
        scannedFiles: 0,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: sessions.get(key)?.size ?? 0,
        message: null,
      });
    }
    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources: [...sourceEntries.values()],
      pricing: {
        status: ratesStatus,
        source: LITELLM_RATES_URL,
        fetchedAt: ratesFetchedAtMs === null ? null : formatInstant(ratesFetchedAtMs),
        knownModels: rates.size,
      },
      coverage: {
        availableThroughDay:
          input.resolution === "hour"
            ? UsageDay.make(makeDayFormatter(input.timeZone)(hourlyWindow!.untilTimeMs - 1))
            : effectiveUntil,
        availableThroughTime,
        generatedAt: formatInstant(generatedAtMs),
      },
      scanDurationMs: 0,
    } satisfies UsageSummary;
  });

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    const key = scanKey(input);
    const cached = usageSnapshots.get(key);
    if (cached !== undefined) return cached;
    if (isCommonPreset(input)) {
      const normalized = yield* readPresetFromLedger(input);
      if (normalized !== null) return normalized;
      return yield* new UsageReadError({
        reason: "scanFailed",
        detail: "Usage preset is waiting for the next background snapshot.",
      });
    }

    const deferred = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = inflightScans.get(key);
        if (existing !== undefined) return existing;

        // Enrollment and detached-fiber creation must be atomic. Otherwise a
        // canceled first caller can leave a Deferred with no scan to finish it.
        const created = Deferred.makeUnsafe<UsageSummary, UsageReadError>();
        inflightScans.set(key, created);
        // Detached so one departing client cannot tear the scan out from under
        // the fibers awaiting it; a finished scan warms the cache either way.
        yield* scanAndPersist(input).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => inflightScans.delete(key)).pipe(
              Effect.andThen(Deferred.done(created, exit)),
            ),
          ),
          Effect.forkDetach,
        );
        return created;
      }),
    );
    // Waiting stays interruptible. The detached scan continues for other
    // callers and still warms the cache if this caller leaves.
    return yield* Deferred.await(deferred);
  });

  const refreshSummary = (input: UsageSummaryInput) => runBackgroundRefresh(input);

  const defaultDailyInputs = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const timeZone = serverTimeZone();
    const untilDay = previousCalendarDay(timeZone, nowMs);
    const untilMs = Date.parse(`${untilDay}T00:00:00Z`);
    const sinceDay = new Date(untilMs - 89 * DAY_MS).toISOString().slice(0, 10);
    // One canonical retention-window scan populates the normalized ledger.
    // Every daily and rolling hourly preset is derived from it without a
    // second corpus walk or ledger rewrite.
    return [
      {
        sinceDay: UsageDay.make(sinceDay),
        untilDay: UsageDay.make(untilDay),
        timeZone,
        resolution: "day" as const,
      } satisfies UsageSummaryInput,
    ];
  });

  const startBackgroundRefresh = Effect.gen(function* () {
    const refresh = Effect.gen(function* () {
      const inputs = yield* defaultDailyInputs;
      yield* Effect.forEach(
        inputs,
        (input) =>
          runBackgroundRefresh(input).pipe(
            Effect.timeout(BACKGROUND_REFRESH_TIMEOUT),
            Effect.ignore,
          ),
        {
          concurrency: 1,
          discard: true,
        },
      );
    }).pipe(
      Effect.tapCause((cause) => Effect.logWarning("Usage background refresh failed", { cause })),
      Effect.ignore,
    );

    yield* refresh;
    return yield* Effect.forever(
      Effect.sleep(BACKGROUND_REFRESH_INTERVAL).pipe(Effect.andThen(refresh)),
    );
  });

  yield* Effect.uninterruptible(ensureUsageSnapshotsLoaded);
  return { readSummary, refreshSummary, startBackgroundRefresh } as const;
});

export const layer = Layer.effect(UsageService, make);
