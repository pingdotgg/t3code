import * as NodeSqlite from "node:sqlite";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
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

const AuthFile = Schema.Struct({ "opencode-go": Schema.optionalKey(Schema.Unknown) });
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

/**
 * Upstream integrations that publish their own quota. OpenCode fronts several
 * providers behind one harness, and each of them meters its own plan, so the
 * quota has to be read from the integration that serves the model rather than
 * from the OpenCode Console budget.
 */
const INTEGRATION_QUOTA_ENDPOINTS: Readonly<
  Record<string, { readonly endpoint: string; readonly label: string }>
> = {
  "minimax-coding-plan": {
    endpoint: "https://api.minimax.io/v1/token_plan/remains",
    label: "MiniMax Token Plan",
  },
  minimax: {
    endpoint: "https://api.minimax.io/v1/token_plan/remains",
    label: "MiniMax",
  },
};

// MiniMax answers with one entry per model and two metered windows.
const MiniMaxQuotaResponse = Schema.Struct({
  base_resp: Schema.optionalKey(
    Schema.Struct({
      status_code: Schema.optionalKey(Schema.Finite),
      status_msg: Schema.optionalKey(Schema.String),
    }),
  ),
  model_remains: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

interface MiniMaxQuotaEntry {
  readonly current_interval_remaining_percent?: number;
  readonly current_interval_status?: number;
  readonly end_time?: number;
  readonly weekly_end_time?: number;
  readonly current_weekly_remaining_percent?: number;
  readonly current_weekly_status?: number;
}

const miniMaxQuotaEntry = Schema.decodeUnknownOption(
  Schema.Struct({
    current_interval_remaining_percent: Schema.optionalKey(Schema.Finite),
    current_interval_status: Schema.optionalKey(Schema.Finite),
    end_time: Schema.optionalKey(Schema.Finite),
    weekly_end_time: Schema.optionalKey(Schema.Finite),
    current_weekly_remaining_percent: Schema.optionalKey(Schema.Finite),
    current_weekly_status: Schema.optionalKey(Schema.Finite),
  }),
);

// Select before decoding so an OAuth or self-hosted connection cannot fall
// through to another stored account. NULL-active rows predate the selection flag.
class OpenCodeCredentialReadError extends Schema.TaggedError<OpenCodeCredentialReadError>()(
  "OpenCodeCredentialReadError",
  { databasePath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read OpenCode credentials from ${this.databasePath}.`;
  }
}

const readStoredApiKey = (databasePath: string, integrationId: "opencode" | "opencode-go") =>
  Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const row = database
          .prepare(
            `SELECT value FROM credential
             WHERE integration_id = ? AND active IS NOT 0
             ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`,
          )
          .get(integrationId);
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
    },
    catch: (cause) => new OpenCodeCredentialReadError({ databasePath, cause }),
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Every integration the local OpenCode store holds a key for, so a quota can be
 * read from the provider that actually serves the model.
 */
const readStoredIntegrationKeys = (databasePath: string) =>
  Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const rows = database
          .prepare(
            `SELECT integration_id, value FROM credential
             WHERE active IS NOT 0 ORDER BY active DESC, time_created DESC, id DESC`,
          )
          .all() as Array<{ readonly integration_id: unknown; readonly value: unknown }>;
        const keys = new Map<string, string>();
        for (const row of rows) {
          const integrationId = typeof row.integration_id === "string" ? row.integration_id : "";
          if (integrationId === "" || keys.has(integrationId)) continue;
          const stored =
            typeof row.value === "string"
              ? Option.getOrUndefined(decodeStoredKey(row.value))
              : undefined;
          const key = stored?.key.trim();
          if (key) keys.set(integrationId, key);
        }
        return keys;
      } finally {
        database.close();
      }
    },
    catch: (cause) => new OpenCodeCredentialReadError({ databasePath, cause }),
  }).pipe(Effect.orElseSucceed(() => new Map<string, string>()));

const miniMaxWindow = (
  integrationId: string,
  label: string,
  id: string,
  kind: "session" | "weekly",
  remainingPercent: number | undefined,
  statusCode: number | undefined,
  resetsAtMs: number | undefined,
): ServerProviderUsageWindow | null => {
  if (remainingPercent === undefined) return null;
  // MiniMax reports 1 normal, 2 exhausted and 3 unlimited.
  if (statusCode === 3) return null;
  const usedPercent = clampPercent(100 - remainingPercent);
  const resetsAt =
    resetsAtMs !== undefined && Number.isFinite(resetsAtMs)
      ? Option.getOrUndefined(DateTime.make(resetsAtMs))
      : undefined;
  return {
    id: `${integrationId}_${id}`,
    kind,
    label: `${label} · ${kind === "session" ? "Interval" : "Weekly"}`,
    usedPercent,
    ...(resetsAt ? { resetsAt: DateTime.formatIso(resetsAt) } : {}),
  };
};

/**
 * Quota for the upstream integrations the user actually runs. OpenCode Go is
 * the Console budget; a custom provider meters its own plan, so its windows
 * come from that provider's API.
 */
export const readOpenCodeIntegrationUsageLimits = Effect.fn("readOpenCodeIntegrationUsageLimits")(
  function* (input: {
    readonly enabled: boolean;
    readonly serverUrl: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!input.enabled || input.serverUrl.trim()) {
      return { checkedAt, windows: [] as readonly ServerProviderUsageWindow[] };
    }

    return yield* Effect.gen(function* () {
      const path = yield* Path.Path;
      const env = input.environment;
      const dataHome =
        env.XDG_DATA_HOME ||
        path.join(
          env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory),
          ".local",
          "share",
        );
      const databaseFile = env.OPENCODE_DB ?? "opencode.db";
      const databasePath = path.resolve(dataHome, "opencode", databaseFile);
      const storedKeys = yield* readStoredIntegrationKeys(databasePath);
      const candidates = Object.entries(INTEGRATION_QUOTA_ENDPOINTS).filter(([integrationId]) =>
        storedKeys.has(integrationId),
      );
      if (candidates.length === 0)
        return { checkedAt, windows: [] as readonly ServerProviderUsageWindow[] };

      const client = yield* HttpClient.HttpClient;
      const windows: ServerProviderUsageWindow[] = [];
      for (const [integrationId, quota] of candidates) {
        const key = storedKeys.get(integrationId);
        if (key === undefined) continue;
        const response = yield* client
          .execute(HttpClientRequest.get(quota.endpoint).pipe(HttpClientRequest.bearerToken(key)))
          .pipe(Effect.timeout("5 seconds"), Effect.option);
        if (Option.isNone(response)) continue;
        const result = response.value;
        if (result.status !== 200) continue;
        const body = yield* HttpClientResponse.schemaBodyJson(MiniMaxQuotaResponse)(result).pipe(
          Effect.option,
        );
        if (Option.isNone(body)) continue;
        const payload = body.value;
        if ((payload.base_resp?.status_code ?? 0) !== 0) continue;
        for (const raw of payload.model_remains ?? []) {
          const entry: MiniMaxQuotaEntry | undefined = Option.getOrUndefined(
            miniMaxQuotaEntry(raw),
          );
          if (entry === undefined) continue;
          const interval = miniMaxWindow(
            integrationId,
            quota.label,
            "interval",
            "session",
            entry.current_interval_remaining_percent,
            entry.current_interval_status,
            entry.end_time,
          );
          const weekly = miniMaxWindow(
            integrationId,
            quota.label,
            "weekly",
            "weekly",
            entry.current_weekly_remaining_percent,
            entry.current_weekly_status,
            entry.weekly_end_time,
          );
          if (interval !== null) windows.push(interval);
          if (weekly !== null) windows.push(weekly);
        }
      }
      return { checkedAt, windows };
    }).pipe(
      Effect.orElseSucceed(() => ({
        checkedAt,
        windows: [] as readonly ServerProviderUsageWindow[],
      })),
    );
  },
);

/**
 * Combine the Console budget with the quotas of the integrations in use.
 *
 * The Console budget can be unavailable while a custom provider still meters
 * a plan, so the unavailable marker is dropped once there are windows to
 * report.
 */
export function mergeUsageLimits(
  console: ServerProviderUsageLimits,
  integrationWindows: readonly ServerProviderUsageWindow[],
): ServerProviderUsageLimits {
  if (integrationWindows.length === 0) return console;
  return {
    checkedAt: console.checkedAt,
    windows: [...console.windows, ...integrationWindows],
  };
}

/** External OpenCode servers own their credentials; never read the host's account for them. */
export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (input: {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled || input.serverUrl.trim()) return unsupported;

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
    const storedKeys =
      env.OPENCODE_AUTH_CONTENT || databaseFile === ":memory:"
        ? []
        : [
            yield* readStoredApiKey(databasePath, "opencode"),
            // OpenCode 2 imports auth.json once, so a replaced Go key only exists here.
            yield* readStoredApiKey(databasePath, "opencode-go"),
          ];
    const keys = [...new Set([...storedKeys, goKey].filter((key): key is string => Boolean(key)))];
    let apiKey = keys[0];
    if (!apiKey) return unsupported;

    const client = yield* HttpClient.HttpClient;
    const readUsage = (key: string) =>
      client.execute(
        HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
          HttpClientRequest.bearerToken(key),
        ),
      );
    let response = yield* readUsage(apiKey);
    for (const key of keys.slice(1)) {
      if (response.status !== 401 && response.status !== 403) break;
      apiKey = key;
      response = yield* readUsage(apiKey);
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
    const digest = yield* Digest.Digest;
    // Unkeyed hashes match across environments; random Go keys resist offline guessing.
    const credentialFingerprint = yield* digest
      .digest(Digest.sha256, new TextEncoder().encode(`opencode-go\0${apiKey}`))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return {
      ...makeUsageLimits({ checkedAt, windows }),
      credentialFingerprint,
    };
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode Go could not read usage.",
      }),
    ),
  );
});
