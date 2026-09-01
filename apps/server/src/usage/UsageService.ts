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
  type UsageProviderKind,
  type UsageSource,
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
import { dedicatedUsageWorktreePath } from "./usagePaths.ts";
import { parseRateTable, type RateTable } from "./usagePricing.ts";
import {
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
  readTranscriptTitle,
} from "./usageTranscriptReader.ts";
import { foldThreadRows, ThreadUsageAccumulator, type ThreadRef } from "./usageThreads.ts";
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
  let cacheDirty = false;

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
   * Builds the cwd → project-title resolver for one scan.
   *
   * Projects are re-read every scan so a project created or renamed since the
   * last refresh attributes correctly. A repository failure degrades to "no
   * attribution" rather than failing the page.
   */
  const resolveProjects = Effect.fn("UsageService.resolveProjects")(function* () {
    const projects = yield* projectRepository
      .listAll()
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
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
      cacheDirty = true;
      return tailRecords.length === 0 ? records : dedupeWithinFile([...records, ...tailRecords]);
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
  }

  const collectDirs = Effect.fn("UsageService.collectDirs")(function* (windowStartMs: number) {
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so the scan stays context-free.
    const dirs = yield* resolveTranscriptDirs().pipe(Effect.provideService(Path.Path, path));
    const scanned: ScannedDir[] = [];
    for (const { provider, dir, fileName } of dirs) {
      const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        scanned.push({ provider, dir, volumeId, files: null });
        continue;
      }
      const files = yield* Effect.promise(() =>
        listTranscriptFiles(dir, windowStartMs, fileName === undefined ? undefined : { fileName }),
      );
      const parsedFiles: { path: string; records: readonly UsageRecord[] }[] = [];
      for (const file of files) {
        const records = yield* readFileRecords(file.path, file.size, file.mtimeMs, provider);
        parsedFiles.push({ path: file.path, records });
      }
      scanned.push({ provider, dir, volumeId, files: parsedFiles });
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

    const resolveProject = yield* resolveProjects();
    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      ...(resolveProject === undefined ? {} : { resolveProject }),
    });

    const sources: UsageSource[] = [];
    const livePaths = new Set<string>();
    const walkedRoots: string[] = [];

    for (const { provider, dir, volumeId, files } of scannedDirs) {
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

  /**
   * In-flight scans by window, so concurrent identical requests (the usage
   * page open on two clients at once) share one scan instead of racing over
   * the same corpus twice.
   */
  const inflightScans = new Map<string, Deferred.Deferred<UsageSummary, UsageReadError>>();

  const scanKey = (input: UsageSummaryInput): string =>
    JSON.stringify([
      input.timeZone,
      input.sinceDay,
      input.untilDay,
      input.resolution ?? "day",
      input.sinceTime ?? null,
      input.untilTime ?? null,
    ]);

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    const key = scanKey(input);
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
        yield* scanSummary(input).pipe(
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
      .pipe(Effect.catchCause(() => Effect.succeed<readonly never[]>([])));
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
    yield* ensureRates();
    yield* ensureScanCacheLoaded;

    const dirs = yield* resolveTranscriptDirs().pipe(Effect.provideService(Path.Path, path));
    const windowStartMs =
      (exactWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    const resolveProject = yield* resolveProjects();
    const accumulator = new ThreadUsageAccumulator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      ...exactWindow,
      rates,
      ...(resolveProject === undefined ? {} : { resolveProject }),
    });

    // Preferred transcript per session for title extraction: the main file,
    // never a subagent's.
    const titleFiles = new Map<
      string,
      { readonly path: string; readonly provider: UsageProviderKind }
    >();
    const livePaths = new Set<string>();
    const walkedRoots: string[] = [];

    for (const { provider, dir, fileName } of dirs) {
      if (input.providers !== undefined && !input.providers.includes(provider)) continue;
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) continue;
      walkedRoots.push(dir);

      const files = yield* Effect.promise(() =>
        listTranscriptFiles(dir, windowStartMs, fileName === undefined ? undefined : { fileName }),
      );
      for (const file of files) {
        livePaths.add(file.path);
        const records = yield* readFileRecords(file.path, file.size, file.mtimeMs, provider);
        if (records.length === 0) continue;
        const isSubagent =
          provider === "claude" && path.basename(path.dirname(file.path)) === "subagents";
        const agentId = isSubagent ? path.basename(file.path, ".jsonl") : null;
        for (const record of records) {
          const sessionKey =
            record.sessionId.length > 0
              ? `${provider}:${record.sessionId}`
              : `${provider}:file:${path.basename(path.dirname(file.path))}:${path.basename(file.path, ".jsonl")}`;
          accumulator.add(record, { sessionKey, agentId });
          if (!isSubagent && !titleFiles.has(sessionKey)) {
            titleFiles.set(sessionKey, { path: file.path, provider });
          }
        }
      }
    }

    const pruned = pruneScanCache(fileCache, {
      livePaths,
      walkedRoots,
      windowStartMs,
      retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    });
    if (pruned > 0) cacheDirty = true;
    // A thread-only client must warm and bound the same durable cache as the
    // summary RPC, otherwise restarts repeat parsing and stale entries grow.
    yield* persistScanCache();

    const attribution = yield* loadThreadAttribution();
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

    const readAt = yield* DateTime.now;
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

  return { readSummary, readThreadBreakdown } as const;
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

export const layer = Layer.effect(UsageService, make);
