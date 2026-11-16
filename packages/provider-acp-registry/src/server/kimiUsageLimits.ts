import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as Toml from "smol-toml";

import type { AcpRegistrySettings } from "../settings.ts";

// Mirrors Kimi Code 2.x and the archived kimi-cli 1.x. Their refresh tokens are single-use,
// so a refresh whose answer is lost would sign the CLI out. T3 never refreshes or writes
// Kimi's credentials; it only reads the access token the CLI keeps fresh.

const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
/** A token this close to expiry could lapse mid-read, so it counts as expired. */
const EXPIRY_MARGIN_SECONDS = 30;

export type KimiCli = "kimi-code" | "kimi-legacy";

/** Which Kimi CLI an ACP Registry instance runs, or undefined for other agents. */
export function kimiCliCandidates(
  settings: Pick<AcpRegistrySettings, "source" | "agentId" | "commandPath" | "commandArgs">,
): ReadonlyArray<KimiCli> | undefined {
  if (settings.source === "registry") {
    if (settings.agentId === "kimi-code") return ["kimi-code"];
    if (settings.agentId === "kimi") return ["kimi-legacy"];
    return undefined;
  }
  // Package launchers such as `npx @moonshot-ai/kimi-code acp` or `uvx kimi-cli acp`.
  if (settings.commandArgs.some((arg) => /^@moonshot-ai\/kimi-code(?:@|$)/.test(arg))) {
    return ["kimi-code"];
  }
  if (settings.commandArgs.some((arg) => /^kimi-cli(?:[@=<>~]|$)/.test(arg))) {
    return ["kimi-legacy"];
  }
  const name = settings.commandPath
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(exe|cmd|bat|mjs|js)$/i, "")
    .toLowerCase();
  // A local `kimi` is either generation; the 2.x home wins when both are signed in.
  return name === "kimi" || name === "kimi-code" ? ["kimi-code", "kimi-legacy"] : undefined;
}

const QuotaEntry = Schema.Struct({
  used_ratio: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  reset_time: Schema.optional(Schema.NullOr(Schema.String)),
});
const CountedQuota = Schema.Struct({
  window: Schema.Struct({ duration: Schema.Number, timeUnit: Schema.String }),
  detail: Schema.Struct({
    used: Schema.Union([Schema.Number, Schema.String]),
    limit: Schema.Union([Schema.Number, Schema.String]),
    resetTime: Schema.optional(Schema.String),
  }),
});
const UsagePayload = Schema.Struct({
  usages: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  limits: Schema.optional(Schema.Array(Schema.Unknown)),
});
const decodeQuota = Schema.decodeUnknownOption(QuotaEntry);
const decodeCountedQuota = Schema.decodeUnknownOption(CountedQuota);
const UserInfo = Schema.Struct({ user_id: Schema.NonEmptyString });
/** Only what the probe reads; the refresh token is never decoded. */
const TokenFile = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.Number),
});
type TokenFile = typeof TokenFile.Type;
const decodeUsagePayload = Schema.decodeUnknownEffect(UsagePayload);
const decodeUserInfo = Schema.decodeUnknownEffect(UserInfo);
const decodeTokenFile = Schema.decodeEffect(Schema.fromJsonString(TokenFile));

const WINDOWS = [
  { key: "limit_5h", label: "5-hour", kind: "session", windowDurationMins: 5 * 60 },
  { key: "limit_7d", label: "Weekly", kind: "weekly", windowDurationMins: 7 * 24 * 60 },
  { key: "limit_month_total", label: "Monthly", kind: "monthly" },
] as const;

function nonnegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function resetTimestamp(value: string | null | undefined) {
  const instant = value ? DateTime.make(value) : Option.none();
  return Option.isSome(instant) ? { resetsAt: DateTime.formatIso(instant.value) } : {};
}

const MINUTES_PER_UNIT: Readonly<Record<string, number>> = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 1440,
  TIME_UNIT_WEEK: 10080,
};

/** Kimi Code 2.5.1 managed-usage/usage-format: month_code is a breakdown, not another quota. */
export const kimiUsageWindows = (payload: unknown) =>
  decodeUsagePayload(payload).pipe(
    Effect.map(({ usages, limits }) => {
      const windows = new Map<string, ServerProviderUsageWindow>();
      for (const window of WINDOWS) {
        const decoded = decodeQuota(usages?.[window.key]);
        if (Option.isNone(decoded)) continue;
        const entry = decoded.value;
        const ratio = nonnegativeNumber(entry.used_ratio);
        if (ratio === undefined) continue;
        windows.set(window.key, {
          id: window.key,
          label: window.label,
          kind: window.kind,
          usedPercent: clampPercent(Math.round(ratio * 1e6) / 1e4),
          ...resetTimestamp(entry.reset_time),
          ...("windowDurationMins" in window
            ? { windowDurationMins: window.windowDurationMins }
            : {}),
        });
      }
      // Count-based responses are a fallback; preserve the CLI's named ratios when both exist.
      for (const raw of limits ?? []) {
        const decoded = decodeCountedQuota(raw);
        if (Option.isNone(decoded)) continue;
        const { window, detail } = decoded.value;
        const used = nonnegativeNumber(detail.used);
        const limit = nonnegativeNumber(detail.limit);
        const minutes = window.duration * (MINUTES_PER_UNIT[window.timeUnit] ?? 0);
        if (
          used === undefined ||
          limit === undefined ||
          limit <= 0 ||
          !Number.isFinite(minutes) ||
          minutes <= 0
        )
          continue;
        const known =
          minutes === 300
            ? WINDOWS[0]
            : minutes === 10080
              ? WINDOWS[1]
              : minutes === 43200
                ? WINDOWS[2]
                : undefined;
        const id = known?.key ?? `kimi-window-${minutes}`;
        if (windows.has(id)) continue;
        windows.set(id, {
          id,
          label: known?.label ?? `${minutes}-minute`,
          kind: known?.kind ?? "other",
          usedPercent: clampPercent(Math.round((used / limit) * 1e6) / 1e4),
          windowDurationMins: minutes,
          ...resetTimestamp(detail.resetTime),
        });
      }
      return [...windows.values()];
    }),
  );

export interface KimiManagedProviderConfig {
  readonly baseUrl?: string;
  readonly oauthHost?: string;
  readonly oauthStorage?: string;
  readonly hasOAuth: boolean;
  readonly hasApiKey?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function readKimiManagedProviderConfig(source: string): KimiManagedProviderConfig {
  const root = Toml.parse(source);
  const provider = record(record(root.providers)["managed:kimi-code"]);
  const oauth = record(provider.oauth);
  const baseUrl = text(provider.base_url);
  const oauthHost = text(oauth.oauth_host);
  const oauthStorage = text(oauth.storage);
  const hasApiKey = Boolean(
    text(provider.api_key) || text(provider.api_key_env) || text(record(provider.env).KIMI_API_KEY),
  );
  return {
    hasOAuth: provider.oauth !== undefined,
    ...(hasApiKey ? { hasApiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(oauthHost ? { oauthHost } : {}),
    ...(oauthStorage ? { oauthStorage } : {}),
  };
}

const trimEndpoint = (value: string) => value.trim().replace(/\/+$/, "");

/** The CLI hashes `JSON.stringify({ oauthHost, baseUrl })`; key order matters. */
const slotSeed = (oauthHost: string, baseUrl: string) => JSON.stringify({ oauthHost, baseUrl });

export interface KimiCodeAuthTarget {
  /** Credential slot: `<home>/credentials/<slot>.json`. */
  readonly slot: string;
  readonly oauthHost: string;
  readonly baseUrl: string;
}

/**
 * Kimi Code's `resolveKimiCodeRuntimeAuth`: environment overrides win over
 * `config.toml`, and each (OAuth host, API base) pair has its own credential slot.
 */
export const resolveKimiCodeAuthTarget = Effect.fn("resolveKimiCodeAuthTarget")(function* (
  config: KimiManagedProviderConfig,
  environment: NodeJS.ProcessEnv,
) {
  const envBaseUrl = environment.KIMI_CODE_BASE_URL;
  const envOAuthHost = environment.KIMI_CODE_OAUTH_HOST ?? environment.KIMI_OAUTH_HOST;
  const hasEnvOverride = envBaseUrl !== undefined || envOAuthHost !== undefined;
  const configuredBaseUrl =
    envBaseUrl !== undefined ? envBaseUrl.replace(/\/+$/, "") : config.baseUrl;
  const configuredOAuthHost = hasEnvOverride ? envOAuthHost : config.oauthHost;
  const oauthHost = trimEndpoint(configuredOAuthHost ?? DEFAULT_OAUTH_HOST);
  const baseUrl = trimEndpoint(configuredBaseUrl ?? envBaseUrl ?? DEFAULT_BASE_URL);
  if (oauthHost === DEFAULT_OAUTH_HOST && baseUrl === DEFAULT_BASE_URL) {
    return { slot: "kimi-code", oauthHost, baseUrl } satisfies KimiCodeAuthTarget;
  }
  const digest = yield* Digest.Digest;
  const hash = yield* digest
    .digest(Digest.sha256, new TextEncoder().encode(slotSeed(oauthHost, baseUrl)))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
  return {
    slot: `kimi-code-env-${hash.slice(0, 16)}`,
    oauthHost,
    baseUrl,
  } satisfies KimiCodeAuthTarget;
});

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The API base a Kimi access token may be sent to: an HTTPS URL with no user info, query, or
 * fragment, without a trailing slash. Plain HTTP is accepted only for loopback hosts and only
 * when `allowLoopbackHttp` is set, which tests do and the driver never does.
 */
export function kimiApiBaseUrl(
  raw: string,
  options: { readonly allowLoopbackHttp?: boolean } = {},
): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) return undefined;
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      options.allowLoopbackHttp === true &&
      LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

type Unavailable = {
  readonly unavailable: "unsupported";
  readonly message: string;
};
const unsupported = (message: string): Unavailable => ({ unavailable: "unsupported", message });

// A sign-in problem is "unsupported", never "probeFailed": the provider keeps the last good
// reading over a failed probe, which would show limits T3 can no longer confirm as current.
const SIGN_IN = unsupported("Sign in to Kimi Code to see its limits.");
const SIGNED_OUT = unsupported(
  "Kimi's sign-in has ended. Sign in to Kimi again to see its limits.",
);
const REJECTED = unsupported(
  "Kimi rejected its stored sign-in. Use Kimi once or sign in again, then refresh provider status.",
);
const NO_EXPIRY = unsupported(
  "Kimi's stored sign-in has no expiry time. Use Kimi once, then refresh provider status.",
);
const INVALID_CONFIG = unsupported(
  "Could not parse Kimi's config.toml. Fix it and refresh provider status.",
);
const FILE_STORAGE = unsupported("Kimi limits need Kimi Code's file-based sign-in.");
const INSECURE_ENDPOINT = unsupported("Kimi limits are read only from an HTTPS Kimi endpoint.");
const LEGACY_CUSTOM_ENDPOINT = unsupported(
  "Limits for the legacy Kimi CLI are read only from Kimi's default endpoint.",
);
const NO_LIMITS = unsupported("This Kimi endpoint does not report plan limits.");
const UNREADABLE = unsupported("Could not read Kimi limits. Refresh provider status to retry.");

const expiredSignIn = (expiresAt: number, now: number) => {
  const at = Option.match(DateTime.make(expiresAt * 1000), {
    onNone: () => "",
    onSome: (time) => ` at ${DateTime.formatIso(time)}`,
  });
  return unsupported(
    `Kimi's sign-in ${expiresAt <= now ? "expired" : "is about to expire"}${at}. Kimi renews it while you use it: use Kimi once, then refresh provider status.`,
  );
};

interface Credentials {
  readonly accessToken: string;
  readonly baseUrl: string;
}

export interface KimiUsageProbeInput {
  readonly candidates: ReadonlyArray<KimiCli>;
  readonly environment: NodeJS.ProcessEnv;
  /** Tests only: let tokens go to `http://` loopback endpoints. */
  readonly allowLoopbackHttp?: boolean;
}

/**
 * Reads Kimi plan limits with the access token a Kimi CLI keeps on disk. The probe only reads
 * the CLI's files; an expired token is reported, not refreshed.
 */
export const makeKimiUsageProbe = Effect.fn("makeKimiUsageProbe")(function* (
  input: KimiUsageProbeInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const client = yield* HttpClient.HttpClient;
  const env = input.environment;
  const home = env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory);
  const endpointOptions = { allowLoopbackHttp: input.allowLoopbackHttp === true };

  const readOptional = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(error),
      }),
    );
  const readToken = (file: string): Effect.Effect<Option.Option<TokenFile>, PlatformError> =>
    readOptional(file).pipe(
      Effect.flatMap((text) =>
        Option.isNone(text)
          ? Effect.succeedNone
          : // The CLI treats a corrupt file as "no token stored".
            decodeTokenFile(text.value).pipe(
              Effect.asSome,
              Effect.orElseSucceed(() => Option.none<TokenFile>()),
            ),
      ),
    );

  /** The stored access token, or why it cannot be used right now. */
  const currentAccessToken = Effect.fn("KimiUsage.currentAccessToken")(function* (
    token: TokenFile,
  ) {
    // An empty access token is the CLI's tombstone for a rejected refresh token.
    if (!token.access_token) return SIGNED_OUT;
    const expiresAt = token.expires_at;
    if (expiresAt === undefined || !Number.isFinite(expiresAt)) return NO_EXPIRY;
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    if (expiresAt - now <= EXPIRY_MARGIN_SECONDS) return expiredSignIn(expiresAt, now);
    return token.access_token;
  });

  const kimiCodeCredentials = Effect.fn("KimiUsage.kimiCodeCredentials")(function* () {
    const kimiHome = env.KIMI_CODE_HOME || path.join(home, ".kimi-code");
    if (!path.isAbsolute(kimiHome))
      return unsupported("Set KIMI_CODE_HOME to an absolute path to read Kimi limits.");
    const source = Option.getOrElse(
      yield* readOptional(path.join(kimiHome, "config.toml")),
      () => "",
    );
    const parsed = yield* Effect.try({
      try: () => readKimiManagedProviderConfig(source),
      catch: () => INVALID_CONFIG,
    }).pipe(Effect.option);
    if (Option.isNone(parsed)) return INVALID_CONFIG;
    const config = parsed.value;
    if (config.hasApiKey)
      return unsupported("Kimi API-key configurations do not report subscription limits.");
    if (config.oauthStorage !== undefined && config.oauthStorage !== "file") return FILE_STORAGE;
    const target = yield* resolveKimiCodeAuthTarget(config, env).pipe(
      Effect.provideService(Digest.Digest, digest),
    );
    const stored = yield* readToken(path.join(kimiHome, "credentials", `${target.slot}.json`));
    if (Option.isNone(stored)) return config.hasOAuth ? SIGNED_OUT : SIGN_IN;
    const accessToken = yield* currentAccessToken(stored.value);
    if (typeof accessToken !== "string") return accessToken;
    // The slot's token was issued for this base URL, but only ever leaves over HTTPS.
    const baseUrl = kimiApiBaseUrl(target.baseUrl, endpointOptions);
    if (baseUrl === undefined) return INSECURE_ENDPOINT;
    return { accessToken, baseUrl } satisfies Credentials;
  });

  /** The 1.x CLI's single credential belongs to Kimi's own endpoint, so it is never sent elsewhere. */
  const legacyCredentials = Effect.fn("KimiUsage.legacyCredentials")(function* () {
    const shareDir = env.KIMI_SHARE_DIR || path.join(home, ".kimi");
    if (!path.isAbsolute(shareDir))
      return unsupported("Set KIMI_SHARE_DIR to an absolute path to read Kimi limits.");
    const stored = yield* readToken(path.join(shareDir, "credentials", "kimi-code.json"));
    if (Option.isNone(stored)) return SIGN_IN;
    const accessToken = yield* currentAccessToken(stored.value);
    if (typeof accessToken !== "string") return accessToken;
    const override = env.KIMI_CODE_BASE_URL;
    if (override !== undefined && trimEndpoint(override) !== DEFAULT_BASE_URL) {
      return LEGACY_CUSTOM_ENDPOINT;
    }
    return { accessToken, baseUrl: DEFAULT_BASE_URL } satisfies Credentials;
  });

  const credentials = Effect.gen(function* () {
    let reported: Unavailable | undefined;
    for (const cli of input.candidates) {
      const result =
        cli === "kimi-code" ? yield* kimiCodeCredentials() : yield* legacyCredentials();
      if ("accessToken" in result) return result;
      // A configured modern account must not fall back to an unrelated legacy sign-in.
      if (result !== SIGN_IN) return result;
      reported = result;
    }
    return reported ?? SIGN_IN;
  });

  const get = (credentials: Credentials, resource: string) =>
    client
      .execute(
        HttpClientRequest.get(`${credentials.baseUrl}/${resource}`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(credentials.accessToken),
        ),
      )
      // A redirect must not carry the token to another URL; a 3xx answer fails the read.
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));

  const read = Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const resolved = yield* credentials;
    if ("unavailable" in resolved) {
      return makeUnavailableUsageLimits({ checkedAt, ...asLimits(resolved) });
    }
    const [usage, account] = yield* Effect.all(
      [
        get(resolved, "usages"),
        // The account ID merges one Kimi account across instances and environments.
        get(resolved, "me").pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.flatMap(decodeUserInfo),
          Effect.flatMap((info) =>
            digest.digest(
              Digest.sha256,
              new TextEncoder().encode(
                `kimi-code\0${new URL(resolved.baseUrl).origin}\0${info.user_id}`,
              ),
            ),
          ),
          Effect.map(Hex.encode),
          Effect.option,
        ),
      ],
      { concurrency: "unbounded" },
    );
    if (usage.status === 401 || usage.status === 403) {
      return makeUnavailableUsageLimits({ checkedAt, ...asLimits(REJECTED) });
    }
    if (usage.status === 404) {
      return makeUnavailableUsageLimits({ checkedAt, ...asLimits(NO_LIMITS) });
    }
    const windows = yield* HttpClientResponse.filterStatusOk(usage).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(kimiUsageWindows),
    );
    if (windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Kimi did not return usable quota information.",
      });
    }
    return {
      ...makeUsageLimits({ checkedAt, windows }),
      ...(Option.isSome(account) ? { credentialFingerprint: account.value } : {}),
    } satisfies ServerProviderUsageLimits;
  });

  return read.pipe(
    Effect.timeout("30 seconds"),
    Effect.catch(() =>
      Effect.map(DateTime.now, (now) =>
        makeUnavailableUsageLimits({
          checkedAt: DateTime.formatIso(now),
          ...asLimits(UNREADABLE),
        }),
      ),
    ),
  );
});

function asLimits(value: Unavailable) {
  return { reason: value.unavailable, message: value.message };
}

export type KimiUsageInput = KimiUsageProbeInput;

export const readKimiUsageLimits = Effect.fn("readKimiUsageLimits")(function* (
  input: KimiUsageInput,
) {
  return yield* yield* makeKimiUsageProbe(input);
});

export class KimiUsageLimits extends Context.Reference<{
  readonly read: (input: KimiUsageInput) => Effect.Effect<ServerProviderUsageLimits | undefined>;
}>("@t3tools/provider-acp-registry/server/KimiUsageLimits", {
  defaultValue: () => ({ read: () => Effect.undefined }),
}) {}

export const KimiUsageLimitsLive = Layer.effect(
  KimiUsageLimits,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const client = yield* HttpClient.HttpClient;
    const digest = yield* Digest.Digest;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    return {
      read: Effect.fn("KimiUsageLimits.read")((input: KimiUsageInput) =>
        readKimiUsageLimits(input).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(Digest.Digest, digest),
          Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
        ),
      ),
    };
  }),
);
