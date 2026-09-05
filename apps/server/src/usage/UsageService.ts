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
  type ServerSettings as ServerSettingsValue,
  type UsageProviderKind,
  type UsageSource,
  type UsagePricing,
  type UsageSummary,
  type UsageSummaryInput,
  type UsageThreadBreakdown,
  type UsageThreadBreakdownInput,
  UsageReadError,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import {
  providerResumeCursorSessionId,
  readProviderResumeCursorHistory,
} from "../provider/providerResumeCursorHistory.ts";
import { makeProjectResolver, UsageAggregator } from "./usageAggregation.ts";
import { dedicatedUsageWorktreePath, normalizeUsagePath } from "./usagePaths.ts";
import { createOverrideRateTable, parseRateTable, type RateTable } from "./usagePricing.ts";
import {
  listTranscriptFiles,
  readCodexTranscriptIdentity,
  readDirectoryVolumeId,
  readTranscriptRecords,
  readTranscriptTitle,
} from "./usageTranscriptReader.ts";
import { foldThreadRows, ThreadUsageAccumulator, type ThreadRef } from "./usageThreads.ts";
import {
  decodeScanCache,
  decodeScanIdentityCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanIdentityCache,
  pruneScanCache,
  type ScanCache,
  type ScanIdentityCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

/** An explicit refresh ignores the TTL, but not a table fetched this recently. */
const RATES_REFRESH_FLOOR_MS = 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Match the client query TTL so changing a date range does not rescan fresh sources. */
const SOURCE_SCAN_TTL_MS = 60 * 1000;

/** Longest window the UI offers, plus slack. Older entries are pruned. */
const CACHE_RETENTION_DAYS = 90;

/**
 * Maximum rows sent per breakdown request, including grouped remainders. A
 * window can hold thousands of sessions, so lower-cost rows fold together.
 */
const THREAD_ROW_CAP = 40;

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
const encodeSourceKey = Schema.encodeSync(ScanCacheJson);

export function isValidUsageDay(day: string): boolean {
  const parsed = DateTime.make(`${day}T00:00:00Z`);
  return Option.isSome(parsed) && DateTime.formatIso(parsed.value).slice(0, 10) === day;
}

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    readonly readThreadBreakdown: (
      input: UsageThreadBreakdownInput,
    ) => Effect.Effect<UsageThreadBreakdown, UsageReadError>;
    /** Refetches the rate table ahead of its TTL. See `ensureRates`. */
    readonly refreshRates: Effect.Effect<UsagePricing>;
  }
>()("t3/usage/UsageService") {}

const EMPTY_PRICING: UsagePricing = {
  status: "unavailable",
  source: LITELLM_RATES_URL,
  fetchedAt: null,
  knownModels: 0,
};

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
        pricing: EMPTY_PRICING,
        scanDurationMs: 0,
      }),
    readThreadBreakdown: (input) =>
      Effect.succeed({
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        rows: [],
        truncatedRows: 0,
        scanDurationMs: 0,
      }),
    refreshRates: Effect.succeed(EMPTY_PRICING),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcessEnvironment;
  const projectRepository = yield* ProjectionProjectRepository;
  const threadRepository = yield* ProjectionThreadRepository;
  const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

  const fileCache: ScanCache = new Map();
  const fileIdentityCache: ScanIdentityCache = new Map();
  let cacheRevision = 0;
  let persistedCacheRevision = 0;
  const cachePersistSemaphore = yield* Semaphore.make(1);

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsagePricing["status"] = "unavailable";
  // One fetch at a time. A burst of refreshes from several clients waits on
  // the first fetch and then sees a table young enough to skip its own.
  const ratesLock = yield* Semaphore.make(1);

  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source: LITELLM_RATES_URL,
    fetchedAt:
      ratesFetchedAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
    knownModels: rates.size,
  });

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing. `force` refetches inside the TTL so a model that
   * LiteLLM added since the last fetch gets priced now.
   */
  const loadRates = Effect.fn("UsageService.loadRates")(function* (force: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return;

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
          if (now - fromDisk.fetchedAtMs < maxAgeMs) return;
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

  const ensureRates = (force: boolean) => ratesLock.withPermit(loadRates(force));

  const refreshRates = ensureRates(true).pipe(
    Effect.map(pricing),
    Effect.withSpan("UsageService.refreshRates"),
  );

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

  // A settings failure must not silently discard custom rates or transcript homes.
  const readSettings = settingsService.getSettings.pipe(
    Effect.catchCause(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Server settings could not be read.",
          cause: Cause.squash(cause),
        }),
    ),
  );

  /** Resolves the transcript directory for each provider. */
  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* (
    settings: ServerSettingsValue,
  ) {
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
   * Builds the cwd → project-title resolver for one scan.
   *
   * Projects are re-read every scan so a project created or renamed since the
   * last refresh attributes correctly. A repository failure degrades to "no
   * attribution" rather than failing the page.
   */
  const resolveProjects = Effect.fn("UsageService.resolveProjects")(function* () {
    const projects = yield* projectRepository
      .listAll()
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (projects === null) return undefined;
    const projectRoots = yield* Effect.forEach(
      projects,
      Effect.fnUntraced(function* (project) {
        const threads = yield* threadRepository
          .listByProjectId({ projectId: project.projectId })
          .pipe(Effect.catchCause(() => Effect.succeed<readonly never[]>([])));
        const root = {
          projectId: project.projectId,
          workspaceRoot: project.workspaceRoot,
          title: project.title,
          deleted: project.deletedAt !== null,
        };
        return [
          root,
          ...threads.flatMap((thread) =>
            thread.worktreePath === null ? [] : [{ ...root, workspaceRoot: thread.worktreePath }],
          ),
        ];
      }),
      { concurrency: 8 },
    );
    return makeProjectResolver(projectRoots.flat());
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
      for (const [path, entry] of decodeScanIdentityCache(document)) {
        fileIdentityCache.set(path, entry);
      }
    }),
  );

  const persistScanCacheUnlocked = Effect.fn("UsageService.persistScanCacheUnlocked")(function* () {
    if (cacheRevision === persistedCacheRevision) return;
    const revision = cacheRevision;
    yield* encodeScanCacheFile(encodeScanCache(fileCache, fileIdentityCache)).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(scanCachePath, serialized)),
      Effect.map(() => {
        persistedCacheRevision = revision;
      }),
      // A cache we cannot write is a slower next start, not a failed read.
      Effect.catchCause(() => Effect.void),
    );
  });
  const persistScanCache = () => cachePersistSemaphore.withPermits(1)(persistScanCacheUnlocked());

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
  ): Effect.Effect<readonly UsageRecord[]> =>
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
        return cached.tailRecords.length === 0
          ? cached.records
          : dedupeWithinFile([...cached.records, ...cached.tailRecords]);
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
      if (parsed === null) return [];

      // Stored already de-duplicated within the file, which is 99% of all
      // duplicates. The final snapshot wins so a resumed Claude parse can
      // replace an earlier progressive snapshot from the cached base.
      const base = parsed.resumed && cached !== undefined ? cached.records : [];
      const records = dedupeWithinFile([...base, ...parsed.records]);
      const tailRecords = dedupeWithinFile(parsed.tailRecords);

      fileCache.set(filePath, {
        size,
        mtimeMs,
        provider,
        records,
        tailRecords,
        position: parsed.position,
      });
      if (provider === "codex") {
        const state = parsed.position.codexState;
        fileIdentityCache.set(filePath, {
          size,
          mtimeMs,
          provider,
          sessionId: state?.sessionId ?? "",
          cwd: state?.cwd ?? "",
        });
      }
      cacheRevision += 1;
      return tailRecords.length === 0 ? records : dedupeWithinFile([...records, ...tailRecords]);
    });

  /** Reads and caches the bounded Codex preamble used for thread prefiltering. */
  const readFileIdentity = Effect.fn("UsageService.readFileIdentity")(function* (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
  ) {
    const cached = fileIdentityCache.get(filePath);
    if (
      cached !== undefined &&
      cached.size === size &&
      cached.mtimeMs === mtimeMs &&
      cached.provider === provider
    ) {
      return cached;
    }
    if (provider !== "codex") return null;

    // I/O failures are not negative identities. Skip this read without
    // caching it so the next request can retry an otherwise valid rollout.
    const read = yield* Effect.tryPromise(() => readCodexTranscriptIdentity(filePath)).pipe(
      Effect.option,
    );
    if (Option.isNone(read)) return null;

    const identity = {
      size,
      mtimeMs,
      provider,
      sessionId: read.value?.sessionId ?? "",
      cwd: read.value?.cwd ?? "",
    } as const;
    fileIdentityCache.set(filePath, identity);
    cacheRevision += 1;
    return identity;
  });

  /** One provider directory's walk and parse, before rates are involved. */
  interface ScannedDir {
    readonly provider: UsageProviderKind;
    readonly dir: string;
    readonly volumeId: string;
    readonly allPaths: ReadonlySet<string>;
    /** Parsed records per file, or `null` when the directory does not exist. */
    readonly files:
      | readonly { readonly path: string; readonly records: readonly UsageRecord[] }[]
      | null;
  }

  interface SourceSnapshot {
    readonly completedAtMs: number;
    readonly windowStartMs: number;
    readonly sourceKey: string;
    readonly dirs: readonly ScannedDir[];
  }

  let sourceSnapshot: SourceSnapshot | null = null;
  let lastRefreshToken: string | null = null;
  const sourceScanSemaphore = yield* Semaphore.make(1);

  const collectDirs = Effect.fn("UsageService.collectDirs")(function* (
    windowStartMs: number,
    settings: ServerSettingsValue,
  ) {
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so the scan stays context-free.
    const dirs = yield* resolveTranscriptDirs(settings).pipe(
      Effect.provideService(Path.Path, path),
    );
    const scanned: ScannedDir[] = [];
    for (const { provider, dir, fileName } of dirs) {
      const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        scanned.push({ provider, dir, volumeId, allPaths: new Set(), files: null });
        continue;
      }
      const allPaths = new Set<string>();
      const files = yield* Effect.promise(() =>
        listTranscriptFiles(dir, windowStartMs, {
          ...(fileName === undefined ? {} : { fileName }),
          onFile: (filePath) => allPaths.add(filePath),
        }),
      );
      const parsedFiles: { path: string; records: readonly UsageRecord[] }[] = [];
      for (const file of files) {
        const records = yield* readFileRecords(file.path, file.size, file.mtimeMs, provider);
        parsedFiles.push({ path: file.path, records });
      }
      scanned.push({ provider, dir, volumeId, allPaths, files: parsedFiles });
    }
    return scanned;
  });

  const getSourceSnapshot = Effect.fn("UsageService.getSourceSnapshot")(function* (
    windowStartMs: number,
    refreshToken: string | undefined,
    settings: ServerSettingsValue,
  ) {
    return yield* sourceScanSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const startedAtMs = yield* Clock.currentTimeMillis;
        const currentSnapshot = sourceSnapshot;
        const snapshotAgeMs =
          currentSnapshot === null
            ? Number.POSITIVE_INFINITY
            : startedAtMs - currentSnapshot.completedAtMs;
        const snapshotCoversWindow =
          currentSnapshot !== null && currentSnapshot.windowStartMs <= windowStartMs;
        const sourceKey = encodeSourceKey([
          settings.providers.claudeAgent,
          settings.providers.codex,
        ]);
        const snapshotCoversSources = currentSnapshot?.sourceKey === sourceKey;
        const manualRefresh = refreshToken !== undefined && refreshToken !== lastRefreshToken;

        if (
          !manualRefresh &&
          currentSnapshot !== null &&
          snapshotCoversWindow &&
          snapshotCoversSources &&
          snapshotAgeMs < SOURCE_SCAN_TTL_MS
        ) {
          return currentSnapshot;
        }

        // Preserve the widest coverage already loaded. A stale narrow request
        // should update changed files, not discard older records and force the
        // next wider range to read them again.
        const scanWindowStartMs = Math.min(
          windowStartMs,
          currentSnapshot?.windowStartMs ?? windowStartMs,
        );

        // Pricing only matters once records are aggregated, so the rate table
        // loads while transcripts stream instead of gating them: a cold rates
        // fetch on a slow network no longer delays the scan by its own timeout.
        const [, dirs] = yield* Effect.all(
          [ensureRates(false), collectDirs(scanWindowStartMs, settings)],
          { concurrency: 2 },
        );
        const now = yield* Clock.currentTimeMillis;
        const completedAtMs = Math.max(now, (currentSnapshot?.completedAtMs ?? now - 1) + 1);
        const nextSnapshot = {
          completedAtMs,
          windowStartMs: scanWindowStartMs,
          sourceKey,
          dirs,
        } satisfies SourceSnapshot;
        sourceSnapshot = nextSnapshot;
        if (refreshToken !== undefined) lastRefreshToken = refreshToken;
        return nextSnapshot;
      }),
    );
  });

  const getReusableSourceSnapshot = Effect.fn("UsageService.getReusableSourceSnapshot")(function* (
    windowStartMs: number,
    settings: ServerSettingsValue,
  ) {
    return yield* sourceScanSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const currentSnapshot = sourceSnapshot;
        if (currentSnapshot === null) return null;
        const now = yield* Clock.currentTimeMillis;
        const sourceKey = encodeSourceKey([
          settings.providers.claudeAgent,
          settings.providers.codex,
        ]);
        return currentSnapshot.windowStartMs <= windowStartMs &&
          currentSnapshot.sourceKey === sourceKey &&
          now - currentSnapshot.completedAtMs < SOURCE_SCAN_TTL_MS
          ? currentSnapshot
          : null;
      }),
    );
  });

  const scanSummary = Effect.fn("UsageService.scanSummary")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
  ) {
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
    const currentSnapshot = yield* getSourceSnapshot(windowStartMs, input.refreshToken, settings);
    const scannedDirs = currentSnapshot.dirs;
    const sourceReadAtMs = currentSnapshot.completedAtMs;

    const resolveProject = yield* resolveProjects();
    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      ...(resolveProject === undefined ? {} : { resolveProject }),
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
    });

    const sources: UsageSource[] = [];
    const livePaths = new Set<string>();
    const allPaths = new Set<string>();
    const walkedRoots: string[] = [];

    for (const { provider, dir, volumeId, allPaths: dirPaths, files } of scannedDirs) {
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
      for (const filePath of dirPaths) allPaths.add(filePath);
      let scannedFiles = 0;
      let skippedFiles = 0;
      for (const file of files) {
        livePaths.add(file.path);
        if (file.records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        for (const record of file.records) {
          aggregator.add(record);
        }
      }

      sources.push({
        fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
        status: "ok",
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        // Read from the settled records so a progressive snapshot replacement
        // cannot leave the source count attached to the superseded session.
        distinctSessions: aggregator.distinctSessions(provider),
        message: null,
      });
    }

    const pruned = pruneScanCache(fileCache, {
      livePaths,
      walkedRoots,
      windowStartMs,
      retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    });
    if (pruned > 0) cacheRevision += 1;
    const prunedIdentities = pruneScanIdentityCache(fileIdentityCache, {
      livePaths: allPaths,
      walkedRoots,
    });
    if (prunedIdentities > 0) cacheRevision += 1;
    yield* persistScanCache();

    const aggregated = aggregator.finish();
    const finishedAtMs = yield* Clock.currentTimeMillis;

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(DateTime.makeUnsafe(sourceReadAtMs)),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      pricing: pricing(),
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  /**
   * In-flight scans by window and custom prices, so concurrent identical requests (the usage
   * page open on two clients at once) share one scan instead of racing over
   * the same corpus twice.
   */
  const inflightScans = new Map<string, Deferred.Deferred<UsageSummary, UsageReadError>>();

  const scanKey = (
    input: UsageSummaryInput,
    priceOverrides: ServerSettingsValue["usagePriceOverrides"],
  ): string =>
    JSON.stringify([
      input.timeZone,
      input.sinceDay,
      input.untilDay,
      input.resolution ?? "day",
      input.sinceTime ?? null,
      input.untilTime ?? null,
      input.refreshToken ?? null,
      priceOverrides,
    ]);

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    const settings = yield* readSettings;
    const key = scanKey(input, settings.usagePriceOverrides);
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
        yield* scanSummary(input, settings).pipe(
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

  /**
   * Maps each thread's current provider session to the thread, from resume
   * cursors. Historic sessions of the same thread attribute through the
   * worktree map instead; sessions that never ran through T3 Code stay
   * session-granular.
   */
  const loadThreadAttribution = Effect.fn("UsageService.loadThreadAttribution")(function* () {
    const sessionToThread = new Map<string, ThreadRef>();
    const worktreeToThread = new Map<string, ThreadRef>();
    const titles = new Map<string, string>();

    const projects = yield* projectRepository
      .listAll()
      .pipe(Effect.catch(() => Effect.succeed<readonly never[]>([])));
    const worktreeClaims = new Map<string, { ref: ThreadRef; shared: boolean }>();
    for (const project of projects) {
      const threads = yield* threadRepository
        .listByProjectId({ projectId: project.projectId })
        .pipe(Effect.catchCause(() => Effect.succeed<readonly never[]>([])));
      for (const thread of threads) {
        const title = thread.title.trim();
        if (title.length > 0) titles.set(thread.threadId, title);
        const worktree = dedicatedUsageWorktreePath(project.workspaceRoot, thread.worktreePath);
        // The project root is not a dedicated worktree: interactive sessions
        // run there too, and several threads usually share it.
        if (worktree === null) continue;
        const ref: ThreadRef = { threadId: thread.threadId, title: title || thread.threadId };
        const claim = worktreeClaims.get(worktree);
        if (claim === undefined) worktreeClaims.set(worktree, { ref, shared: false });
        else claim.shared = true;
      }
    }
    for (const [worktree, claim] of worktreeClaims) {
      if (!claim.shared) worktreeToThread.set(worktree, claim.ref);
    }

    const runtimes = yield* runtimeRepository.list().pipe(
      Effect.catchCause(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Provider runtime state could not be read",
            cause: Cause.squash(cause),
          }),
      ),
    );
    for (const runtime of runtimes) {
      for (const sessionKey of runtimeUsageSessionKeys(
        runtime.providerName,
        runtime.resumeCursor,
        runtime.runtimePayload,
      )) {
        sessionToThread.set(sessionKey, {
          threadId: runtime.threadId,
          title: titles.get(runtime.threadId) ?? runtime.threadId,
        });
      }
    }

    return { sessionToThread, worktreeToThread };
  });

  const readThreadBreakdown = Effect.fn("UsageService.readThreadBreakdown")(function* (
    input: UsageThreadBreakdownInput,
  ) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    const windowEnd = DateTime.make(`${input.untilDay}T00:00:00Z`);
    if (
      Option.isNone(windowStart) ||
      Option.isNone(windowEnd) ||
      !isValidUsageDay(input.sinceDay) ||
      !isValidUsageDay(input.untilDay)
    ) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: "Thread usage requires valid sinceDay and untilDay dates",
      });
    }

    let exactWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.sinceTime !== undefined || input.untilTime !== undefined) {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Thread usage requires both valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Thread usage exact window must be greater than zero and at most 24 hours",
        });
      }
      exactWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    const settings = yield* readSettings;
    yield* ensureRates(false);
    yield* ensureScanCacheLoaded;
    const attribution = yield* loadThreadAttribution();
    const target =
      input.threadId === undefined ? null : threadTranscriptTarget(attribution, input.threadId);

    const windowStartMs =
      (exactWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;
    // Reuse a summary's fresh parsed snapshot when one exists, so a grown
    // transcript cannot make its drill-down disagree during the source TTL.
    // A thread-only read keeps the targeted identity scan below instead of
    // cold-parsing the entire provider corpus.
    const currentSnapshot = yield* getReusableSourceSnapshot(windowStartMs, settings);

    const resolveProject = yield* resolveProjects();
    const accumulator = new ThreadUsageAccumulator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      ...exactWindow,
      rates,
      ...(resolveProject === undefined ? {} : { resolveProject }),
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
    });

    // Preferred transcript per session for title extraction: the main file,
    // never a subagent's.
    const titleFiles = new Map<
      string,
      { readonly path: string; readonly provider: UsageProviderKind }
    >();
    const livePaths = new Set<string>();
    const allPaths = new Set<string>();
    const walkedRoots: string[] = [];

    const addRecords = (
      provider: UsageProviderKind,
      filePath: string,
      records: readonly UsageRecord[],
    ) => {
      if (records.length === 0) return;
      const isSubagent =
        provider === "claude" && path.basename(path.dirname(filePath)) === "subagents";
      const agentId = isSubagent ? path.basename(filePath, ".jsonl") : null;
      for (const record of records) {
        const sessionKey =
          record.sessionId.length > 0
            ? `${provider}:${record.sessionId}`
            : `${provider}:file:${path.basename(path.dirname(filePath))}:${path.basename(filePath, ".jsonl")}`;
        accumulator.add(record, { sessionKey, agentId });
        if (!isSubagent && !titleFiles.has(sessionKey)) {
          titleFiles.set(sessionKey, { path: filePath, provider });
        }
      }
    };

    if (currentSnapshot !== null) {
      for (const { provider, dir, allPaths: dirPaths, files } of currentSnapshot.dirs) {
        if (input.providers !== undefined && !input.providers.includes(provider)) continue;
        if (files === null) continue;
        walkedRoots.push(dir);
        for (const filePath of dirPaths) allPaths.add(filePath);
        for (const file of files) {
          if (
            target !== null &&
            !transcriptFileMayMatchThread({
              path,
              filePath: file.path,
              root: dir,
              provider,
              target,
              cached: {
                records: file.records,
                tailRecords: [],
              },
            })
          ) {
            continue;
          }
          livePaths.add(file.path);
          addRecords(provider, file.path, file.records);
        }
      }
    } else {
      const dirs = yield* resolveTranscriptDirs(settings).pipe(
        Effect.provideService(Path.Path, path),
      );
      for (const { provider, dir, fileName } of dirs) {
        if (input.providers !== undefined && !input.providers.includes(provider)) continue;
        const exists = yield* fileSystem
          .exists(dir)
          .pipe(Effect.catchCause(() => Effect.succeed(false)));
        if (!exists) continue;
        walkedRoots.push(dir);

        const files = yield* Effect.promise(() =>
          listTranscriptFiles(dir, windowStartMs, {
            ...(fileName === undefined ? {} : { fileName }),
            onFile: (filePath) => allPaths.add(filePath),
          }),
        );
        for (const file of files) {
          const cached = fileCache.get(file.path);
          const identity =
            target !== null && provider === "codex"
              ? yield* readFileIdentity(file.path, file.size, file.mtimeMs, provider)
              : null;
          if (
            target !== null &&
            !transcriptFileMayMatchThread({
              path,
              filePath: file.path,
              root: dir,
              provider,
              target,
              ...(cached === undefined ? {} : { cached }),
              ...(identity === null ? {} : { identity }),
            })
          ) {
            continue;
          }
          livePaths.add(file.path);
          const records = yield* readFileRecords(file.path, file.size, file.mtimeMs, provider);
          addRecords(provider, file.path, records);
        }
      }
    }

    // A filtered walk sees only one thread's candidates, so it cannot prove
    // that other cached files disappeared. Keeping the selected lifetime
    // records also prevents an old thread from being cold-parsed every turn.
    if (target === null) {
      const pruned = pruneScanCache(fileCache, {
        livePaths,
        walkedRoots,
        windowStartMs,
        retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      });
      if (pruned > 0) cacheRevision += 1;
    }
    const prunedIdentities = pruneScanIdentityCache(fileIdentityCache, {
      livePaths: allPaths,
      walkedRoots,
    });
    if (prunedIdentities > 0) cacheRevision += 1;
    // Persist selected lifetime records so a restart does not cold-parse the
    // same old thread again. Unfiltered reads retain the normal bounded cache.
    yield* persistScanCache();

    const folded = foldThreadRows(accumulator.finish(), attribution, {
      cap: THREAD_ROW_CAP,
      ...(input.projectKey === undefined ? {} : { projectFilter: input.projectKey }),
      ...(input.threadId === undefined ? {} : { threadFilter: input.threadId }),
    });

    // Transcript titles only for retained unattributed rows. Grouped remainder
    // rows already carry a generated title.
    const rows = yield* Effect.forEach(
      folded.rows,
      Effect.fnUntraced(function* ({ titleSessionKey, ...row }) {
        if (row.title !== null) return { ...row, title: row.title };
        const source = titleFiles.get(titleSessionKey);
        const transcriptTitle =
          source === undefined
            ? null
            : yield* Effect.promise(() => readTranscriptTitle(source.path, source.provider));
        const fallback = row.key.startsWith("remainder:")
          ? row.key
          : shortSessionLabel(titleSessionKey);
        return { ...row, title: transcriptTitle ?? fallback };
      }),
      { concurrency: 8 },
    );

    const readAt =
      currentSnapshot === null
        ? yield* DateTime.now
        : DateTime.makeUnsafe(currentSnapshot.completedAtMs);
    const finishedAtMs = yield* Clock.currentTimeMillis;
    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      rows,
      truncatedRows: folded.truncatedRows,
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageThreadBreakdown;
  });

  return { readSummary, readThreadBreakdown, refreshRates } as const;
});

/** `claude:8f14e45f-...` reads as `Session 8f14e45f`. */
export function shortSessionLabel(sessionKey: string): string {
  if (sessionKey.includes(":file:")) return "Untitled session";
  const sessionId = sessionKey.slice(sessionKey.lastIndexOf(":") + 1);
  return sessionId.length > 8 ? `Session ${sessionId.slice(0, 8)}` : `Session ${sessionId}`;
}

/** Maps a persisted provider cursor to the transcript session key it owns. */
export function runtimeUsageSessionKey(providerName: string, cursor: unknown): string | null {
  let provider: UsageProviderKind;
  switch (providerName) {
    case "claudeAgent":
      provider = "claude";
      break;
    case "codex":
      provider = "codex";
      break;
    case "grok":
      provider = "grok";
      break;
    default:
      return null;
  }
  const sessionId = providerResumeCursorSessionId(providerName, cursor);
  return sessionId === null ? null : `${provider}:${sessionId}`;
}

/** Maps current and replaced provider cursors to every transcript session owned by a thread. */
export function runtimeUsageSessionKeys(
  providerName: string,
  cursor: unknown,
  runtimePayload: unknown | null,
): readonly string[] {
  const keys = [
    runtimeUsageSessionKey(providerName, cursor),
    ...readProviderResumeCursorHistory(runtimePayload).map((entry) =>
      runtimeUsageSessionKey(entry.providerName, entry.resumeCursor),
    ),
  ];
  return [...new Set(keys.filter((key): key is string => key !== null))];
}

export interface ThreadTranscriptTarget {
  readonly sessionIds: ReadonlyMap<UsageProviderKind, ReadonlySet<string>>;
  readonly worktrees: ReadonlySet<string>;
}

function threadTranscriptTarget(
  attribution: {
    readonly sessionToThread: ReadonlyMap<string, ThreadRef>;
    readonly worktreeToThread: ReadonlyMap<string, ThreadRef>;
  },
  threadId: string,
): ThreadTranscriptTarget {
  const mutableSessionIds = new Map<UsageProviderKind, Set<string>>();
  for (const [sessionKey, ref] of attribution.sessionToThread) {
    if (ref.threadId !== threadId) continue;
    const separator = sessionKey.indexOf(":");
    const provider = sessionKey.slice(0, separator);
    const sessionId = sessionKey.slice(separator + 1);
    if (
      separator <= 0 ||
      sessionId.length === 0 ||
      (provider !== "claude" && provider !== "codex" && provider !== "grok")
    ) {
      continue;
    }
    const ids = mutableSessionIds.get(provider) ?? new Set<string>();
    ids.add(sessionId);
    mutableSessionIds.set(provider, ids);
  }
  const worktrees = new Set<string>();
  for (const [worktree, ref] of attribution.worktreeToThread) {
    if (ref.threadId === threadId) worktrees.add(normalizeUsagePath(worktree));
  }
  return { sessionIds: mutableSessionIds, worktrees };
}

function cwdMatchesTarget(cwd: string, worktrees: ReadonlySet<string>): boolean {
  if (cwd.length === 0) return false;
  const normalizedCwd = normalizeUsagePath(cwd);
  for (const worktree of worktrees) {
    const prefix = worktree.endsWith("/") ? worktree : `${worktree}/`;
    if (normalizedCwd === worktree || normalizedCwd.startsWith(prefix)) return true;
  }
  return false;
}

function pathMatchesSession(
  path: Pick<Path.Path, "basename" | "dirname">,
  filePath: string,
  provider: UsageProviderKind,
  sessionIds: ReadonlySet<string>,
): boolean {
  if (sessionIds.size === 0) return false;
  if (provider === "grok") return sessionIds.has(path.basename(path.dirname(filePath)));
  if (provider === "claude") {
    const parent = path.dirname(filePath);
    const sessionId =
      path.basename(parent) === "subagents"
        ? path.basename(path.dirname(parent))
        : path.basename(filePath, ".jsonl");
    return sessionIds.has(sessionId);
  }
  const name = path.basename(filePath, ".jsonl");
  for (const sessionId of sessionIds) {
    if (name === sessionId || name.endsWith(`-${sessionId}`)) return true;
  }
  return false;
}

function pathMatchesWorktree(
  path: Pick<Path.Path, "relative">,
  filePath: string,
  root: string,
  provider: UsageProviderKind,
  worktrees: ReadonlySet<string>,
): boolean {
  if (worktrees.size === 0 || provider === "codex") return false;
  const firstSegment = path.relative(root, filePath).replaceAll("\\", "/").split("/")[0];
  if (firstSegment === undefined) return false;
  if (provider === "claude") {
    for (const worktree of worktrees) {
      const encodedWorktree = worktree.replaceAll(/[^A-Za-z0-9]/g, "-");
      const isWindowsWorktree = /^[A-Za-z]:\//.test(worktree);
      if (
        isWindowsWorktree
          ? firstSegment.toLowerCase() === encodedWorktree.toLowerCase()
          : firstSegment === encodedWorktree
      ) {
        return true;
      }
    }
    return false;
  }
  try {
    return cwdMatchesTarget(decodeURIComponent(firstSegment), worktrees);
  } catch {
    return false;
  }
}

export function transcriptFileMayMatchThread(input: {
  readonly path: Pick<Path.Path, "basename" | "dirname" | "relative">;
  readonly filePath: string;
  readonly root: string;
  readonly provider: UsageProviderKind;
  readonly target: ThreadTranscriptTarget;
  readonly cached?: {
    readonly records: readonly UsageRecord[];
    readonly tailRecords: readonly UsageRecord[];
  };
  readonly identity?: {
    readonly sessionId: string;
    readonly cwd: string;
  };
}): boolean {
  const sessionIds = input.target.sessionIds.get(input.provider) ?? new Set<string>();
  if (pathMatchesSession(input.path, input.filePath, input.provider, sessionIds)) return true;
  if (
    pathMatchesWorktree(
      input.path,
      input.filePath,
      input.root,
      input.provider,
      input.target.worktrees,
    )
  ) {
    return true;
  }
  const cachedRecords =
    input.cached === undefined ? [] : [...input.cached.records, ...input.cached.tailRecords];
  if (
    cachedRecords.some(
      (record) =>
        sessionIds.has(record.sessionId) || cwdMatchesTarget(record.cwd, input.target.worktrees),
    )
  ) {
    return true;
  }
  return (
    input.identity !== undefined &&
    (sessionIds.has(input.identity.sessionId) ||
      cwdMatchesTarget(input.identity.cwd, input.target.worktrees))
  );
}

export const layer = Layer.effect(UsageService, make);
