/**
 * UsageService - scans provider transcripts and returns priced usage buckets.
 *
 * The scan reads native session files and databases, including work driven
 * outside T3 Code. Cursor's local records provide only partial coverage.
 *
 * JSONL transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed, and a file that merely grew resumes
 * from its cached parse position so only the appended bytes are read.
 * SQLite readers query live databases each scan so WAL writes remain visible.
 *
 * @module UsageService
 */
import * as NodeOS from "node:os";

import {
  ClaudeSettings,
  CodexSettings,
  type ProviderInstanceConfig,
  USAGE_CONTRACT_VERSION,
  ProviderInstanceId,
  type ServerSettings as ServerSettingsValue,
  type UsageProviderKind,
  type UsageSource,
  type UsagePricing,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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
import * as ServerSettings from "../serverSettings.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { resolveAntigravityInstanceDirectories } from "../provider/antigravityAuthSupport.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { readOpenCodeUsage } from "./opencodeUsageReader.ts";
import { readAntigravityUsage } from "./antigravityUsageReader.ts";
import { readCursorAccountUsage } from "./cursorUsageReader.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { createOverrideRateTable, parseRateTable, type RateTable } from "./usagePricing.ts";
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

/** An explicit refresh ignores the TTL, but not a table fetched this recently. */
const RATES_REFRESH_FLOOR_MS = 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Longest window the UI offers, plus slack. Older entries are pruned. */
const CACHE_RETENTION_DAYS = 90;

const decodeCodexSettings = Schema.decodeOption(CodexSettings);
const decodeClaudeSettings = Schema.decodeOption(ClaudeSettings);

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
const encodeUsageRecordKey = Schema.encodeSync(ScanCacheJson);
const CachedSource = Schema.Struct({ dir: Schema.String, volumeId: Schema.String });
const decodeCachedSources = Schema.decodeUnknownOption(
  Schema.Struct({ sources: Schema.Record(Schema.String, CachedSource) }),
);

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
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
    refreshRates: Effect.succeed(EMPTY_PRICING),
  }),
);

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;

  const fileCache: ScanCache = new Map();
  const sourceCache = new Map<string, typeof CachedSource.Type>();
  let cacheDirty = false;
  const isWithinDirectory = (filePath: string, dir: string) => {
    const relative = path.relative(dir, filePath);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };

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
      Effect.ignoreCause,
    );
  });

  const ensureRates = (force: boolean) => ratesLock.withPermit(loadRates(force));

  const refreshRates = ensureRates(true).pipe(
    Effect.map(pricing),
    Effect.withSpan("UsageService.refreshRates"),
  );

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
    retentionCutoffMs: number,
  ) {
    const dirs: Array<{
      provider: UsageProviderKind;
      dir: string;
      volumeId: string;
      fileName?: string;
    }> = [];
    const seen = new Set<string>();
    for (const driver of ["claudeAgent", "codex", "grok"] as const) {
      // Disabled accounts still have history. Explicit default slots replace
      // the legacy settings, just as they do in the provider registry.
      const instances: Array<Pick<ProviderInstanceConfig, "config" | "environment">> =
        Object.values(settings.providerInstances).filter((instance) => instance.driver === driver);
      if (!Object.hasOwn(settings.providerInstances, driver)) {
        instances.push({ config: settings.providers[driver] });
      }
      for (const instance of instances) {
        const environment = mergeProviderInstanceEnvironment(instance.environment, hostEnvironment);
        const provider = driver === "claudeAgent" ? "claude" : driver;
        let home: string;
        if (driver === "codex") {
          const decoded = decodeCodexSettings(instance.config ?? {});
          if (Option.isNone(decoded)) continue;
          const config = decoded.value;
          const environmentHome = environment.CODEX_HOME?.trim();
          const layout = yield* resolveCodexHomeLayout(
            !config.homePath.trim() && !config.shadowHomePath.trim() && environmentHome
              ? { ...config, homePath: environmentHome }
              : config,
          );
          home = layout.sharedHomePath;
        } else if (driver === "claudeAgent") {
          const decoded = decodeClaudeSettings(instance.config ?? {});
          if (Option.isNone(decoded)) continue;
          const configured = decoded.value.homePath.trim();
          home = configured
            ? expandHomePath(configured)
            : environment.CLAUDE_CONFIG_DIR?.trim() || path.join(NodeOS.homedir(), ".claude");
        } else {
          home = expandHomePath(
            environment.GROK_HOME?.trim() || path.join(NodeOS.homedir(), ".grok"),
          );
        }
        const directory = path.resolve(home, provider === "claude" ? "projects" : "sessions");
        const sourceKey = provider + "\0" + directory;
        const previous = sourceCache.get(sourceKey);
        // Keep canonical paths and source fingerprints stable after root cleanup,
        // including aliases and clients merging pre-cleanup environment summaries.
        const dir = yield* fileSystem
          .realPath(directory)
          .pipe(Effect.orElseSucceed(() => previous?.dir ?? directory));
        const currentVolumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
        const hasRetainedHistory = fileCache
          .entries()
          .some(
            ([filePath, entry]) =>
              entry.provider === provider &&
              entry.mtimeMs >= retentionCutoffMs &&
              entry.records.length + entry.tailRecords.length > 0 &&
              isWithinDirectory(filePath, dir),
          );
        // A recreated directory still reports the retained history under its old identity.
        const volumeId =
          previous?.dir === dir && (hasRetainedHistory || !currentVolumeId)
            ? previous.volumeId || currentVolumeId
            : currentVolumeId;
        if (previous?.dir !== dir || previous.volumeId !== volumeId) {
          sourceCache.set(sourceKey, { dir, volumeId });
          cacheDirty = true;
        }
        const key = `${provider}\0${dir}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dirs.push({
          provider,
          dir,
          volumeId,
          ...(provider === "grok" ? { fileName: "updates.jsonl" } : {}),
        });
      }
    }
    return dirs;
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
      const sources = decodeCachedSources(document);
      if (Option.isSome(sources)) {
        for (const [key, source] of Object.entries(sources.value.sources))
          sourceCache.set(key, source);
      }
    }),
  );

  const persistScanCache = Effect.fn("UsageService.persistScanCache")(function* () {
    if (!cacheDirty) return;
    // Cleared only after the write lands, so a failed persist is retried on
    // the next scan instead of leaving disk permanently stale.
    yield* encodeScanCacheFile({
      ...encodeScanCache(fileCache),
      sources: Object.fromEntries(sourceCache),
    }).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(scanCachePath, serialized)),
      Effect.map(() => {
        cacheDirty = false;
      }),
      // A cache we cannot write is a slower next start, not a failed read.
      Effect.ignoreCause,
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
          : [...cached.records, ...cached.tailRecords];
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
      if (parsed === null)
        return cached?.provider === provider ? [...cached.records, ...cached.tailRecords] : [];

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
      return tailRecords.length === 0 ? records : [...records, ...tailRecords];
    });

  /** One provider directory's walk and parse, before rates are involved. */
  interface ScannedDir {
    readonly provider: UsageProviderKind;
    readonly dir: string;
    readonly volumeId: string;
    readonly hostId?: string;
    readonly status?: UsageSource["status"];
    readonly message?: string;
    readonly action?: UsageSource["action"];
    /** Parsed records per file, or `null` when the directory does not exist. */
    readonly files:
      | readonly { readonly path: string; readonly records: readonly UsageRecord[] }[]
      | null;
  }

  const collectDirs = Effect.fn("UsageService.collectDirs")(function* (
    windowStartMs: number,
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
  ) {
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so the scan stays context-free.
    const dirs = yield* resolveTranscriptDirs(settings, retentionCutoffMs).pipe(
      Effect.provideService(Path.Path, path),
    );
    const scanned: ScannedDir[] = [];
    for (const { provider, dir, volumeId, fileName } of dirs) {
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

    const home = NodeOS.homedir();
    const envRoots = Effect.fnUntraced(function* (key: string, defaults: readonly string[]) {
      const roots = hostEnvironment[key]
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const canonical = new Set<string>();
      for (const root of roots?.length ? roots : defaults) {
        const resolved = path.resolve(expandHomePath(root));
        canonical.add(
          yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)),
        );
      }
      return [...canonical];
    });
    const dataHome = hostEnvironment["XDG_DATA_HOME"]?.trim();
    for (const dir of yield* envRoots("OPENCODE_DATA_DIR", [
      path.join(
        dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(home, ".local", "share"),
        "opencode",
      ),
    ])) {
      const result = yield* Effect.promise(() => readOpenCodeUsage(dir, windowStartMs));
      scanned.push({
        provider: "opencode",
        dir,
        volumeId: yield* Effect.promise(() => readDirectoryVolumeId(dir)),
        files: result.missing && !result.error ? null : result.files,
        status: result.error ? "partial" : "ok",
        ...(result.error ? { message: "Some OpenCode history could not be read." } : {}),
      });
    }
    const antigravityRoots = yield* envRoots("ANTIGRAVITY_DATA_DIR", [
      ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map((name) =>
        path.join(home, ".gemini", name),
      ),
      path.join(home, ".config", "antigravity"),
    ]);
    for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
      if (instance.driver === "antigravity") {
        const directories = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          ProviderInstanceId.make(instanceId),
        ).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new UsageReadError({
                reason: "scanFailed",
                detail: "Antigravity profile directory could not be resolved.",
                cause,
              }),
          ),
        );
        antigravityRoots.push(path.join(directories.profile, "antigravity-acp"));
      }
    }
    const antigravityDirs = new Set<string>();
    for (const root of antigravityRoots) {
      const resolvedRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
      const nested = path.join(resolvedRoot, "conversations");
      const dir = (yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false))))
        ? nested
        : resolvedRoot;
      antigravityDirs.add(yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir)));
    }
    const antigravity = yield* Effect.promise(() =>
      readAntigravityUsage([...antigravityDirs], windowStartMs),
    );
    for (const dir of antigravityDirs) {
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      const failed = antigravity.errors.some(
        (error) => error === dir || error.startsWith(`${dir}${path.sep}`),
      );
      scanned.push({
        provider: "antigravity",
        dir,
        volumeId: yield* Effect.promise(() => readDirectoryVolumeId(dir)),
        files: !exists && !failed ? null : antigravity.files.filter((file) => file.root === dir),
        status: failed ? "partial" : "ok",
        ...(failed ? { message: "Some Antigravity history could not be read." } : {}),
      });
    }
    const cursorUserHome =
      (platform === "win32" ? hostEnvironment["USERPROFILE"] : hostEnvironment["HOME"]) || home;
    const configHome = hostEnvironment["XDG_CONFIG_HOME"]?.trim();
    const cursorHome =
      platform === "darwin"
        ? path.join(cursorUserHome, "Library", "Application Support")
        : platform === "win32"
          ? hostEnvironment["APPDATA"] || path.join(cursorUserHome, "AppData", "Roaming")
          : configHome && path.isAbsolute(configHome)
            ? configHome
            : path.join(cursorUserHome, ".config");
    const cursorAuthPath =
      platform === "darwin"
        ? path.join(cursorUserHome, ".cursor", "auth.json")
        : path.join(cursorHome, platform === "win32" ? "Cursor" : "cursor", "auth.json");
    const credentialStore = hostEnvironment["AGENT_CLI_CREDENTIAL_STORE"];
    const loginUnavailable =
      Boolean(hostEnvironment["CURSOR_AUTH_TOKEN"]?.trim()) ||
      Boolean(hostEnvironment["CURSOR_API_KEY"]?.trim()) ||
      credentialStore === "memory";
    if (
      platform === "darwin" &&
      credentialStore !== "file" &&
      !loginUnavailable &&
      !settings.cursorKeychainUsageEnabled
    ) {
      scanned.push({
        provider: "cursor",
        dir: cursorAuthPath,
        volumeId: "",
        files: null,
        message: "Cursor account usage is off on this environment.",
        action: "enableCursorKeychain",
      });
      return scanned;
    }
    const cursorUntilMs = yield* Clock.currentTimeMillis;
    const account = loginUnavailable
      ? {
          accountKey: null,
          records: [],
          missing: true,
          error: "Cursor account history needs a Cursor CLI login on this server.",
        }
      : yield* Effect.promise(() =>
          readCursorAccountUsage(
            platform === "darwin" && credentialStore !== "file"
              ? { kind: "keychain" }
              : cursorAuthPath,
            windowStartMs,
            cursorUntilMs,
          ),
        );
    if (account.accountKey !== null && account.error === null && !account.missing) {
      // The same account includes CLI and desktop history from every machine.
      // A stable remote fingerprint prevents connected environments counting it twice.
      const source = `cursor-account:${account.accountKey}`;
      scanned.push({
        provider: "cursor",
        dir: source,
        hostId: "cursor.com",
        volumeId: account.accountKey,
        files: [{ path: source, records: account.records }],
        status: "ok",
      });
      return scanned;
    }
    scanned.push({
      provider: "cursor",
      dir: cursorAuthPath,
      volumeId: yield* Effect.promise(() => readDirectoryVolumeId(cursorAuthPath)),
      // Never combine a local fallback with another server's account-wide history.
      files: null,
      message:
        account.error ?? "Cursor account history needs a Cursor CLI login saved on this server.",
    });
    return scanned;
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

    const retentionCutoffMs = startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    // Pricing only matters once records are aggregated, so the rate table
    // loads while transcripts stream instead of gating them: a cold rates
    // fetch on a slow network no longer delays the scan by its own timeout.
    const [, scannedDirs] = yield* Effect.all(
      [ensureRates(false), collectDirs(windowStartMs, settings, retentionCutoffMs)],
      { concurrency: 2 },
    );

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
    });

    const sources: UsageSource[] = [];

    for (const {
      provider,
      dir,
      volumeId,
      files,
      status,
      message,
      action,
      hostId: sourceHostId,
    } of scannedDirs) {
      const retainedFiles = [...(files ?? [])];
      const livePaths = new Set(retainedFiles.map((file) => file.path));
      // Cleanup may remove transcripts, but the usage we already saved still
      // contributes to this source. Keep the normal aggregation and dedupe path.
      for (const [filePath, entry] of fileCache) {
        if (
          entry.provider !== provider ||
          entry.mtimeMs < retentionCutoffMs ||
          livePaths.has(filePath) ||
          !isWithinDirectory(filePath, dir)
        )
          continue;
        retainedFiles.push({ path: filePath, records: [...entry.records, ...entry.tailRecords] });
      }
      let scannedFiles = 0;
      let skippedFiles = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();

      for (const file of retainedFiles) {
        if (file.records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        const codexEventOccurrences = new Map<string, number>();
        for (const record of file.records) {
          let usageRecord = record;
          if (record.provider === "codex" && record.sessionId.length > 0) {
            // Match moved rollout copies without collapsing repeated equal events
            // within one rollout (timestamps can have only second precision).
            const key = encodeUsageRecordKey([
              record.provider,
              record.sessionId,
              record.timestampMs,
              record.model,
              record.totals,
            ]);
            const occurrence = (codexEventOccurrences.get(key) ?? 0) + 1;
            codexEventOccurrences.set(key, occurrence);
            usageRecord = { ...record, dedupeKey: key + ":" + occurrence };
          }
          // Only sessions contributing in-window count; the mtime slack can
          // admit boundary files whose records fall outside the range.
          if (aggregator.add(usageRecord, dir) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
      }

      sources.push({
        fingerprint: { hostId: sourceHostId ?? hostId, provider, resolvedHomePath: dir, volumeId },
        // Clients exclude missing sources, so saved records remain an available source.
        status: files === null && scannedFiles === 0 ? "missing" : (status ?? "ok"),
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message:
          message ?? (files === null ? "No transcript directory on this environment." : null),
        ...(action ? { action } : {}),
      });
    }

    const pruned = pruneScanCache(fileCache, retentionCutoffMs);
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
    cursorKeychainUsageEnabled: boolean,
  ): string =>
    JSON.stringify([
      input.timeZone,
      input.sinceDay,
      input.untilDay,
      input.resolution ?? "day",
      input.sinceTime ?? null,
      input.untilTime ?? null,
      priceOverrides,
      cursorKeychainUsageEnabled,
    ]);

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    const settings = yield* readSettings;
    const key = scanKey(input, settings.usagePriceOverrides, settings.cursorKeychainUsageEnabled);
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

  return { readSummary, refreshRates } as const;
});

export const layer = Layer.effect(UsageService, make);
