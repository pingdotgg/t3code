/**
 * UsageService - scans provider transcripts and returns priced usage buckets.
 *
 * The scan reads the provider CLIs' own session files (Claude Code, Codex, and
 * Grok Build) plus T3's canonical Devin ACP event logs. CLI usage covers turns
 * driven outside T3 Code too; Devin ACP usage is limited to sessions driven by
 * this server. Optional official account ACUs are fetched separately when a
 * billing-capable Devin service credential is configured.
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
  resolveProviderInstanceEnabled,
  type ServerSettings as ServerSettingsValue,
  type UsageAccountConsumption,
  type UsageProviderKind,
  type UsageSource,
  type UsagePricing,
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import {
  createOverrideRateTable,
  parseProviderModelRateTable,
  parseRateTable,
  type ModelRate,
  type RateTable,
} from "./usagePricing.ts";
import {
  listProviderEventLogFiles,
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
import { parseDevinAccountConsumptionPayload } from "./devinAccountUsage.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const DEVIN_RATES_SOURCE = "Devin CLI model catalog (local provider snapshot)";
const DEVIN_ACCOUNT_API_BASE = "https://api.devin.ai/v3";
const DEVIN_ACCOUNT_SOURCE = "Devin organization consumption API (ACUs)";
const DEVIN_ACCOUNT_API_KEY_ENV_NAMES = ["DEVIN_API_KEY", "DEVIN_PERSONAL_ACCESS_TOKEN"] as const;
const DEVIN_ACCOUNT_ORG_ENV_NAMES = ["DEVIN_ORG_ID", "DEVIN_ORGANIZATION_ID"] as const;
const DEVIN_ACCOUNT_REQUEST_TIMEOUT_MS = 10_000;
const DEVIN_ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1_000;

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function findEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
): string | undefined {
  const wanted = new Set(names.map((name) => name.toUpperCase()));
  for (const [name, value] of Object.entries(environment)) {
    if (wanted.has(name.toUpperCase())) {
      const resolved = nonEmptyString(value);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

function findDevinProviderEnvironmentValue(
  settings: ServerSettingsValue,
  names: readonly string[],
): string | undefined {
  const wanted = new Set(names.map((name) => name.toUpperCase()));
  for (const instance of Object.values(settings.providerInstances)) {
    if (String(instance.driver).toLowerCase() !== "devin") continue;
    for (const variable of instance.environment ?? []) {
      if (!wanted.has(variable.name.toUpperCase())) continue;
      const resolved = nonEmptyString(variable.value);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

function isDevinEnabled(settings: ServerSettingsValue): boolean {
  if (settings.providers.devin.enabled === true) return true;
  return Object.values(settings.providerInstances).some(
    (instance) =>
      String(instance.driver).toLowerCase() === "devin" && resolveProviderInstanceEnabled(instance),
  );
}

function accountConsumptionStatus(input: {
  readonly status: UsageAccountConsumption["status"];
  readonly message: string | null;
  readonly fetchedAt?: string | null;
  readonly totalAcus?: number;
  readonly days?: UsageAccountConsumption["days"];
}): UsageAccountConsumption {
  return {
    provider: "devin",
    status: input.status,
    source: DEVIN_ACCOUNT_SOURCE,
    fetchedAt: input.fetchedAt ?? null,
    totalAcus: input.totalAcus ?? 0,
    days: input.days ?? [],
    message: input.message,
  };
}

function epochSecondsForDay(day: string, offsetDays: number): number | null {
  const milliseconds = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds)) return null;
  return Math.floor((milliseconds + offsetDays * 24 * 60 * 60 * 1_000) / 1_000);
}

function selectAccountWindow(
  parsed: ReturnType<typeof parseDevinAccountConsumptionPayload>,
  input: UsageSummaryInput,
): { readonly totalAcus: number; readonly days: UsageAccountConsumption["days"] } | null {
  if (parsed === null) return null;
  const days = parsed.days.filter((day) => day.day >= input.sinceDay && day.day <= input.untilDay);
  return {
    // If the endpoint returned no date rows, retain its required total. When
    // rows are present, summing the selected rows avoids leaking an adjacent
    // day from the one-day query padding used for Devin's PST billing boundary.
    totalAcus:
      parsed.days.length === 0 ? parsed.totalAcus : days.reduce((sum, day) => sum + day.acus, 0),
    days,
  };
}

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
const decodeProviderSnapshotJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ driver: Schema.Literal("devin"), models: Schema.Array(Schema.Unknown) }),
  ),
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
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcessEnvironment;

  const fileCache: ScanCache = new Map();
  let cacheDirty = false;

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
  let liteLlmRates: RateTable = new Map();
  let devinRates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsagePricing["status"] = "unavailable";
  // One fetch at a time. A burst of refreshes from several clients waits on
  // the first fetch and then sees a table young enough to skip its own.
  const ratesLock = yield* Semaphore.make(1);

  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source:
      devinRates.size > 0 ? `${LITELLM_RATES_URL} + ${DEVIN_RATES_SOURCE}` : LITELLM_RATES_URL,
    fetchedAt:
      ratesFetchedAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
    knownModels: liteLlmRates.size + devinRates.size,
  });
  const devinAccountCache = new Map<
    string,
    { readonly fetchedAtMs: number; readonly value: UsageAccountConsumption }
  >();

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
          liteLlmRates = parsed;
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
      if (liteLlmRates.size > 0) ratesStatus = "cached";
      return;
    }

    const parsed = parseRateTable(fetched);
    if (parsed.size === 0) return;

    liteLlmRates = parsed;
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
   * Provider probes persist their model catalog in the status-cache directory.
   * Retain Devin's advertised per-million prices for Devin records so
   * canonical ACP records can be priced even when the public LiteLLM table
   * does not yet contain a newly launched Devin model.
   */
  const ensureDevinRates = Effect.fn("UsageService.ensureDevinRates")(function* () {
    const entries = yield* fileSystem
      .readDirectory(config.providerStatusCacheDir)
      .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<string>)));
    const merged = new Map<string, ModelRate>();
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".json")) continue;
      const raw = yield* fileSystem
        .readFileString(path.join(config.providerStatusCacheDir, entry))
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (raw === null) continue;
      const document = yield* decodeProviderSnapshotJson(raw).pipe(Effect.option);
      if (Option.isNone(document)) continue;
      for (const [model, rate] of parseProviderModelRateTable(document.value)) {
        merged.set(model, rate);
      }
    }
    devinRates = merged;
  });

  /**
   * Optionally reads official account-level Devin ACUs. The normal CLI login
   * token is intentionally not inspected or reused: Devin's organization
   * consumption endpoint requires a separately provisioned service credential
   * with billing permission. Missing credentials simply produce an explicit
   * not-configured state and never make the usage scan fail.
   */
  const readDevinAccountUsage = Effect.fn("UsageService.readDevinAccountUsage")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
  ) {
    if (!isDevinEnabled(settings)) return undefined;

    const apiKey =
      findDevinProviderEnvironmentValue(settings, DEVIN_ACCOUNT_API_KEY_ENV_NAMES) ??
      findEnvironmentValue(hostEnvironment, DEVIN_ACCOUNT_API_KEY_ENV_NAMES);
    const organizationId =
      findDevinProviderEnvironmentValue(settings, DEVIN_ACCOUNT_ORG_ENV_NAMES) ??
      findEnvironmentValue(hostEnvironment, DEVIN_ACCOUNT_ORG_ENV_NAMES);
    if (apiKey === undefined || organizationId === undefined) {
      const missing = [
        apiKey === undefined ? "DEVIN_API_KEY" : null,
        organizationId === undefined ? "DEVIN_ORG_ID" : null,
      ].filter((name): name is string => name !== null);
      return accountConsumptionStatus({
        status: "notConfigured",
        message: `Optional account ACU data needs ${missing.join(" and ")} as Devin provider environment variables.`,
      });
    }

    const timeAfter = epochSecondsForDay(input.sinceDay, -1);
    const timeBefore = epochSecondsForDay(input.untilDay, 2);
    if (timeAfter === null || timeBefore === null) {
      return accountConsumptionStatus({
        status: "failed",
        message: "The requested usage window is not a valid date range.",
      });
    }

    const cacheKey = `${organizationId}\u0000${input.sinceDay}\u0000${input.untilDay}`;
    const now = yield* Clock.currentTimeMillis;
    const cached = devinAccountCache.get(cacheKey);
    if (cached !== undefined && now - cached.fetchedAtMs < DEVIN_ACCOUNT_CACHE_TTL_MS) {
      return cached.value;
    }

    const endpoint = new URL(
      `${DEVIN_ACCOUNT_API_BASE}/organizations/${encodeURIComponent(organizationId)}/consumption/daily`,
    );
    endpoint.searchParams.set("time_after", String(timeAfter));
    endpoint.searchParams.set("time_before", String(timeBefore));
    const request = HttpClientRequest.get(endpoint.toString()).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(apiKey),
    );
    const responseResult = yield* httpClient
      .execute(request)
      .pipe(Effect.timeout(DEVIN_ACCOUNT_REQUEST_TIMEOUT_MS), Effect.result);
    if (Result.isFailure(responseResult)) {
      const value = accountConsumptionStatus({
        status: "failed",
        message: "Devin account consumption could not be reached.",
      });
      devinAccountCache.set(cacheKey, { fetchedAtMs: now, value });
      return value;
    }

    const response = responseResult.success;
    if (response.status === 401 || response.status === 403) {
      const value = accountConsumptionStatus({
        status: "forbidden",
        message: "The Devin API key lacks organization consumption permission.",
      });
      devinAccountCache.set(cacheKey, { fetchedAtMs: now, value });
      return value;
    }
    if (response.status < 200 || response.status >= 300) {
      const value = accountConsumptionStatus({
        status: "failed",
        message:
          response.status === 404
            ? "Devin organization consumption is unavailable for this account."
            : `Devin account consumption returned HTTP ${response.status}.`,
      });
      devinAccountCache.set(cacheKey, { fetchedAtMs: now, value });
      return value;
    }

    const payloadResult = yield* response.json.pipe(Effect.result);
    if (Result.isFailure(payloadResult)) {
      const value = accountConsumptionStatus({
        status: "failed",
        message: "Devin returned an unreadable account consumption response.",
      });
      devinAccountCache.set(cacheKey, { fetchedAtMs: now, value });
      return value;
    }
    const parsed = selectAccountWindow(
      parseDevinAccountConsumptionPayload(payloadResult.success),
      input,
    );
    if (parsed === null) {
      const value = accountConsumptionStatus({
        status: "failed",
        message: "Devin returned an invalid account consumption response.",
      });
      devinAccountCache.set(cacheKey, { fetchedAtMs: now, value });
      return value;
    }

    const value = accountConsumptionStatus({
      status: "available",
      message: null,
      fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      totalAcus: parsed.totalAcus,
      days: parsed.days,
    });
    devinAccountCache.set(cacheKey, { fetchedAtMs: now, value });
    return value;
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
      {
        provider: "devin" as const,
        dir: config.providerLogsDir,
        eventLog: true as const,
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
      if (parsed === null) return [];

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
    /** Parsed records per file, or `null` when the directory does not exist. */
    readonly files:
      | readonly { readonly path: string; readonly records: readonly UsageRecord[] }[]
      | null;
  }

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
    for (const { provider, dir, fileName, eventLog } of dirs) {
      const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        scanned.push({ provider, dir, volumeId, files: null });
        continue;
      }
      const files = yield* Effect.promise(() =>
        eventLog
          ? listProviderEventLogFiles(dir, "events", windowStartMs)
          : listTranscriptFiles(
              dir,
              windowStartMs,
              fileName === undefined ? undefined : { fileName },
            ),
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
    yield* ensureDevinRates();
    const settingsForAccount = yield* settingsService.getSettings.pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    const accountUsage =
      settingsForAccount === null
        ? undefined
        : yield* readDevinAccountUsage(input, settingsForAccount);
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
    const [, scannedDirs] = yield* Effect.all(
      [ensureRates(false), collectDirs(windowStartMs, settings)],
      { concurrency: 2 },
    );

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates: liteLlmRates,
      providerRates: { devin: new Map([...liteLlmRates, ...devinRates]) },
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
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
        }
      }

      sources.push({
        fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
        status: "ok",
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message:
          provider === "devin"
            ? "Devin ACP usage is captured from this T3 server's local event logs."
            : null,
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
      pricing: pricing(),
      ...(accountUsage === undefined ? {} : { accountUsage }),
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

  return { readSummary, refreshRates } as const;
});

export const layer = Layer.effect(UsageService, make);
