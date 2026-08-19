/**
 * Server-side Vibe-Proxy quota integration.
 *
 * The management key stays in the server secret store. Upstream auth-file
 * responses are reduced to the quota and request-health fields defined by the
 * wire contract before they are cached or sent to a client.
 *
 * @module VibeProxyUsageService
 */
import {
  type ServerSettingsError,
  VibeProxyUsageReadError,
  VibeProxyUsageSnapshot,
  type VibeProxyQuotaCapacity,
  type VibeProxyQuotaWindow,
  type VibeProxyRecentRequestBucket,
  type VibeProxyUsageAccount,
  type VibeProxyUsageRefreshProblem,
  type VibeProxyUsageResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const AUTH_FILES_PATH = "/api/v0/management/auth-files";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ACCOUNTS = 1_000;
const MAX_RECENT_REQUEST_BUCKETS = 100;

const SnapshotJson = Schema.fromJsonString(
  VibeProxyUsageSnapshot as unknown as Schema.Codec<VibeProxyUsageSnapshot>,
);
const decodeSnapshot = Schema.decodeUnknownEffect(SnapshotJson);
const encodeSnapshot = Schema.encodeEffect(SnapshotJson);

type UnknownRecord = Record<string, unknown>;
type FetchAttempt =
  | { readonly _tag: "Success"; readonly snapshot: VibeProxyUsageSnapshot }
  | { readonly _tag: "Failure"; readonly problem: VibeProxyUsageRefreshProblem };

const fetchFailure = (
  reason: VibeProxyUsageRefreshProblem["reason"],
  message: string,
): FetchAttempt => ({ _tag: "Failure", problem: { reason, message } });

const asRecord = (value: unknown): UnknownRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const boundedString = (value: unknown, maximumLength = 500): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, maximumLength);
};

const booleanValue = (value: unknown): boolean => value === true;

const nonNegativeInt = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

const percentage = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;

const normalizeRecentRequest = (value: unknown): VibeProxyRecentRequestBucket | null => {
  const record = asRecord(value);
  const time = boundedString(record?.time, 100);
  if (!record || !time) return null;
  return {
    time,
    success: nonNegativeInt(record.success),
    failed: nonNegativeInt(record.failed),
  };
};

const normalizeQuotaWindow = (value: unknown, index: number): VibeProxyQuotaWindow | null => {
  const record = asRecord(value);
  if (!record) return null;
  const used = percentage(record.used_percent);
  const remaining = percentage(record.remaining_percent);
  if (used === null && remaining === null) return null;

  return {
    id: boundedString(record.id, 500) ?? `window-${index}`,
    label: boundedString(record.label, 500) ?? "Usage limit",
    usedPercent: used ?? 100 - (remaining ?? 0),
    remainingPercent: remaining ?? 100 - (used ?? 0),
    resetAt: boundedString(record.reset_at, 100),
    known: booleanValue(record.known),
    hardExhausted: booleanValue(record.hard_exhausted),
    routing: booleanValue(record.routing),
  };
};

const normalizeQuotaCapacity = (
  value: unknown,
  fallbackProvider: string,
): VibeProxyQuotaCapacity | null => {
  const record = asRecord(value);
  if (!record) return null;
  const windows = Array.isArray(record.windows)
    ? record.windows.flatMap((window, index) => {
        const normalized = normalizeQuotaWindow(window, index);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    provider: boundedString(record.provider, 100) ?? fallbackProvider,
    supported: booleanValue(record.supported),
    fetchedAt: boundedString(record.fetched_at, 100),
    staleAt: boundedString(record.stale_at, 100),
    lastAttemptAt: boundedString(record.last_attempt_at, 100),
    lastError: boundedString(record.last_error, 1_000),
    windows,
  };
};

const normalizeAccount = (value: unknown, index: number): VibeProxyUsageAccount | null => {
  const record = asRecord(value);
  if (!record) return null;

  const provider =
    boundedString(record.provider, 100) ?? boundedString(record.type, 100) ?? "unknown";
  const account = boundedString(record.account, 500);
  const email = boundedString(record.email, 500);
  const label = boundedString(record.label, 500);
  const name = boundedString(record.name, 500);
  const id =
    boundedString(record.id, 500) ??
    name ??
    `${provider}:${account ?? email ?? label ?? String(index)}`;
  const idToken = asRecord(record.id_token);
  const disabled = booleanValue(record.disabled);
  const unavailable = booleanValue(record.unavailable);

  return {
    id,
    provider,
    account,
    label,
    email,
    accountType: boundedString(record.account_type, 100),
    planType: boundedString(idToken?.plan_type, 100),
    status:
      boundedString(record.status, 100) ??
      (disabled ? "disabled" : unavailable ? "unavailable" : "unknown"),
    statusMessage: boundedString(record.status_message, 1_000),
    disabled,
    unavailable,
    success: nonNegativeInt(record.success),
    failed: nonNegativeInt(record.failed),
    recentRequests: Array.isArray(record.recent_requests)
      ? record.recent_requests.slice(-MAX_RECENT_REQUEST_BUCKETS).flatMap((bucket) => {
          const normalized = normalizeRecentRequest(bucket);
          return normalized ? [normalized] : [];
        })
      : [],
    quotaCapacity: normalizeQuotaCapacity(record.quota_capacity, provider),
  };
};

export const normalizeVibeProxyAuthFiles = (
  value: unknown,
  fetchedAt: string,
): VibeProxyUsageSnapshot | null => {
  const response = asRecord(value);
  if (!response || !Array.isArray(response.files)) return null;
  return {
    fetchedAt,
    accounts: response.files.slice(0, MAX_ACCOUNTS).flatMap((account, index) => {
      const normalized = normalizeAccount(account, index);
      return normalized ? [normalized] : [];
    }),
  };
};

const resolveAuthFilesUrl = (baseUrl: string): string | null => {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}${AUTH_FILES_PATH}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
};

const result = (input: {
  readonly status: VibeProxyUsageResult["status"];
  readonly snapshot: VibeProxyUsageSnapshot | null;
  readonly refreshed?: boolean;
  readonly refreshProblem?: VibeProxyUsageRefreshProblem | null;
}): VibeProxyUsageResult => ({
  status: input.status,
  snapshot: input.snapshot,
  refreshed: input.refreshed ?? false,
  refreshProblem: input.refreshProblem ?? null,
});

export class VibeProxyUsageService extends Context.Service<
  VibeProxyUsageService,
  {
    readonly readCached: Effect.Effect<
      VibeProxyUsageResult,
      VibeProxyUsageReadError | ServerSettingsError
    >;
    readonly refresh: Effect.Effect<
      VibeProxyUsageResult,
      VibeProxyUsageReadError | ServerSettingsError
    >;
  }
>()("t3/usage/VibeProxyUsageService") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const cachePath = path.join(config.stateDir, "vibe-proxy-usage.json");

  const readSnapshot = fileSystem.exists(cachePath).pipe(
    Effect.mapError((cause) => new VibeProxyUsageReadError({ operation: "read-cache", cause })),
    Effect.flatMap((exists) =>
      exists
        ? fileSystem.readFileString(cachePath).pipe(
            Effect.mapError(
              (cause) => new VibeProxyUsageReadError({ operation: "read-cache", cause }),
            ),
            Effect.flatMap((raw) =>
              decodeSnapshot(raw).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("ignored invalid Vibe-Proxy usage cache", {
                    cause,
                  }).pipe(Effect.as(null)),
                ),
              ),
            ),
          )
        : Effect.succeed(null),
    ),
  );

  const writeSnapshot = (snapshot: VibeProxyUsageSnapshot) =>
    encodeSnapshot(snapshot).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: cachePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new VibeProxyUsageReadError({ operation: "write-cache", cause })),
    );

  const currentStatus = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const snapshot = yield* readSnapshot;
    if (!settings.vibeProxy.enabled) {
      return { status: "disabled" as const, settings, snapshot };
    }
    if (settings.vibeProxy.baseUrl.length === 0 || settings.vibeProxy.apiKey.length === 0) {
      return { status: "unconfigured" as const, settings, snapshot };
    }
    return { status: "ready" as const, settings, snapshot };
  });

  const readCached = currentStatus.pipe(
    Effect.map(({ status, snapshot }) => result({ status, snapshot })),
  );

  const refresh = Effect.gen(function* () {
    const current = yield* currentStatus;
    if (current.status !== "ready") {
      return result({ status: current.status, snapshot: current.snapshot });
    }

    const requestUrl = resolveAuthFilesUrl(current.settings.vibeProxy.baseUrl);
    if (!requestUrl) {
      return result({
        status: "ready",
        snapshot: current.snapshot,
        refreshProblem: {
          reason: "invalidConfiguration",
          message: "Enter a valid HTTP or HTTPS Vibe-Proxy base URL.",
        },
      });
    }

    const fetchedAt = DateTime.formatIso(yield* DateTime.now);
    const attempt: FetchAttempt = yield* httpClient
      .execute(
        HttpClientRequest.get(requestUrl).pipe(
          HttpClientRequest.bearerToken(current.settings.vibeProxy.apiKey),
          HttpClientRequest.setHeader("accept", "application/json"),
        ),
      )
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT_MS),
        Effect.flatMap((response): Effect.Effect<FetchAttempt> => {
          if (response.status === 401 || response.status === 403) {
            return Effect.succeed(
              fetchFailure("unauthorized", "Vibe-Proxy rejected the management key."),
            );
          }
          if (response.status < 200 || response.status >= 300) {
            return Effect.succeed(
              fetchFailure("requestFailed", `Vibe-Proxy returned HTTP ${response.status}.`),
            );
          }
          return response.json.pipe(
            Effect.map((body) => {
              const snapshot = normalizeVibeProxyAuthFiles(body, fetchedAt);
              return snapshot
                ? ({ _tag: "Success", snapshot } satisfies FetchAttempt)
                : fetchFailure(
                    "invalidResponse",
                    "Vibe-Proxy returned an unsupported auth-files response.",
                  );
            }),
            Effect.catchCause(() =>
              Effect.succeed(fetchFailure("invalidResponse", "Vibe-Proxy returned invalid JSON.")),
            ),
          );
        }),
        Effect.catchCause(() =>
          Effect.succeed(fetchFailure("unreachable", "Could not reach Vibe-Proxy.")),
        ),
      );

    if (attempt._tag === "Failure") {
      return result({
        status: "ready",
        snapshot: current.snapshot,
        refreshProblem: attempt.problem,
      });
    }

    yield* writeSnapshot(attempt.snapshot);
    return result({ status: "ready", snapshot: attempt.snapshot, refreshed: true });
  });

  return VibeProxyUsageService.of({ readCached, refresh });
});

export const layer = Layer.effect(VibeProxyUsageService, make);

export const layerTest = (
  result: VibeProxyUsageResult = {
    status: "disabled",
    snapshot: null,
    refreshed: false,
    refreshProblem: null,
  },
) =>
  Layer.succeed(
    VibeProxyUsageService,
    VibeProxyUsageService.of({
      readCached: Effect.succeed(result),
      refresh: Effect.succeed(result),
    }),
  );
