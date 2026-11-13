import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";

/** Kimi Code reports limits from `{base_url}/usages` with its stored OAuth token. */
const DEFAULT_KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_KIMI_OAUTH_HOST = "https://auth.kimi.com";
const KIMI_CODE_OAUTH_KEY = "kimi-code";
const KIMI_CODE_SCOPED_OAUTH_KEY_PREFIX = "kimi-code-env-";
// Kimi's device-code flow client, shared by every CLI install.
const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
// Kimi's default shared deployments all store credentials in the unscoped slot.
const DEFAULT_MANAGED_ENVIRONMENTS: ReadonlyArray<{
  readonly oauthHost: string;
  readonly baseUrl: string;
}> = [
  { oauthHost: "https://auth.kimi.com", baseUrl: "https://api.kimi.com/coding/v1" },
  { oauthHost: "https://auth.kimi.com", baseUrl: "https://api.kimi.ai/coding/v1" },
];
// Access tokens live 15 minutes; refresh just before the boundary like the CLI.
const REFRESH_THRESHOLD_MS = 60 * 1_000;
const REQUEST_TIMEOUT = "10 seconds";
const SESSION_MINS = 5 * 60;

const KimiStoredCredential = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_at: Schema.Number,
  scope: Schema.optional(Schema.String),
  token_type: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
});
type KimiStoredCredential = typeof KimiStoredCredential.Type;
const decodeStoredCredential = Schema.decodeEffect(Schema.fromJsonString(KimiStoredCredential));

/** Kimi reports counts as strings; `remaining` present but redundant. */
const KimiUsageDetail = Schema.Struct({
  limit: Schema.String,
  used: Schema.String,
  resetTime: Schema.optional(Schema.String),
});
const KimiUsageWindow = Schema.Struct({
  duration: Schema.Number,
  timeUnit: Schema.Literals([
    "TIME_UNIT_MINUTE",
    "TIME_UNIT_HOUR",
    "TIME_UNIT_DAY",
    "TIME_UNIT_WEEK",
  ]),
});
const KimiUsageLimitRow = Schema.Struct({
  window: Schema.optional(KimiUsageWindow),
  detail: KimiUsageDetail,
});
const KimiUsageRatio = Schema.Struct({
  used_ratio: Schema.Number,
  reset_time: Schema.optional(Schema.String),
});
const KimiUsagesResponse = Schema.Struct({
  limits: Schema.optional(Schema.Array(KimiUsageLimitRow)),
  usages: Schema.optional(Schema.Record(Schema.String, KimiUsageRatio)),
});
type KimiUsagesResponse = typeof KimiUsagesResponse.Type;
const decodeUsagesResponse = Schema.decodeUnknownOption(KimiUsagesResponse);

const KimiTokenRefresh = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.Number),
  expires_in: Schema.optional(Schema.Number),
});
const decodeTokenRefresh = Schema.decodeUnknownOption(KimiTokenRefresh);
/** The scoped-credential hash input is the CLI's exact JSON shape. */
const encodeEnvironmentJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ oauthHost: Schema.String, baseUrl: Schema.String })),
);

const textEncoder = new TextEncoder();

function normalizeEndpoint(value: string | undefined, fallback: string): string {
  return (value ?? fallback).trim().replace(/\/+$/, "");
}

function isoFromInstant(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

/**
 * Kimi's scoped credential filename is the first 16 hex characters of
 * sha256(JSON.stringify({ oauthHost, baseUrl })), mirroring the CLI exactly.
 */
export function kimiOAuthKey(input: {
  readonly oauthHost: string;
  readonly baseUrl: string;
  readonly sha256Hex: string;
}): string {
  for (const managed of DEFAULT_MANAGED_ENVIRONMENTS) {
    if (managed.oauthHost === input.oauthHost && managed.baseUrl === input.baseUrl) {
      return KIMI_CODE_OAUTH_KEY;
    }
  }
  return `${KIMI_CODE_SCOPED_OAUTH_KEY_PREFIX}${input.sha256Hex.slice(0, 16)}`;
}

function percentFromCounts(used: string, limit: string): number | undefined {
  const usedCount = Number(used);
  const limitCount = Number(limit);
  if (
    !Number.isFinite(usedCount) ||
    !Number.isFinite(limitCount) ||
    usedCount < 0 ||
    limitCount <= 0
  ) {
    return undefined;
  }
  return clampPercent((usedCount / limitCount) * 100);
}

const MINUTES_PER_UNIT: Record<string, number> = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 24 * 60,
  TIME_UNIT_WEEK: 7 * 24 * 60,
};

function minutesFromWindow(window: typeof KimiUsageWindow.Type): number | undefined {
  const multiplier = MINUTES_PER_UNIT[window.timeUnit];
  if (multiplier === undefined || !Number.isFinite(window.duration) || window.duration <= 0) {
    return undefined;
  }
  return Math.round(window.duration * multiplier);
}

/** Kimi names its ratio rows `limit_5h` and `limit_month_*`. */
function kindFromUsageName(name: string): ServerProviderUsageWindow["kind"] {
  if (name.startsWith("limit_month")) return "monthly";
  if (name.startsWith("limit_5h") || name.includes("5h")) return "session";
  return "other";
}

/** Kimi sends one `limits[]` row per active subscription window. */
function kindFromWindowMinutes(minutes: number | undefined): ServerProviderUsageWindow["kind"] {
  if (minutes === undefined) return "other";
  if (minutes <= SESSION_MINS) return "session";
  if (minutes % (7 * 24 * 60) === 0) return "weekly";
  if (minutes % (24 * 60) === 0) return "monthly";
  return "other";
}

function labelFromKind(kind: ServerProviderUsageWindow["kind"]): string {
  return kind === "session"
    ? "Session"
    : kind === "weekly"
      ? "Weekly"
      : kind === "monthly"
        ? "Monthly"
        : "Limit";
}

/** One row per window; `limits[]` counts win over same-kind `usages` ratios. */
export function kimiUsageResponseToLimits(
  response: KimiUsagesResponse,
  checkedAt: string,
): ServerProviderUsageLimits {
  const windows = new Map<string, ServerProviderUsageWindow>();
  const push = (
    kind: ServerProviderUsageWindow["kind"],
    usedPercent: number,
    resetsAt: string | undefined,
    windowDurationMins: number | undefined,
  ) => {
    if (windows.has(kind)) return;
    windows.set(kind, {
      id: kind,
      kind,
      label: labelFromKind(kind),
      usedPercent,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
    });
  };
  for (const row of response.limits ?? []) {
    const usedPercent = percentFromCounts(row.detail.used, row.detail.limit);
    if (usedPercent === undefined) continue;
    const minutes = row.window === undefined ? undefined : minutesFromWindow(row.window);
    push(
      kindFromWindowMinutes(minutes),
      usedPercent,
      isoFromInstant(row.detail.resetTime),
      minutes,
    );
  }
  for (const [name, ratio] of Object.entries(response.usages ?? {})) {
    if (!Number.isFinite(ratio.used_ratio)) continue;
    const kind = kindFromUsageName(name);
    const minutes =
      kind === "session" ? SESSION_MINS : kind === "monthly" ? 30 * 24 * 60 : undefined;
    // Ratios carry float noise (0.3616 * 100 === 36.199999999999996).
    const usedPercent = Math.round(ratio.used_ratio * 100 * 100) / 100;
    push(kind, clampPercent(usedPercent), isoFromInstant(ratio.reset_time?.trim()), minutes);
  }
  return makeUsageLimits({ checkedAt, windows: windows.values() });
}

export interface KimiUsageInput {
  readonly environment: NodeJS.ProcessEnv;
  /** Test seam for the clock; defaults to the real wall clock. */
  readonly nowMs?: number;
}

export type KimiUsageEnvironment =
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | Digest.Digest
  | typeof HostProcess.HomeDirectory
  | typeof HostProcess.Platform;

/** Wire format matches the CLI's own credential files, snake_case included. */
const encodeStoredCredential = Schema.encodeSync(Schema.fromJsonString(KimiStoredCredential));
function serializeStoredCredential(
  stored: KimiStoredCredential,
  refresh: typeof KimiTokenRefresh.Type,
  expiresAtSeconds: number,
): string {
  return `${encodeStoredCredential({
    access_token: refresh.access_token,
    refresh_token: refresh.refresh_token ?? stored.refresh_token,
    expires_at: expiresAtSeconds,
    scope: stored.scope ?? "kimi-code",
    token_type: stored.token_type ?? "Bearer",
    expires_in: refresh.expires_in ?? 900,
  })}\n`;
}

/**
 * Reads Kimi Code subscription usage limits from the CLI's own credential
 * store. `undefined` means no managed credential applies (custom auth keeps
 * usage limits out of scope); reachable-but-failing probes surface as
 * probeFailed bars that keep earlier windows visible.
 */
export const readKimiUsageLimits = Effect.fn("readKimiUsageLimits")(function* (
  input: KimiUsageInput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  const nowMs = input.nowMs ?? (yield* DateTime.now).epochMilliseconds;
  const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));

  const homeDirectory =
    input.environment.KIMI_CODE_HOME?.trim() ||
    path.join(
      input.environment.HOME || input.environment.USERPROFILE || (yield* HostProcess.HomeDirectory),
      ".kimi-code",
    );

  // The managed provider's config names its endpoints and may pin the
  // credential slot explicitly (`key = "oauth/..."`).
  const config = yield* fileSystem.readFileString(path.join(homeDirectory, "config.toml")).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
    }),
  );
  const providerSection = config.match(/\[providers\."managed:kimi-code"\]([^[]*)/);
  const oauthSection = config.match(/\[providers\."managed:kimi-code"\.oauth\]([^[]*)/);
  // The CLI's own resolution order: `KIMI_CODE_BASE_URL` and
  // `KIMI_CODE_OAUTH_HOST`/`KIMI_OAUTH_HOST` override the config file, and the
  // credential slot is derived from the resolved endpoints.
  const baseUrl = normalizeEndpoint(
    input.environment.KIMI_CODE_BASE_URL ??
      providerSection?.[1]?.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1],
    DEFAULT_KIMI_CODE_BASE_URL,
  );
  const oauthHost = normalizeEndpoint(
    input.environment.KIMI_CODE_OAUTH_HOST ??
      input.environment.KIMI_OAUTH_HOST ??
      oauthSection?.[1]?.match(/^\s*oauth_host\s*=\s*"([^"]+)"/m)?.[1],
    DEFAULT_KIMI_OAUTH_HOST,
  );
  const configuredKey = oauthSection?.[1]?.match(/^\s*key\s*=\s*"([^"]+)"/m)?.[1];
  // An env override re-derives the slot even where the config pins one, exactly
  // like the CLI's runtime auth resolution.
  const hasEnvOverride =
    input.environment.KIMI_CODE_BASE_URL !== undefined ||
    input.environment.KIMI_CODE_OAUTH_HOST !== undefined ||
    input.environment.KIMI_OAUTH_HOST !== undefined;
  const oauthKey =
    configuredKey !== undefined && !hasEnvOverride
      ? configuredKey.replace(/^oauth\//, "")
      : kimiOAuthKey({
          oauthHost,
          baseUrl,
          sha256Hex: yield* digest.digestHex(
            Digest.sha256,
            textEncoder.encode(encodeEnvironmentJson({ oauthHost, baseUrl })),
          ),
        });

  const credentialsPath = path.join(homeDirectory, "credentials", `${oauthKey}.json`);
  const contents = yield* fileSystem.readFileString(credentialsPath).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
    }),
  );
  // No managed credential means the usage endpoint does not apply, not that it failed.
  const stored = Option.getOrUndefined(yield* decodeStoredCredential(contents).pipe(Effect.option));
  if (stored === undefined) return undefined;

  // Kimi mints 15-minute access tokens; refresh proactively and persist the
  // result so the CLI's next run reuses it too.
  let accessToken = stored.access_token;
  if (stored.expires_at * 1_000 - nowMs <= REFRESH_THRESHOLD_MS) {
    const refreshed = yield* Effect.gen(function* () {
      const request = HttpClientRequest.post(`${oauthHost}/api/oauth/token`).pipe(
        HttpClientRequest.bodyUrlParams({
          client_id: KIMI_CODE_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: stored.refresh_token,
        }),
      );
      const body: unknown = yield* client.execute(request).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        // Headers and body arrive separately; a stalled body must not hang the probe.
        Effect.timeout(REQUEST_TIMEOUT),
      );
      return decodeTokenRefresh(body);
    }).pipe(Effect.option, Effect.map(Option.flatten));
    const token = Option.getOrUndefined(refreshed);
    if (token === undefined) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Kimi Code usage limits could not be read. Try `kimi login` again.",
      });
    }
    accessToken = token.access_token;
    const expiresAt = token.expires_at ?? Math.floor(nowMs / 1000) + (token.expires_in ?? 900);
    // Atomic like the config writer: a truncated credential file would sign the
    // CLI itself out. The CLI re-refreshes fine either way.
    yield* writeFileStringAtomically({
      filePath: credentialsPath,
      contents: serializeStoredCredential(stored, token, expiresAt),
    }).pipe(Effect.catchTags({ PlatformError: () => Effect.void }));
  }

  const response = yield* Effect.gen(function* () {
    const request = HttpClientRequest.get(`${baseUrl}/usages`).pipe(
      HttpClientRequest.bearerToken(accessToken),
    );
    const body: unknown = yield* client.execute(request).pipe(
      // Kimi answers a signed-out or non-managed account with 401/403, and a
      // non-Kimi base URL with 404; other error statuses must follow the same
      // path instead of decoding an error body as empty limits.
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((executed) => executed.json),
      // Headers and body arrive separately; a stalled body must not hang the probe.
      Effect.timeout(REQUEST_TIMEOUT),
    );
    return decodeUsagesResponse(body);
  }).pipe(Effect.option);
  const parsed = Option.isSome(response) ? Option.getOrUndefined(response.value) : undefined;
  if (parsed === undefined) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Kimi Code did not report usage limits. Try `kimi login` again.",
    });
  }
  return kimiUsageResponseToLimits(parsed, checkedAt);
});
