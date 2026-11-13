import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
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
import * as Toml from "smol-toml";

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
// The CLI's OAuthManager serializes credential rotation with a lock file next
// to the credential; the reader is a guest and must not hang the quota lookup
// on it, so acquisition is bounded and best-effort.
const CREDENTIAL_LOCK_RETRY_COUNT = 5;
const CREDENTIAL_LOCK_RETRY_DELAY = "20 millis";
// A lock older than this belongs to a dead process; break it once and retry.
// It must exceed the longest hold (the 10s REQUEST_TIMEOUT refresh) or a live
// reader could break a live peer's lock and double-refresh the same token.
const CREDENTIAL_LOCK_STALE_MS = 15 * 1_000;

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

const MANAGED_KIMI_CODE_PROVIDER_KEY = "managed:kimi-code";

/**
 * Reads `providers["managed:kimi-code"]` (and its `oauth` sub-table) from the
 * CLI's config.toml as real TOML, so both single- and double-quoted spellings
 * count. Malformed config behaves like a missing section, never a crash.
 */
function managedKimiCodeConfig(config: string): {
  readonly baseUrl: string | undefined;
  readonly oauthHost: string | undefined;
  readonly key: string | undefined;
  readonly apiKey: string | undefined;
  readonly apiKeyEnv: string | undefined;
} {
  let parsed: Record<string, unknown>;
  try {
    parsed = Toml.parse(config) as Record<string, unknown>;
  } catch {
    return {
      baseUrl: undefined,
      oauthHost: undefined,
      key: undefined,
      apiKey: undefined,
      apiKeyEnv: undefined,
    };
  }
  const providers = readRecord(parsed["providers"]);
  const provider = readRecord(providers[MANAGED_KIMI_CODE_PROVIDER_KEY]);
  const oauth = readRecord(provider["oauth"]);
  return {
    baseUrl: readString(provider["base_url"]),
    oauthHost: readString(oauth["oauth_host"]),
    key: readString(oauth["key"]),
    apiKey: readString(provider["api_key"]),
    apiKeyEnv: readString(provider["api_key_env"]),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

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

/**
 * Kimi names its ratio rows `limit_5h`, `limit_7d`, and `limit_month_total`;
 * other `limit_month_*` rows are breakdowns, not quota windows.
 */
function kindFromUsageName(name: string): ServerProviderUsageWindow["kind"] | undefined {
  if (name.startsWith("limit_month")) {
    return name === "limit_month_total" ? "monthly" : undefined;
  }
  if (name.startsWith("limit_7d")) return "weekly";
  if (name.includes("5h")) return "session";
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
    if (kind === undefined) continue;
    const minutes =
      kind === "session"
        ? SESSION_MINS
        : kind === "weekly"
          ? 7 * 24 * 60
          : kind === "monthly"
            ? 30 * 24 * 60
            : undefined;
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

/** Compares the fields a rotation can change; extras like `expires_in` never differ in practice. */
function storedCredentialFingerprint(value: KimiStoredCredential): string {
  return `${value.access_token}\u{0}${value.refresh_token}\u{0}${value.expires_at}`;
}

/**
 * Best-effort cross-process lock matching the CLI's `{configDir}/oauth/{name}.lock`
 * protocol. The callback receives `acquired`; without it the caller skips
 * writes — the unverifiable protocol means concurrency is declined, not raced.
 */
const withCredentialLock = Effect.fn("kimiUsageLimits.withCredentialLock")(function* <A, E, R>(
  lockPath: string,
  use: (acquired: boolean) => Effect.Effect<A, E, R>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const owner = `${process.pid}-${yield* Clock.currentTimeMillis}`;
  for (let attempt = 0; attempt <= CREDENTIAL_LOCK_RETRY_COUNT; attempt += 1) {
    const acquired = yield* fileSystem.writeFileString(lockPath, owner, { flag: "wx" }).pipe(
      Effect.as(true),
      // A held lock loses with AlreadyExists; any other failure (unwritable
      // directory, permissions) also means "no lock" rather than a failed probe.
      Effect.orElseSucceed(() => false),
    );
    if (acquired) {
      return yield* Effect.scoped(
        Effect.acquireRelease(Effect.succeed(lockPath), (locked) =>
          fileSystem.remove(locked, { force: true }).pipe(Effect.ignore({ log: true })),
        ).pipe(Effect.andThen(use(true))),
      );
    }
    if (attempt === CREDENTIAL_LOCK_RETRY_COUNT) break;
    // Prior process died holding it: break the stale lock once and retry.
    const stale = yield* fileSystem.stat(lockPath).pipe(
      Effect.flatMap((info) =>
        Clock.currentTimeMillis.pipe(
          Effect.map(
            (now) =>
              Option.isSome(info.mtime) &&
              now - info.mtime.value.getTime() > CREDENTIAL_LOCK_STALE_MS,
          ),
        ),
      ),
      Effect.orElseSucceed(() => false),
    );
    if (stale) {
      yield* fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore({ log: true }));
    }
    yield* Effect.sleep(CREDENTIAL_LOCK_RETRY_DELAY);
  }
  // Unverifiable protocol: without the lock the refresh is declined, not raced.
  return yield* use(false);
});

/**
 * Writes the refreshed credential back after re-reading the file. The CLI owns
 * the credential: a mid-flight rotation or removal (sign-out) means the reader
 * has lost the file and writes nothing — mixing tokens from two sessions onto
 * disk would strand the CLI until they expired.
 */
const persistRefreshedCredential = Effect.fn("kimiUsageLimits.persistRefreshedCredential")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly credentialsPath: string;
    readonly stored: KimiStoredCredential;
    readonly token: typeof KimiTokenRefresh.Type;
    readonly nowMs: number;
  }) {
    const latestContents = yield* input.fileSystem.readFileString(input.credentialsPath).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
      }),
    );
    const latest = Option.getOrUndefined(
      yield* decodeStoredCredential(latestContents).pipe(Effect.option),
    );
    // A missing or undecodable file means the CLI removed or replaced it; the
    // reader recreating it would sign the CLI back into an account it left.
    if (latest === undefined) return;
    // A changed fingerprint means the CLI rotated while this request was in
    // flight. The fingerprint cannot tell a rotation from an account change,
    // so the whole write is dropped rather than persisting a mixed pair. The
    // fresh access token still serves this lookup from memory.
    if (storedCredentialFingerprint(latest) !== storedCredentialFingerprint(input.stored)) {
      return;
    }
    const expiresAt =
      input.token.expires_at ?? Math.floor(input.nowMs / 1000) + (input.token.expires_in ?? 900);
    // Atomic like the config writer: a truncated credential file would sign the
    // CLI itself out. The CLI re-refreshes fine either way. Secrets stay
    // owner-only, like the CLI writes them.
    yield* writeFileStringAtomically({
      filePath: input.credentialsPath,
      contents: serializeStoredCredential(latest, input.token, expiresAt),
      mode: 0o600,
    }).pipe(Effect.catchTags({ PlatformError: () => Effect.void }));
  },
);

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
  const managedConfig = managedKimiCodeConfig(config);
  // An `api_key`/`api_key_env` override replaces OAuth entirely, so a stored
  // OAuth credential belongs to a different account and is out of scope.
  if (managedConfig.apiKey !== undefined || managedConfig.apiKeyEnv !== undefined) {
    return undefined;
  }
  // The CLI's own resolution order: `KIMI_CODE_BASE_URL` and
  // `KIMI_CODE_OAUTH_HOST`/`KIMI_OAUTH_HOST` override the config file, and the
  // credential slot is derived from the resolved endpoints.
  const baseUrl = normalizeEndpoint(
    input.environment.KIMI_CODE_BASE_URL ?? managedConfig.baseUrl,
    DEFAULT_KIMI_CODE_BASE_URL,
  );
  const oauthHost = normalizeEndpoint(
    input.environment.KIMI_CODE_OAUTH_HOST ??
      input.environment.KIMI_OAUTH_HOST ??
      managedConfig.oauthHost,
    DEFAULT_KIMI_OAUTH_HOST,
  );
  const configuredKey = managedConfig.key;
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
  // A lock file next to the credential, matching the CLI's OAuthManager
  // (`{configDir}/oauth/{name}.lock`), so a concurrent CLI refresh and this
  // reader's writeback do not clobber each other's rotated tokens.
  const lockPath = path.join(path.dirname(credentialsPath), `${oauthKey}.lock`);
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
  // result so the CLI's next run reuses it too. Without the lock neither the
  // refresh request nor the writeback runs: the contended credential is
  // left to its owner rather than raced.
  let accessToken = stored.access_token;
  if (stored.expires_at * 1_000 - nowMs <= REFRESH_THRESHOLD_MS) {
    const refreshed: Option.Option<string> = yield* withCredentialLock(lockPath, (acquired) =>
      Effect.gen(function* () {
        if (!acquired) return Option.none();
        const request = HttpClientRequest.post(`${oauthHost}/api/oauth/token`).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: KIMI_CODE_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: stored.refresh_token,
          }),
        );
        // A rejected status or stall decodes to no token instead of failing the probe.
        const body = yield* client.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.option,
        );
        // The flattened shape stays Option<Option<token>> for this gen's union.
        return Option.some(Option.flatMap(body, decodeTokenRefresh));
      }).pipe(
        Effect.map(Option.flatten),
        Effect.flatMap((decoded) =>
          Option.isNone(decoded)
            ? Effect.succeed(Option.none<string>())
            : persistRefreshedCredential({
                fileSystem,
                credentialsPath,
                stored,
                token: decoded.value,
                nowMs,
              }).pipe(Effect.as(Option.some(decoded.value.access_token))),
        ),
      ),
    );
    const freshAccessToken = Option.getOrUndefined(refreshed);
    if (freshAccessToken === undefined) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Kimi Code usage limits could not be read. Try `kimi login` again.",
      });
    }
    accessToken = freshAccessToken;
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
/**
 * The Kimi usage probe as a context service; without its layer the default
 * reports no limits rather than failing the driver.
 */
export class KimiUsageLimits extends Context.Reference<{
  /** The live layer closes over the static deps, so `read` needs no context. */
  readonly read: (
    input: KimiUsageInput,
  ) => Effect.Effect<
    Effect.Success<ReturnType<typeof readKimiUsageLimits>>,
    Effect.Error<ReturnType<typeof readKimiUsageLimits>>
  >;
}>("@t3tools/provider-acp-registry/server/KimiUsageLimits", {
  defaultValue: () => ({ read: () => Effect.undefined }),
}) {}

export const KimiUsageLimitsLive = Layer.effect(
  KimiUsageLimits,
  Effect.gen(function* () {
    // Acquire the static dependencies once in the layer so the service's read
    // is self-contained; callers only supply the per-call provider
    // environment.
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const client = yield* HttpClient.HttpClient;
    const digest = yield* Digest.Digest;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    return {
      read: Effect.fn("KimiUsageLimits.read")((input: KimiUsageInput) =>
        readKimiUsageLimits(input).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(Digest.Digest, digest),
          Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
          Effect.provideService(HostProcess.Platform, platform),
        ),
      ) as (
        input: KimiUsageInput,
      ) => Effect.Effect<
        Effect.Success<ReturnType<typeof readKimiUsageLimits>>,
        Effect.Error<ReturnType<typeof readKimiUsageLimits>>
      >,
    };
  }),
);
