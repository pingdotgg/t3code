import * as NodeModule from "node:module";

import type { AntigravitySettings, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

export function antigravityUserAgent(platform: NodeJS.Platform, architecture: NodeJS.Architecture) {
  return `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${architecture}; cl=963137146)`;
}

const DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
// The ACP runtime meters consumer tiers on the daily host and GCP-terms tiers on prod.
// The sign-in method stands in for the tier.
const ENDPOINTS = {
  "oauth-personal": [DAILY_ENDPOINT, PROD_ENDPOINT],
  "oauth-business": [PROD_ENDPOINT, DAILY_ENDPOINT],
};
const SUMMARY_WINDOW_MINS = new Map([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const TokenFile = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  project_id: Schema.optional(Schema.String),
});
// The 1.5.x CLI never writes acp_token.json: it keeps its sign-in in the OS keyring, or in
// antigravity-oauth-token without one or when T3 bypasses the keyring. It stores no OAuth client, so T3 cannot refresh it.
const CliToken = Schema.Struct({
  token: Schema.Struct({
    access_token: Schema.NonEmptyString,
    refresh_token: Schema.optional(Schema.String),
    expiry: Schema.optional(Schema.String),
  }),
});
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
});
const UserInfo = Schema.Struct({ id: Schema.NonEmptyString });
const Quota = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
});
const Bucket = Schema.Struct({
  ...Quota.fields,
  bucketId: Schema.NonEmptyString,
  window: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
const Summary = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.optional(Schema.String),
        buckets: Schema.optional(Schema.Array(Bucket)),
      }),
    ),
  ),
  buckets: Schema.optional(Schema.Array(Bucket)),
});
const Models = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      modelProvider: Schema.optional(Schema.String),
      isInternal: Schema.optional(Schema.Boolean),
      quotaInfo: Schema.optional(Quota),
      weeklyQuotaInfo: Schema.optional(Quota),
    }),
  ),
});

const decodeTokenFile = Schema.decodeEffect(Schema.fromJsonString(TokenFile));
const decodeCliToken = Schema.decodeEffect(Schema.fromJsonString(CliToken));
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const decodeUserInfo = Schema.decodeUnknownEffect(UserInfo);
const decodeSummary = Schema.decodeUnknownEffect(Summary);
const decodeModels = Schema.decodeUnknownEffect(Models);

function iso(value: string | undefined): string | undefined {
  const parsed = value ? DateTime.make(value) : Option.none();
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function quotaWindow(
  id: string,
  label: string,
  quota: typeof Quota.Type,
  kind: ServerProviderUsageWindow["kind"] = "other",
  windowDurationMins?: number,
): ServerProviderUsageWindow | undefined {
  if (quota.remainingFraction === undefined || !Number.isFinite(quota.remainingFraction)) {
    return undefined;
  }
  const resetsAt = iso(quota.resetTime);
  return {
    id,
    label,
    kind,
    usedPercent: (1 - Math.max(0, Math.min(1, quota.remainingFraction))) * 100,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

function summaryResetTime(
  bucket: typeof Bucket.Type,
  windowDurationMins: number | undefined,
  requestedAt: number,
): string | undefined {
  // Untouched summary buckets report a rolling full-window reset.
  const untouched =
    bucket.remainingFraction === 1 &&
    bucket.description === undefined &&
    windowDurationMins !== undefined &&
    Math.abs(Date.parse(bucket.resetTime ?? "") - requestedAt - windowDurationMins * 60_000) <=
      60_000;
  return untouched ? undefined : bucket.resetTime;
}

const sha256 = Effect.fnUntraced(function* (text: string) {
  const digest = yield* (yield* Digest.Digest).digest(
    Digest.sha256,
    new TextEncoder().encode(text),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

/** go-keyring stores UTF-8, which it prefixes and encodes on macOS. */
export function decodeGoKeyringSecret(secret: ArrayLike<number>): string {
  // The binding resolves a plain number array at runtime despite its Uint8Array type.
  const text = new TextDecoder().decode(Uint8Array.from(secret));
  if (text.startsWith("go-keyring-base64:")) {
    return Buffer.from(text.slice("go-keyring-base64:".length), "base64").toString("utf8");
  }
  if (text.startsWith("go-keyring-encoded:")) {
    return Buffer.from(text.slice("go-keyring-encoded:".length), "hex").toString("utf8");
  }
  return text;
}

class AntigravityKeyringError extends Schema.TaggedError<AntigravityKeyringError>()(
  "AntigravityKeyringError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the Antigravity sign-in from the system keyring.";
  }
}

// A single-executable server resolves packages on disk only through `require`.
const requireExternal = NodeModule.createRequire(import.meta.url);

/**
 * go-keyring's Windows target is `gemini:antigravity`; @napi-rs/keyring reads `antigravity.gemini`,
 * and its `withTarget` overwrites the target with an empty secret before reading.
 */
export function readWindowsCliCredential(
  architecture: NodeJS.Architecture,
): Uint8Array | undefined {
  // CREDENTIALW offsets and the pointers below are 64-bit.
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error(`no credential access on ${architecture}`);
  }
  const { DataType, load, open } = requireExternal("ffi-rs") as typeof import("ffi-rs");
  open({ library: "t3-advapi32", path: "advapi32.dll" });
  open({ library: "t3-kernel32", path: "kernel32.dll" });
  const copy = (into: Buffer, from: bigint) =>
    load({
      library: "t3-kernel32",
      funcName: "RtlMoveMemory",
      retType: DataType.Void,
      paramsType: [DataType.U8Array, DataType.BigInt, DataType.BigInt],
      paramsValue: [into, from, BigInt(into.length)],
    });
  const out = Buffer.alloc(8);
  const read = load({
    library: "t3-advapi32",
    funcName: "CredReadW",
    retType: DataType.I32,
    // CRED_TYPE_GENERIC
    paramsType: [DataType.WString, DataType.U32, DataType.U32, DataType.U8Array],
    paramsValue: ["gemini:antigravity", 1, 0, out],
    errno: true as const,
  });
  if (read.value === 0) {
    // ERROR_NOT_FOUND
    if (read.errnoCode === 1168) return undefined;
    throw new Error(`CredReadW failed with Windows error ${read.errnoCode}`);
  }
  const credential = out.readBigUInt64LE();
  try {
    // CredentialBlobSize is a DWORD at 32 and CredentialBlob a pointer at 40.
    const header = Buffer.alloc(48);
    copy(header, credential);
    const size = header.readUInt32LE(32);
    if (size === 0) return undefined;
    const blob = Buffer.alloc(size);
    copy(blob, header.readBigUInt64LE(40));
    return blob;
  } finally {
    load({
      library: "t3-advapi32",
      funcName: "CredFree",
      retType: DataType.Void,
      paramsType: [DataType.BigInt],
      paramsValue: [credential],
    });
  }
}

// Loaded lazily: a native binding that fails to load must not take the provider down.
const readCliKeyringSecret = (platform: NodeJS.Platform, architecture: NodeJS.Architecture) =>
  Effect.tryPromise({
    try: async () => {
      const secret =
        platform === "win32"
          ? readWindowsCliCredential(architecture)
          : await new (
              requireExternal("@napi-rs/keyring") as typeof import("@napi-rs/keyring")
            ).AsyncEntry("gemini", "antigravity").getSecret();
      return secret ? decodeGoKeyringSecret(secret) : undefined;
    },
    catch: (cause) => new AntigravityKeyringError({ cause }),
  });

/** Keys an account by its Google ID, which matches across machines and hubs; refresh tokens do not. */
export const antigravityAccountFingerprint = (userInfo: unknown) =>
  decodeUserInfo(userInfo).pipe(Effect.flatMap((info) => sha256(`google-account\0${info.id}`)));

/** Windows from a `retrieveUserQuotaSummary` answer requested at `requestedAt`. */
export const antigravitySummaryWindows = (response: unknown, requestedAt: number) =>
  decodeSummary(response).pipe(Effect.map((summary) => summaryWindows(summary, requestedAt)));

function summaryWindows(summary: typeof Summary.Type, requestedAt: number) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  const groups = summary.groups?.some((group) => group.buckets?.length)
    ? summary.groups
    : [{ buckets: summary.buckets }];
  for (const group of groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled) continue;
      // Argon and Carbon are metered separately from the default Gemini buckets.
      const family = bucket.bucketId.startsWith("gemini-argon-")
        ? group.displayName?.trim() || "Gemini Argon"
        : bucket.bucketId.startsWith("gemini-carbon-")
          ? group.displayName?.trim() || "Gemini Carbon"
          : bucket.bucketId.startsWith("gemini-")
            ? "Gemini"
            : bucket.bucketId.startsWith("3p-")
              ? "Claude & GPT (shared)"
              : group.displayName?.trim() || bucket.bucketId;
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const windowDurationMins = SUMMARY_WINDOW_MINS.get(bucket.window ?? "");
      const window = quotaWindow(
        bucket.bucketId,
        `${family} · ${weekly ? "Weekly" : session ? "5-hour" : bucket.displayName?.trim() || "Quota"}`,
        { ...bucket, resetTime: summaryResetTime(bucket, windowDurationMins, requestedAt) },
        weekly ? "weekly" : session ? "session" : "other",
        windowDurationMins,
      );
      if (window) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

/** Older accounts expose model quotas without a window length. Do not invent a reset cadence. */
function modelWindows(models: typeof Models.Type, onlyGemini = false) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const [modelId, model] of Object.entries(models.models)) {
    if (model.isInternal) continue;
    const family =
      model.modelProvider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-")
        ? "Gemini"
        : model.modelProvider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-")
          ? "Claude"
          : model.modelProvider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-")
            ? "GPT"
            : undefined;
    if (!family || (onlyGemini && family !== "Gemini")) continue;
    for (const [suffix, quota] of [
      ["quota", model.quotaInfo],
      ["weekly", model.weeklyQuotaInfo],
    ] as const) {
      if (!quota) continue;
      const window = quotaWindow(
        `${family.toLowerCase()}-${suffix}`,
        `${family} · ${suffix === "weekly" ? "Weekly" : "Reported quota"}`,
        quota,
        suffix === "weekly" ? "weekly" : "other",
        suffix === "weekly" ? 7 * 24 * 60 : undefined,
      );
      if (!window) continue;
      const previous = windows.get(window.id);
      if (
        !previous ||
        window.usedPercent > previous.usedPercent ||
        (window.usedPercent === previous.usedPercent && !previous.resetsAt && window.resetsAt)
      ) {
        windows.set(window.id, window);
      }
    }
  }
  return [...windows.values()];
}

export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly readKeyringSecret?: Effect.Effect<string | undefined, AntigravityKeyringError>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const crypto = yield* Digest.Digest;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const tokenPath = path.join(input.profileDirectory, "antigravity-acp", "acp_token.json");
  const cliTokenPath = path.join(
    input.profileDirectory,
    "antigravity-acp",
    "antigravity-oauth-token",
  );
  const readKeyringSecret = input.readKeyringSecret ?? readCliKeyringSecret(platform, architecture);
  let cached:
    | { fingerprint: string; account: string; accessToken: string; expiresAt: number }
    | undefined;
  let generation = 0;

  const request = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout("10 seconds"),
    );
  const read = Effect.gen(function* () {
    const startedGeneration = generation;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    const now = yield* Clock.currentTimeMillis;
    let accessToken: string;
    let account: string;
    let projectId: string | undefined;
    if (!(yield* fs.exists(tokenPath))) {
      cached = undefined;
      // Google account instances bypass the keyring, whose one entry every profile shares.
      const stored = (yield* fs.exists(cliTokenPath))
        ? yield* fs.readFileString(cliTokenPath)
        : input.authMethod === "oauth-business"
          ? yield* readKeyringSecret
          : undefined;
      if (stored === undefined) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "Sign in with Google to see Antigravity limits.",
        });
      }
      const { token } = yield* decodeCliToken(stored);
      if (!(Date.parse(token.expiry ?? "") > now + 60_000)) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message:
            "Antigravity's saved sign-in has expired. Start an Antigravity turn to renew it, then refresh limits.",
        });
      }
      accessToken = token.access_token;
      account = yield* request(
        HttpClientRequest.get("https://www.googleapis.com/oauth2/v2/userinfo").pipe(
          HttpClientRequest.setHeaders({ Authorization: `Bearer ${accessToken}` }),
        ),
      ).pipe(
        Effect.flatMap(antigravityAccountFingerprint),
        Effect.catch(() => sha256(`antigravity-cli\0${token.refresh_token || accessToken}`)),
      );
    } else {
      const token = yield* fs.readFileString(tokenPath).pipe(Effect.flatMap(decodeTokenFile));
      projectId = token.project_id;
      const fingerprint = yield* sha256(
        `${token.client_id}\0${token.refresh_token}\0${token.project_id ?? ""}`,
      );
      if (cached?.fingerprint !== fingerprint || cached.expiresAt <= now + 60_000) {
        cached = undefined;
        const refreshed = yield* request(
          HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
            HttpClientRequest.bodyUrlParams({
              client_id: token.client_id,
              client_secret: token.client_secret,
              refresh_token: token.refresh_token,
              grant_type: "refresh_token",
            }),
          ),
        ).pipe(Effect.flatMap(decodeTokenResponse));
        accessToken = refreshed.access_token;
        // Use Google account IDs to merge accounts across environments; refresh tokens differ per machine.
        account = yield* request(
          HttpClientRequest.get("https://www.googleapis.com/oauth2/v2/userinfo").pipe(
            HttpClientRequest.setHeaders({ Authorization: `Bearer ${accessToken}` }),
          ),
        ).pipe(
          Effect.flatMap(antigravityAccountFingerprint),
          Effect.orElseSucceed(() => fingerprint),
        );
        if (generation === startedGeneration) {
          cached = {
            fingerprint,
            account,
            accessToken,
            expiresAt: now + refreshed.expires_in * 1000,
          };
        }
      } else {
        accessToken = cached.accessToken;
        account = cached.account;
      }
    }
    const endpoints = ENDPOINTS[input.authMethod];
    // Merge endpoints because quota groups differ; the metered host's reading of a bucket wins.
    const fetchWindows = Effect.fn("AntigravityUsageProbe.fetchWindows")(function* <E>(
      operation: string,
      parse: (
        response: unknown,
        requestedAt: number,
      ) => Effect.Effect<ServerProviderUsageWindow[], E>,
    ) {
      const responses = yield* Effect.forEach(
        endpoints,
        (endpoint) =>
          Effect.gen(function* () {
            // Capture each request after auth, so refresh latency does not widen the tolerance.
            const requestedAt = yield* Clock.currentTimeMillis;
            return yield* request(
              HttpClientRequest.post(`${endpoint}/v1internal:${operation}`).pipe(
                HttpClientRequest.setHeaders({
                  Authorization: `Bearer ${accessToken}`,
                  "User-Agent": antigravityUserAgent(platform, architecture),
                }),
                HttpClientRequest.bodyJsonUnsafe(projectId ? { project: projectId } : {}),
              ),
            ).pipe(
              Effect.flatMap((response) => parse(response, requestedAt)),
              Effect.orElseSucceed(() => []),
            );
          }),
        { concurrency: "unbounded" },
      );
      const windows = new Map<string, ServerProviderUsageWindow>();
      for (const window of responses.flat()) {
        if (!windows.has(window.id)) windows.set(window.id, window);
      }
      return [...windows.values()];
    });
    const summary = yield* fetchWindows("retrieveUserQuotaSummary", antigravitySummaryWindows);
    const hasGeminiSummary = summary.some((window) => window.id.startsWith("gemini-"));
    // Summary endpoints on some hosts/versions return only 3p-* buckets and omit Gemini.
    const windows =
      summary.length > 0 && hasGeminiSummary
        ? summary
        : yield* fetchWindows("fetchAvailableModels", (response) =>
            decodeModels(response).pipe(
              Effect.map((models) => modelWindows(models, summary.length > 0)),
            ),
          ).pipe(
            Effect.map((fallback) => (summary.length > 0 ? [...summary, ...fallback] : fallback)),
          );
    if (windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity did not return usable quota information.",
      });
    }
    return { ...makeUsageLimits({ checkedAt, windows }), credentialFingerprint: account };
  });
  const probe = read.pipe(
    Effect.provideService(Digest.Digest, crypto),
    Effect.timeout("30 seconds"),
    Effect.catch(() =>
      Effect.gen(function* () {
        return makeUnavailableUsageLimits({
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          reason: "probeFailed",
          message: "Could not read Antigravity limits. Refresh provider status to retry.",
        });
      }),
    ),
  );
  return {
    probe,
    clear: Effect.sync(() => {
      cached = undefined;
      generation++;
    }),
  };
});
