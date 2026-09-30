import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const AuthFile = Schema.Struct({
  "opencode-go": Schema.optionalKey(Schema.Unknown),
  openrouter: Schema.optionalKey(Schema.Unknown),
});
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);
const UsageWindow = Schema.Struct({
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});
const UsageResponse = Schema.Struct({
  usage: Schema.Struct({ rolling: UsageWindow, weekly: UsageWindow, monthly: UsageWindow }),
});
const OpenRouterKeyResponse = Schema.Struct({
  data: Schema.Struct({
    limit: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
    limit_remaining: Schema.optional(Schema.NullOr(Schema.Finite)),
    limit_reset: Schema.optional(Schema.NullOr(Schema.String)),
    usage: Schema.optional(Schema.NullOr(Schema.Finite)),
    usage_daily: Schema.optional(Schema.NullOr(Schema.Finite)),
    usage_weekly: Schema.optional(Schema.NullOr(Schema.Finite)),
    usage_monthly: Schema.optional(Schema.NullOr(Schema.Finite)),
    include_byok_in_limit: Schema.optional(Schema.Boolean),
    byok_usage: Schema.optional(Schema.NullOr(Schema.Finite)),
    byok_usage_daily: Schema.optional(Schema.NullOr(Schema.Finite)),
    byok_usage_weekly: Schema.optional(Schema.NullOr(Schema.Finite)),
    byok_usage_monthly: Schema.optional(Schema.NullOr(Schema.Finite)),
  }),
});

/** One account's windows, or why it has none. */
type AccountUsage = ReadonlyArray<ServerProviderUsageWindow> | "unsupported" | "failed";

const DAY_MS = 24 * 60 * 60 * 1000;

const readGoUsage = (apiKey: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
        HttpClientRequest.bearerToken(apiKey),
      ),
    );
    // A rejected key or a Zen key without Go must not block other accounts.
    if (response.status === 401 || response.status === 403) return "unsupported" as const;
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
    );
    return [
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
    ] satisfies ReadonlyArray<ServerProviderUsageWindow>;
  });

/**
 * An OpenRouter key's own credit limit. Keys without a limit spend from the
 * account balance, which has no window to draw. OpenRouter documents daily
 * resets at midnight UTC; weekly and monthly resets carry no documented
 * instant, so those bars show no countdown rather than a guessed one.
 */
export function openRouterKeyToWindow(
  response: typeof OpenRouterKeyResponse.Type,
  checkedAt: string,
): ServerProviderUsageWindow | undefined {
  const { data } = response;
  const { limit, limit_remaining: remaining, limit_reset: reset } = data;
  if (limit === null) return undefined;
  // `usage` is lifetime spend; a resetting limit counts only its period's spend.
  const spent =
    reset === "daily"
      ? data.usage_daily
      : reset === "weekly"
        ? data.usage_weekly
        : reset === "monthly"
          ? data.usage_monthly
          : data.usage;
  const byokSpent = !data.include_byok_in_limit
    ? 0
    : reset === "daily"
      ? data.byok_usage_daily
      : reset === "weekly"
        ? data.byok_usage_weekly
        : reset === "monthly"
          ? data.byok_usage_monthly
          : data.byok_usage;
  const left =
    remaining ??
    (limit === 0 ? 0 : spent != null && byokSpent != null ? limit - spent - byokSpent : undefined);
  if (left === undefined) return undefined;
  // Zero is an exhausted budget, not the unlimited (null) sentinel.
  const usedPercent = limit === 0 ? 100 : clampPercent(((limit - left) / limit) * 100);
  if (reset === "daily") {
    const now = Date.parse(checkedAt);
    return {
      id: "openrouter_key_daily",
      kind: "other",
      label: "OpenRouter · Daily",
      usedPercent,
      windowDurationMins: 24 * 60,
      resetsAt: DateTime.formatIso(DateTime.makeUnsafe(Math.floor(now / DAY_MS) * DAY_MS + DAY_MS)),
    };
  }
  return {
    id: "openrouter_key",
    kind: reset === "weekly" ? "weekly" : reset === "monthly" ? "monthly" : "other",
    label:
      reset === "weekly"
        ? "OpenRouter · Weekly"
        : reset === "monthly"
          ? "OpenRouter · Monthly"
          : "OpenRouter · Credit limit",
    usedPercent,
  };
}

const readOpenRouterUsage = (apiKey: string, checkedAt: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get("https://openrouter.ai/api/v1/key").pipe(
        HttpClientRequest.bearerToken(apiKey),
      ),
    );
    // A revoked or mistyped key stays rejected. Treating that as a failed read
    // would freeze every other account's bars behind it indefinitely.
    if (response.status === 401 || response.status === 403) return "unsupported" as const;
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(OpenRouterKeyResponse)),
    );
    const window = openRouterKeyToWindow(body, checkedAt);
    // An incomplete read must retain the last good bars, not clear them.
    return window ? [window] : body.data.limit === null ? "unsupported" : "failed";
  });

/**
 * Limits for the accounts OpenCode has credentials for: an OpenCode Go
 * subscription and an OpenRouter key's credit limit. External OpenCode
 * servers own their credentials; never read the host's account for them.
 */
export const readOpenCodeUsageLimits = Effect.fn("readOpenCodeUsageLimits")(function* (input: {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  const failed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "OpenCode could not read usage.",
  });
  if (!input.enabled || input.serverUrl.trim()) return unsupported;

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = input.environment;
    const dataHome =
      env.XDG_DATA_HOME ||
      path.join(env.HOME || env.USERPROFILE || NodeOS.homedir(), ".local", "share");
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
    // OpenCode overlays stored API credentials after environment credentials.
    const storedKey = (entry: unknown, fallback: string | undefined) => {
      const apiAuth = decodeApiAuth(entry);
      return (Option.isSome(apiAuth) ? apiAuth.value.key : fallback)?.trim();
    };
    const goKey = storedKey(auth["opencode-go"], env.OPENCODE_API_KEY);
    const openRouterKey = storedKey(auth.openrouter, env.OPENROUTER_API_KEY);
    const settle = <E>(read: Effect.Effect<AccountUsage, E, HttpClient.HttpClient>) =>
      read.pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed((): AccountUsage => "failed"),
      );
    const accounts = yield* Effect.all(
      [
        goKey ? settle(readGoUsage(goKey)) : Effect.succeed<AccountUsage>("unsupported"),
        openRouterKey
          ? settle(readOpenRouterUsage(openRouterKey, checkedAt))
          : Effect.succeed<AccountUsage>("unsupported"),
      ],
      { concurrency: "unbounded" },
    );
    // Stable unkeyed hashes allow cross-environment deduplication. These
    // randomly generated API keys are not guessable account passwords.
    const fingerprints = [
      goKey
        ? NodeCrypto.createHash("sha256").update(`opencode-go\0${goKey}`).digest("hex")
        : undefined,
      openRouterKey
        ? NodeCrypto.createHash("sha256").update(`openrouter\0${openRouterKey}`).digest("hex")
        : undefined,
    ];
    const windows = accounts.flatMap((account, index) =>
      typeof account === "string"
        ? []
        : account.map((window) => ({
            ...window,
            credentialFingerprint: fingerprints[index]!,
          })),
    );
    // A successful probe replaces every published window, so one account's
    // failed read must not publish the others alone and erase its bars.
    if (accounts.includes("failed")) return failed;
    if (windows.length === 0) return unsupported;
    // Keep the existing Go-only identity. When both accounts report windows,
    // include both keys so distinct OpenRouter budgets cannot overwrite each other.
    const credentials = [
      typeof accounts[0] !== "string" ? `opencode-go\0${goKey}` : undefined,
      typeof accounts[1] !== "string" ? `openrouter\0${openRouterKey}` : undefined,
    ].filter((credential) => credential !== undefined);
    return {
      ...makeUsageLimits({ checkedAt, windows }),
      credentialFingerprint: NodeCrypto.createHash("sha256")
        .update(credentials.join("\0"))
        .digest("hex"),
    };
  }).pipe(
    // Covers the credential read too: a stuck mount must not hang the status probe.
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => failed),
  );
});
