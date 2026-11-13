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

/**
 * MiniMax issues its token-plan keys with this prefix. A pay-as-you-go key
 * meters no plan, and a key that belongs to another endpoint must never leave
 * the machine, so only a plan key is sent to the quota API.
 */
const MINI_MAX_PLAN_KEY_PREFIX = "sk-cp-";

/** The hosts that serve MiniMax's own API. */
const MINI_MAX_HOSTS = new Set(["api.minimax.io", "api.minimaxi.com"]);

// MiniMax answers with one entry per quota and two metered windows.
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
  readonly model_name?: string;
  readonly current_interval_remaining_percent?: number;
  readonly current_interval_status?: number;
  readonly end_time?: number;
  readonly start_time?: number;
  readonly weekly_end_time?: number;
  readonly weekly_start_time?: number;
  readonly current_weekly_remaining_percent?: number;
  readonly current_weekly_status?: number;
}

const miniMaxQuotaEntry = Schema.decodeUnknownOption(
  Schema.Struct({
    model_name: Schema.optionalKey(Schema.String),
    current_interval_remaining_percent: Schema.optionalKey(Schema.Finite),
    current_interval_status: Schema.optionalKey(Schema.Finite),
    end_time: Schema.optionalKey(Schema.Finite),
    start_time: Schema.optionalKey(Schema.Finite),
    weekly_end_time: Schema.optionalKey(Schema.Finite),
    weekly_start_time: Schema.optionalKey(Schema.Finite),
    current_weekly_remaining_percent: Schema.optionalKey(Schema.Finite),
    current_weekly_status: Schema.optionalKey(Schema.Finite),
  }),
);

/**
 * The bucket that meters the plan every chat model draws from. MiniMax reports
 * one bucket per quota, and the others (a video allowance, for example) meter a
 * quota no model in T3 Code spends.
 */
const MINI_MAX_PLAN_BUCKET = "general";

/**
 * The plan's own bucket. Reporting a second bucket under the same window ids
 * would pool two different quotas into one percentage, so only the bucket that
 * meters the plan is reported.
 */
function miniMaxPlanBucket(entries: readonly MiniMaxQuotaEntry[]): MiniMaxQuotaEntry | undefined {
  const plan = entries.find((entry) => entry.model_name === MINI_MAX_PLAN_BUCKET);
  if (plan) return plan;
  // A payload with a single bucket leaves no room for ambiguity.
  return entries.length === 1 ? entries[0] : undefined;
}

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

interface StoredCredential {
  readonly key: string;
  /** The OpenCode deployment the credential belongs to, when the store names one. */
  readonly server: string | undefined;
}

/**
 * Every active credential in the local OpenCode store, newest first per
 * integration. One read, so every caller sees the same store.
 */
const readStoredCredentials = (databasePath: string) =>
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
        const credentials = new Map<string, StoredCredential>();
        for (const row of rows) {
          const integrationId = typeof row.integration_id === "string" ? row.integration_id : "";
          if (integrationId === "" || credentials.has(integrationId)) continue;
          const stored =
            typeof row.value === "string"
              ? Option.getOrUndefined(decodeStoredKey(row.value))
              : undefined;
          const key = stored?.key.trim();
          if (!key) continue;
          const server = stored?.metadata?.server;
          credentials.set(integrationId, {
            key,
            server: typeof server === "string" ? server : undefined,
          });
        }
        return credentials;
      } finally {
        database.close();
      }
    },
    catch: (cause) => new OpenCodeCredentialReadError({ databasePath, cause }),
  }).pipe(Effect.orElseSucceed(() => new Map<string, StoredCredential>()));

/** A Zen key belongs to the deployment that stored it, so only the Console's own is used. */
function isOfficialConsole(server: string | undefined): boolean {
  if (server === undefined) return true;
  try {
    const url = new URL(server);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}` === "https://opencode.ai/console";
  } catch {
    return false;
  }
}

/** A credential that names another server belongs to that server, not to MiniMax. */
function servesMiniMax(server: string | undefined): boolean {
  if (server === undefined) return true;
  try {
    return MINI_MAX_HOSTS.has(new URL(server).host);
  } catch {
    return false;
  }
}

/** The local OpenCode store: where its data home, auth file and credential database live. */
const openCodeStorePaths = Effect.fn("OpenCodeStore.paths")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const dataHome =
    environment.XDG_DATA_HOME ||
    path.join(
      environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory),
      ".local",
      "share",
    );
  const databaseFile = environment.OPENCODE_DB ?? "opencode.db";
  return {
    dataHome,
    authPath: path.join(dataHome, "opencode", "auth.json"),
    databasePath: path.resolve(dataHome, "opencode", databaseFile),
  };
});

const miniMaxWindow = (
  integrationId: string,
  label: string,
  id: string,
  kind: "session" | "weekly",
  remainingPercent: number | undefined,
  statusCode: number | undefined,
  resetsAtMs: number | undefined,
  startsAtMs: number | undefined,
): ServerProviderUsageWindow | null => {
  if (remainingPercent === undefined) return null;
  // MiniMax reports 1 normal, 2 exhausted and 3 unlimited.
  if (statusCode === 3) return null;
  const usedPercent = clampPercent(100 - remainingPercent);
  const resetsAt =
    resetsAtMs !== undefined && Number.isFinite(resetsAtMs)
      ? Option.getOrUndefined(DateTime.make(resetsAtMs))
      : undefined;
  // The window length is what lets the client judge pace, so take it from the
  // window's own bounds.
  const windowDurationMins =
    startsAtMs !== undefined &&
    resetsAtMs !== undefined &&
    Number.isFinite(startsAtMs) &&
    Number.isFinite(resetsAtMs) &&
    resetsAtMs > startsAtMs
      ? Math.round((resetsAtMs - startsAtMs) / 60_000)
      : undefined;
  return {
    id: `${integrationId}_${id}`,
    kind,
    label: `${label} · ${kind === "session" ? "Interval" : "Weekly"}`,
    usedPercent,
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
    ...(resetsAt ? { resetsAt: DateTime.formatIso(resetsAt) } : {}),
  };
};

export interface OpenCodeUsageLimitsInput {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface OpenCodeIntegrationUsageLimits {
  readonly checkedAt: string;
  readonly windows: readonly ServerProviderUsageWindow[];
  /** The identity of the credentials that meter the reported windows. */
  readonly credentialFingerprint?: string | undefined;
}

/**
 * Quota for the upstream integrations the user actually runs. OpenCode Go is
 * the Console budget; a custom provider meters its own plan, so its windows
 * come from that provider's API.
 */
export const readOpenCodeIntegrationUsageLimits = Effect.fn("readOpenCodeIntegrationUsageLimits")(
  function* (input: OpenCodeUsageLimitsInput) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const empty = {
      checkedAt,
      windows: [] as readonly ServerProviderUsageWindow[],
      credentialFingerprint: undefined as string | undefined,
    };
    if (!input.enabled || input.serverUrl.trim()) return empty;

    return yield* Effect.gen(function* () {
      const env = input.environment;
      const { databasePath } = yield* openCodeStorePaths(env);
      const storedCredentials = yield* readStoredCredentials(databasePath);
      // Only a credential that MiniMax itself issued may reach MiniMax's API.
      const candidates = Object.entries(INTEGRATION_QUOTA_ENDPOINTS).filter(([integrationId]) => {
        const credential = storedCredentials.get(integrationId);
        return (
          credential !== undefined &&
          credential.key.startsWith(MINI_MAX_PLAN_KEY_PREFIX) &&
          servesMiniMax(credential.server)
        );
      });
      if (candidates.length === 0) return empty;

      const digest = yield* Digest.Digest;
      const credentialFingerprint = yield* digest
        .digest(
          Digest.sha256,
          new TextEncoder().encode(
            candidates
              .map(
                ([integrationId]) =>
                  `${integrationId}\0${storedCredentials.get(integrationId)!.key}`,
              )
              .sort()
              .join("\0"),
          ),
        )
        .pipe(Effect.map(Hex.encode), Effect.orDie);

      const client = yield* HttpClient.HttpClient;
      const windows: ServerProviderUsageWindow[] = [];
      for (const [integrationId, quota] of candidates) {
        const credential = storedCredentials.get(integrationId);
        if (credential === undefined) continue;
        const response = yield* client
          .execute(
            HttpClientRequest.get(quota.endpoint).pipe(
              HttpClientRequest.bearerToken(credential.key),
            ),
          )
          .pipe(Effect.timeout("5 seconds"), Effect.option);
        if (Option.isNone(response)) continue;
        const result = response.value;
        if (result.status !== 200) continue;
        // The body read needs its own bound: a server that sends headers and
        // then stalls would hold the refresh permit forever.
        const body = yield* HttpClientResponse.schemaBodyJson(MiniMaxQuotaResponse)(result).pipe(
          Effect.timeout("5 seconds"),
          Effect.option,
        );
        if (Option.isNone(body)) continue;
        const payload = body.value;
        if ((payload.base_resp?.status_code ?? 0) !== 0) continue;
        const entries = (payload.model_remains ?? []).flatMap((raw) => {
          const entry = Option.getOrUndefined(miniMaxQuotaEntry(raw));
          return entry ? [entry] : [];
        });
        const plan = miniMaxPlanBucket(entries);
        if (plan === undefined) continue;
        const interval = miniMaxWindow(
          integrationId,
          quota.label,
          "interval",
          "session",
          plan.current_interval_remaining_percent,
          plan.current_interval_status,
          plan.end_time,
          plan.start_time,
        );
        const weekly = miniMaxWindow(
          integrationId,
          quota.label,
          "weekly",
          "weekly",
          plan.current_weekly_remaining_percent,
          plan.current_weekly_status,
          plan.weekly_end_time,
          plan.weekly_start_time,
        );
        if (interval !== null) windows.push(interval);
        if (weekly !== null) windows.push(weekly);
      }
      return { checkedAt, windows, credentialFingerprint };
    }).pipe(
      Effect.orElseSucceed(() => ({
        checkedAt,
        windows: [] as readonly ServerProviderUsageWindow[],
        credentialFingerprint: undefined as string | undefined,
      })),
    );
  },
);

/**
 * The account identity covers every credential that meters it, so two
 * environments that share a Console key but not an integration key stay
 * separate accounts.
 */
function mergeFingerprints(
  console: string | undefined,
  integration: string | undefined,
): string | undefined {
  if (console === undefined) return integration;
  if (integration === undefined) return console;
  return `${console}.${integration}`;
}

/**
 * Combine the Console budget with the quotas of the integrations in use.
 *
 * The Console budget can be unavailable while a custom provider still meters
 * a plan, so the unavailable marker is dropped once there are windows to
 * report.
 */
export function mergeUsageLimits(
  console: ServerProviderUsageLimits,
  integration: OpenCodeIntegrationUsageLimits,
): ServerProviderUsageLimits {
  // Without a quota of its own the account is what the Console says it is.
  if (integration.windows.length === 0) return console;
  // The integration's quota replaces the unavailable marker, but the Console
  // metadata stays: its fingerprint is what tells one account apart from
  // another when several environments report the same one.
  const { unavailable: _unavailable, ...consoleMetadata } = console;
  const credentialFingerprint = mergeFingerprints(
    consoleMetadata.credentialFingerprint,
    integration.credentialFingerprint,
  );
  return {
    ...consoleMetadata,
    ...(credentialFingerprint === undefined ? {} : { credentialFingerprint }),
    checkedAt: console.checkedAt,
    windows: [...console.windows, ...integration.windows],
  };
}

/** External OpenCode servers own their credentials; never read the host's account for them. */
export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (
  input: OpenCodeUsageLimitsInput,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled || input.serverUrl.trim()) return unsupported;

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const env = input.environment;
    const { authPath, databasePath } = yield* openCodeStorePaths(env);
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
    const storedCredentials =
      env.OPENCODE_AUTH_CONTENT || env.OPENCODE_DB === ":memory:"
        ? new Map<string, StoredCredential>()
        : yield* readStoredCredentials(databasePath);
    const consoleKey = ["opencode", "opencode-go"]
      .map((integrationId) => storedCredentials.get(integrationId))
      .filter(
        (credential): credential is StoredCredential =>
          credential !== undefined && isOfficialConsole(credential.server),
      )
      .map((credential) => credential.key);
    const keys = [...new Set([...consoleKey, goKey].filter((key): key is string => Boolean(key)))];
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
