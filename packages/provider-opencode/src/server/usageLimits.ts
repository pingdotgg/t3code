import * as NodeSqlite from "node:sqlite";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";

const AuthFile = Schema.Struct({
  "opencode-go": Schema.optionalKey(Schema.Unknown),
  openai: Schema.optionalKey(Schema.Unknown),
  "openai-codex": Schema.optionalKey(Schema.Unknown),
});
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);
// OpenCode 2's database tags a stored key "key"; auth.json tags it "api".
const StoredKey = Schema.Struct({
  type: Schema.Literal("key"),
  key: Schema.String,
  metadata: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ server: Schema.optionalKey(Schema.Unknown) })),
  ),
});
const decodeStoredKey = Schema.decodeOption(Schema.fromJsonString(StoredKey));
const UsageWindow = Schema.Struct({
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});
const UsageResponse = Schema.Struct({
  usage: Schema.Struct({ rolling: UsageWindow, weekly: UsageWindow, monthly: UsageWindow }),
});

// Select before decoding so an OAuth or self-hosted connection cannot fall
// through to another stored account. NULL-active rows predate the selection flag.
const readConsoleApiKey = (databasePath: string) =>
  Effect.try(() => {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 100");
      const row = database
        .prepare(
          `SELECT value FROM credential
           WHERE integration_id = 'opencode' AND active IS NOT 0
           ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`,
        )
        .get();
      const stored =
        typeof row?.value === "string"
          ? Option.getOrUndefined(decodeStoredKey(row.value))
          : undefined;
      const server = stored?.metadata?.server;
      if (typeof server === "string") {
        const url = new URL(server);
        if (`${url.origin}${url.pathname.replace(/\/+$/, "")}` !== "https://opencode.ai/console")
          return undefined;
      }
      return stored?.key.trim();
    } finally {
      database.close();
    }
  }).pipe(Effect.orElseSucceed(() => undefined));

// Public client OpenCode uses for ChatGPT sign-in. A refresh has to name the
// client that issued the refresh token. OpenAI rotates that token, so a
// successful refresh is written back to the same store OpenCode reads.
const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

const OAuthCredential = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.optional(Schema.String),
  refresh: Schema.optional(Schema.String),
  expires: Schema.optional(Schema.Number),
  accountId: Schema.optional(Schema.String),
});
const decodeOAuth = Schema.decodeUnknownOption(OAuthCredential);
const decodeOAuthJson = Schema.decodeUnknownOption(Schema.fromJsonString(OAuthCredential));
const decodeJsonRecord = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonRecord = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const EpochOrIso = Schema.Union([Schema.Number, Schema.String]);
const RateWindow = Schema.Struct({
  used_percent: Schema.Number,
  reset_at: Schema.optionalKey(Schema.NullOr(EpochOrIso)),
  limit_window_seconds: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const LegacyWindow = Schema.Struct({
  used_percent: Schema.optionalKey(Schema.Number),
  percent_left: Schema.optionalKey(Schema.Number),
  reset_at: Schema.optionalKey(Schema.NullOr(EpochOrIso)),
  limit_window_seconds: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const ChatGptUsage = Schema.Struct({
  plan_type: Schema.optionalKey(Schema.String),
  rate_limit: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        primary_window: Schema.optionalKey(Schema.NullOr(RateWindow)),
        secondary_window: Schema.optionalKey(Schema.NullOr(RateWindow)),
      }),
    ),
  ),
  five_hour: Schema.optionalKey(Schema.NullOr(LegacyWindow)),
  weekly: Schema.optionalKey(Schema.NullOr(LegacyWindow)),
});
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  id_token: Schema.optionalKey(Schema.String),
});
const JwtClaims = Schema.Struct({
  email: Schema.optionalKey(Schema.String),
  chatgpt_account_id: Schema.optionalKey(Schema.String),
  "https://api.openai.com/auth": Schema.optionalKey(
    Schema.Struct({
      chatgpt_account_id: Schema.optionalKey(Schema.String),
      chatgpt_plan_type: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeClaims = Schema.decodeUnknownOption(JwtClaims);

export interface OpenCodeChatGptIdentity {
  readonly email?: string | undefined;
  readonly plan?: string | undefined;
  readonly workspaceId?: string | undefined;
}

export interface OpenCodeUsageRead {
  readonly limits: ServerProviderUsageLimits;
  readonly identity?: OpenCodeChatGptIdentity | undefined;
}

interface OAuthSession {
  readonly access: string;
  readonly refresh?: string | undefined;
  readonly expires?: number | undefined;
  readonly accountId?: string | undefined;
}

type ChatStore =
  | { readonly type: "memory" }
  | { readonly type: "file"; readonly path: string; readonly key: "openai" | "openai-codex" }
  | { readonly type: "sqlite"; readonly path: string; readonly id: string };

type ChatCredential =
  | { readonly _tag: "oauth"; readonly session: OAuthSession; readonly store: ChatStore }
  | { readonly _tag: "none" };

/** Same plan names Codex shows for a ChatGPT subscription. */
function chatGptPlanLabel(planType: string | null | undefined): string | undefined {
  switch (planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 20x Subscription";
    case "prolite":
      return "ChatGPT Pro 5x Subscription";
    case "promax":
      return "ChatGPT Pro Max Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_prolite":
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "ent26":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
    case "edu_plus":
    case "edu_pro":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return undefined;
  }
}

function claimsFromToken(token: string | undefined) {
  const part = token?.split(".")[1];
  if (!part) return undefined;
  try {
    const claims = decodeClaims(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
    return Option.isSome(claims) ? claims.value : undefined;
  } catch {
    return undefined;
  }
}

function accountIdFromClaims(claims: ReturnType<typeof claimsFromToken>): string | undefined {
  return (
    claims?.chatgpt_account_id?.trim() ||
    claims?.["https://api.openai.com/auth"]?.chatgpt_account_id?.trim() ||
    undefined
  );
}

function sessionFromOAuth(value: unknown): OAuthSession | undefined {
  const decoded = decodeOAuth(value);
  if (Option.isNone(decoded)) return undefined;
  const oauth = decoded.value;
  const access = oauth.access?.trim() ?? "";
  const refresh = oauth.refresh?.trim() || undefined;
  if (!access && !refresh) return undefined;
  const accountId = oauth.accountId?.trim() || undefined;
  return {
    access,
    ...(refresh ? { refresh } : {}),
    ...(oauth.expires !== undefined ? { expires: oauth.expires } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

function withAccountId(session: OAuthSession): OAuthSession {
  if (session.accountId) return session;
  const accountId = accountIdFromClaims(claimsFromToken(session.access));
  return accountId ? { ...session, accountId } : session;
}

function isoFromReset(value: number | string | null | undefined): string | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return undefined;
    const dt = DateTime.make(parsed);
    return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value > 10_000_000_000 ? value : value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function kindForDuration(mins: number): ServerProviderUsageWindow["kind"] {
  if (mins >= MONTH_MINS) return "monthly";
  if (mins >= WEEK_MINS) return "weekly";
  return "session";
}

function labelForKind(kind: ServerProviderUsageWindow["kind"]): string {
  return kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : "Monthly";
}

/**
 * Primary and secondary are slots, matching Codex. Paid plans use the 5-hour
 * and weekly pair; Free and Go use one monthly allowance when duration is absent.
 */
function chatGptWindows(input: {
  readonly planType: string | null | undefined;
  readonly primary?: {
    readonly usedPercent: number;
    readonly resetsAt?: number | string | null | undefined;
    readonly windowDurationMins?: number | null | undefined;
  } | null;
  readonly secondary?: {
    readonly usedPercent: number;
    readonly resetsAt?: number | string | null | undefined;
    readonly windowDurationMins?: number | null | undefined;
  } | null;
}): ReadonlyArray<ServerProviderUsageWindow> {
  const isMonthlyPlan = input.planType === "free" || input.planType === "go";
  const positions = [
    ["primary", input.primary, isMonthlyPlan ? MONTH_MINS : SESSION_MINS],
    ["secondary", input.secondary, WEEK_MINS],
  ] as const;
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, window, fallbackMins] of positions) {
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    const windowDurationMins =
      typeof window.windowDurationMins === "number" ? window.windowDurationMins : fallbackMins;
    const kind = kindForDuration(windowDurationMins);
    const resetsAt = isoFromReset(window.resetsAt);
    windows.push({
      id,
      kind,
      label: labelForKind(kind),
      usedPercent: clampPercent(window.usedPercent),
      windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
}

function durationMins(seconds: number | null | undefined, fallback: number): number {
  return typeof seconds === "number" && Number.isFinite(seconds) ? seconds / 60 : fallback;
}

function usedPercentOf(window: {
  readonly used_percent?: number | undefined;
  readonly percent_left?: number | undefined;
}): number | undefined {
  if (typeof window.used_percent === "number" && Number.isFinite(window.used_percent)) {
    return window.used_percent;
  }
  if (typeof window.percent_left === "number" && Number.isFinite(window.percent_left)) {
    return 100 - window.percent_left;
  }
  return undefined;
}

const readSqliteChatGpt = (databasePath: string) =>
  Effect.try(() => {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 100");
      const row = database
        .prepare(
          `SELECT id, value FROM credential
           WHERE integration_id IN ('openai', 'openai-codex') AND active IS NOT 0
           ORDER BY integration_id = 'openai' DESC, active DESC, time_created DESC, id DESC
           LIMIT 1`,
        )
        .get() as { readonly id?: unknown; readonly value?: unknown } | undefined;
      if (typeof row?.id !== "string" || typeof row.value !== "string") {
        return { _tag: "absent" } as const;
      }
      const decoded = decodeOAuthJson(row.value);
      const session = Option.isSome(decoded) ? sessionFromOAuth(decoded.value) : undefined;
      if (!session) return { _tag: "blocked" } as const;
      return { _tag: "oauth", session, id: row.id } as const;
    } finally {
      database.close();
    }
  }).pipe(Effect.orElseSucceed(() => ({ _tag: "absent" }) as const));

const persistChatGptSession = Effect.fn("persistOpenCodeChatGptSession")(function* (
  store: ChatStore,
  session: OAuthSession,
) {
  const next = {
    type: "oauth" as const,
    access: session.access,
    ...(session.refresh ? { refresh: session.refresh } : {}),
    ...(session.expires !== undefined ? { expires: session.expires } : {}),
    ...(session.accountId ? { accountId: session.accountId } : {}),
  };
  if (store.type === "file") {
    const fs = yield* FileSystem.FileSystem;
    const record = jsonRecord(decodeJsonRecord(yield* fs.readFileString(store.path)));
    if (!record) return;
    record[store.key] = { ...jsonRecord(record[store.key]), ...next };
    yield* fs.writeFileString(store.path, encodeJsonRecord(record));
    return;
  }
  if (store.type !== "sqlite") return;
  yield* Effect.try(() => {
    const database = new NodeSqlite.DatabaseSync(store.path);
    try {
      database.exec("PRAGMA busy_timeout = 100");
      const row = database.prepare("SELECT value FROM credential WHERE id = ?").get(store.id) as
        | { readonly value?: unknown }
        | undefined;
      const previous = jsonRecord(
        typeof row?.value === "string" ? decodeJsonRecord(row.value) : {},
      );
      database
        .prepare("UPDATE credential SET value = ? WHERE id = ?")
        .run(encodeJsonRecord({ ...previous, ...next }), store.id);
    } finally {
      database.close();
    }
  });
});

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const chatGptIdentity = (
  session: OAuthSession,
  planType: string | undefined,
): OpenCodeChatGptIdentity | undefined => {
  const claims = claimsFromToken(session.access);
  const email = claims?.email?.trim();
  const plan = chatGptPlanLabel(
    planType ?? claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type,
  );
  const workspaceId = session.accountId || accountIdFromClaims(claims);
  const identity: OpenCodeChatGptIdentity = {
    ...(email && /^[^\s@]+@[^\s@]+$/.test(email) ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
  return identity.email || identity.plan || identity.workspaceId ? identity : undefined;
};

const credentialFromAuth = (
  auth: typeof AuthFile.Type,
  storeFor: (key: "openai" | "openai-codex") => ChatStore,
): ChatCredential => {
  for (const key of ["openai", "openai-codex"] as const) {
    if (auth[key] === undefined) continue;
    const session = sessionFromOAuth(auth[key]);
    if (!session) return { _tag: "none" };
    return { _tag: "oauth", session, store: storeFor(key) };
  }
  return { _tag: "none" };
};

/** External OpenCode servers own their credentials; never read the host's account for them. */
export const readOpenCodeUsageLimits = Effect.fn("readOpenCodeUsageLimits")(function* (input: {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled || input.serverUrl.trim()) return { limits: unsupported };

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = input.environment;
    const dataHome =
      env.XDG_DATA_HOME ||
      path.join(
        env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory),
        ".local",
        "share",
      );
    const authPath = path.join(dataHome, "opencode", "auth.json");
    const contents =
      env.OPENCODE_AUTH_CONTENT ||
      (yield* fs.readFileString(authPath).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
        }),
      ));
    const auth = yield* decodeAuthFile(contents);
    const apiAuth = decodeApiAuth(auth["opencode-go"]);
    // OpenCode overlays stored API credentials after environment credentials.
    const goKey = (Option.isSome(apiAuth) ? apiAuth.value.key : env.OPENCODE_API_KEY)?.trim();
    // Console supplies Go credentials in OpenCode 2. Inline auth explicitly
    // overrides local credentials, including the Console connection.
    const databaseFile = env.OPENCODE_DB ?? "opencode.db";
    const databasePath = path.resolve(dataHome, "opencode", databaseFile);
    const inline = Boolean(env.OPENCODE_AUTH_CONTENT);
    const consoleKey =
      inline || databaseFile === ":memory:" ? undefined : yield* readConsoleApiKey(databasePath);
    const apiKey = consoleKey || goKey;
    const storedChat =
      inline || databaseFile === ":memory:"
        ? ({ _tag: "absent" } as const)
        : yield* readSqliteChatGpt(databasePath);
    const chatCredential: ChatCredential =
      storedChat._tag === "oauth"
        ? {
            _tag: "oauth",
            session: storedChat.session,
            store: { type: "sqlite", path: databasePath, id: storedChat.id },
          }
        : storedChat._tag === "blocked"
          ? { _tag: "none" }
          : credentialFromAuth(auth, (key) =>
              inline ? { type: "memory" } : { type: "file", path: authPath, key },
            );

    const client = yield* HttpClient.HttpClient;
    const goLimits = !apiKey
      ? undefined
      : yield* Effect.gen(function* () {
          const readUsage = (key: string) =>
            client.execute(
              HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
                HttpClientRequest.bearerToken(key),
              ),
            );
          let key = apiKey;
          let response = yield* readUsage(key);
          if ((response.status === 401 || response.status === 403) && goKey && goKey !== key) {
            key = goKey;
            response = yield* readUsage(key);
          }
          // A valid Zen key can exist without a Go subscription.
          if (response.status === 403) return unsupported;
          const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
          );
          const windows: ServerProviderUsageWindow[] = [
            {
              id: "go_rolling",
              kind: "session",
              label: "Go · Session",
              windowDurationMins: 5 * 60,
              usedPercent: clampPercent(body.usage.rolling.percent),
              resetsAt: DateTime.formatIso(body.usage.rolling.resetsAt),
            },
            {
              id: "go_weekly",
              kind: "weekly",
              label: "Go · Weekly",
              windowDurationMins: 7 * 24 * 60,
              usedPercent: clampPercent(body.usage.weekly.percent),
              resetsAt: DateTime.formatIso(body.usage.weekly.resetsAt),
            },
            {
              id: "go_monthly",
              kind: "monthly",
              label: "Go · Monthly",
              usedPercent: clampPercent(body.usage.monthly.percent),
              resetsAt: DateTime.formatIso(body.usage.monthly.resetsAt),
            },
          ];
          const crypto = yield* Crypto.Crypto;
          // An unkeyed hash matches across environments without a shared secret. It
          // permits offline guesses, but Go keys are randomly generated.
          const credentialFingerprint = yield* crypto
            .digest("SHA-256", new TextEncoder().encode(`opencode-go\0${key}`))
            .pipe(Effect.map(Hex.encode), Effect.orDie);
          return { ...makeUsageLimits({ checkedAt, windows }), credentialFingerprint };
        }).pipe(
          Effect.orElseSucceed(() =>
            makeUnavailableUsageLimits({
              checkedAt,
              reason: "probeFailed",
              message: "OpenCode Go could not read usage.",
            }),
          ),
        );

    const chatRead =
      chatCredential._tag === "none"
        ? undefined
        : yield* Effect.gen(function* () {
            const failed = (message: string): OpenCodeUsageRead => ({
              limits: makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message }),
            });
            let session = withAccountId(chatCredential.session);
            const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
            const stale =
              !session.access ||
              (session.expires !== undefined && session.expires <= nowMs + 60_000);
            const refresh = Effect.gen(function* () {
              if (!session.refresh) return undefined;
              const response = yield* client.execute(
                HttpClientRequest.post(CHATGPT_TOKEN_URL).pipe(
                  HttpClientRequest.bodyUrlParams({
                    grant_type: "refresh_token",
                    refresh_token: session.refresh,
                    client_id: CHATGPT_OAUTH_CLIENT_ID,
                  }),
                ),
              );
              if (response.status < 200 || response.status >= 300) return undefined;
              const body = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response);
              const access = body.access_token.trim();
              if (!access) return undefined;
              const refreshedAt = DateTime.toEpochMillis(yield* DateTime.now);
              const accountId =
                accountIdFromClaims(claimsFromToken(body.id_token)) ||
                accountIdFromClaims(claimsFromToken(access)) ||
                session.accountId;
              const next: OAuthSession = {
                access,
                refresh: body.refresh_token?.trim() || session.refresh,
                expires: refreshedAt + (body.expires_in ?? 3600) * 1000,
                ...(accountId ? { accountId } : {}),
              };
              // Persist before using it. A rotated refresh token left only in
              // memory would sign OpenCode out of ChatGPT on its next refresh.
              yield* persistChatGptSession(chatCredential.store, next).pipe(Effect.ignore);
              return next;
            });
            if (stale) {
              const refreshed = yield* refresh.pipe(Effect.orElseSucceed(() => undefined));
              if (!refreshed) {
                return failed("OpenCode could not refresh the ChatGPT session.");
              }
              session = withAccountId(refreshed);
            }
            const usageRequest = (current: OAuthSession) => {
              const request = HttpClientRequest.get(CHATGPT_USAGE_URL).pipe(
                HttpClientRequest.bearerToken(current.access),
              );
              return current.accountId
                ? request.pipe(HttpClientRequest.setHeader("ChatGPT-Account-Id", current.accountId))
                : request;
            };
            let response = yield* client.execute(usageRequest(session));
            if (response.status === 401 && session.refresh) {
              const refreshed = yield* refresh.pipe(Effect.orElseSucceed(() => undefined));
              if (!refreshed) {
                return failed("OpenCode could not refresh the ChatGPT session.");
              }
              session = withAccountId(refreshed);
              response = yield* client.execute(usageRequest(session));
            }
            if (response.status === 401 || response.status === 403) {
              return failed("OpenCode's ChatGPT session was rejected.");
            }
            const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(ChatGptUsage)),
            );
            const planType = body.plan_type;
            const isMonthlyPlan = planType === "free" || planType === "go";
            const primary = body.rate_limit?.primary_window
              ? {
                  usedPercent: body.rate_limit.primary_window.used_percent,
                  resetsAt: body.rate_limit.primary_window.reset_at,
                  windowDurationMins: durationMins(
                    body.rate_limit.primary_window.limit_window_seconds,
                    isMonthlyPlan ? MONTH_MINS : SESSION_MINS,
                  ),
                }
              : body.five_hour
                ? {
                    usedPercent: usedPercentOf(body.five_hour) ?? Number.NaN,
                    resetsAt: body.five_hour.reset_at,
                    windowDurationMins: durationMins(
                      body.five_hour.limit_window_seconds,
                      isMonthlyPlan ? MONTH_MINS : SESSION_MINS,
                    ),
                  }
                : null;
            const secondary = body.rate_limit?.secondary_window
              ? {
                  usedPercent: body.rate_limit.secondary_window.used_percent,
                  resetsAt: body.rate_limit.secondary_window.reset_at,
                  windowDurationMins: durationMins(
                    body.rate_limit.secondary_window.limit_window_seconds,
                    WEEK_MINS,
                  ),
                }
              : body.weekly
                ? {
                    usedPercent: usedPercentOf(body.weekly) ?? Number.NaN,
                    resetsAt: body.weekly.reset_at,
                    windowDurationMins: durationMins(body.weekly.limit_window_seconds, WEEK_MINS),
                  }
                : null;
            const windows = chatGptWindows({ planType, primary, secondary });
            if (windows.length === 0) {
              return failed("OpenCode could not read ChatGPT usage.");
            }
            const crypto = yield* Crypto.Crypto;
            const credentialFingerprint = session.accountId
              ? yield* crypto
                  .digest(
                    "SHA-256",
                    new TextEncoder().encode(`opencode-chatgpt\0${session.accountId}`),
                  )
                  .pipe(Effect.map(Hex.encode), Effect.orDie)
              : undefined;
            return {
              limits: {
                ...makeUsageLimits({ checkedAt, windows }),
                ...(credentialFingerprint ? { credentialFingerprint } : {}),
              },
              identity: chatGptIdentity(session, planType),
            };
          }).pipe(
            Effect.orElseSucceed((): OpenCodeUsageRead => ({
              limits: makeUnavailableUsageLimits({
                checkedAt,
                reason: "probeFailed",
                message: "OpenCode could not read ChatGPT usage.",
              }),
            })),
          );

    const goReady = goLimits && !goLimits.unavailable ? goLimits : undefined;
    const chatReady = chatRead && !chatRead.limits.unavailable ? chatRead.limits : undefined;
    if (goReady && chatReady) {
      return {
        limits: {
          ...makeUsageLimits({
            checkedAt,
            windows: [...goReady.windows, ...chatReady.windows],
          }),
          ...(goReady.credentialFingerprint
            ? { credentialFingerprint: goReady.credentialFingerprint }
            : {}),
        },
        ...(chatRead?.identity ? { identity: chatRead.identity } : {}),
      };
    }
    if (chatReady)
      return { limits: chatReady, ...(chatRead?.identity ? { identity: chatRead.identity } : {}) };
    if (goReady) return { limits: goReady };
    if (chatRead?.limits.unavailable?.reason === "probeFailed") return { limits: chatRead.limits };
    if (goLimits?.unavailable?.reason === "probeFailed") return { limits: goLimits };
    return { limits: unsupported };
  }).pipe(
    Effect.timeout("8 seconds"),
    Effect.orElseSucceed(() => ({
      limits: makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode could not read usage.",
      }),
    })),
  );
});
