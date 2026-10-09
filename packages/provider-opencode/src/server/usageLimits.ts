import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const AuthFile = Schema.Struct({ "opencode-go": Schema.optionalKey(Schema.Unknown) });
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
// A blank key is no key, so it must not mask the OPENCODE_API_KEY fallback.
const hasKey = Option.filter((auth: { readonly key: string }) => auth.key.trim() !== "");
const decodeUnknownApiAuth = Schema.decodeUnknownOption(ApiAuth);
const decodeApiAuth = (input: unknown) => hasKey(decodeUnknownApiAuth(input));
// OpenCode 2's database tags a stored key "key"; auth.json tags it "api".
const StoredKey = Schema.Struct({ type: Schema.Literal("key"), key: Schema.String });
const decodeStoredKey = Schema.decodeOption(Schema.fromJsonString(StoredKey));
const UsageWindow = Schema.Struct({
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});
const UsageResponse = Schema.Struct({
  usage: Schema.Struct({ rolling: UsageWindow, weekly: UsageWindow, monthly: UsageWindow }),
});

/**
 * OpenCode 2 stores credentials in its SQLite database instead of auth.json. A
 * Console login is a separate OAuth row under another integration, so only a
 * Go API key row is usable here. Rows with a NULL `active` predate the flag and
 * stay eligible, behind any explicitly active row.
 */
const readStoredGoApiKey = (databasePath: string) =>
  Effect.try(() => {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 100");
      const row = database
        .prepare(
          "SELECT value FROM credential WHERE integration_id = 'opencode-go' AND active IS NOT 0 ORDER BY active IS NOT NULL DESC, time_updated DESC LIMIT 1",
        )
        .get();
      return typeof row?.value === "string" ? hasKey(decodeStoredKey(row.value)) : Option.none();
    } finally {
      database.close();
    }
  }).pipe(Effect.orElseSucceed(() => Option.none<{ readonly key: string }>()));

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
      path.join(env.HOME || env.USERPROFILE || NodeOS.homedir(), ".local", "share");
    // OpenCode 2 writes only to its database, so an auth.json key that
    // disagrees with it is a stale OpenCode 1 leftover. Inline auth content
    // is an explicit override and bypasses the database.
    const storedAuth = env.OPENCODE_AUTH_CONTENT
      ? Option.none<{ readonly key: string }>()
      : yield* readStoredGoApiKey(path.join(dataHome, "opencode", "opencode.db"));
    const apiAuth: Option.Option<{ readonly key: string }> = Option.isSome(storedAuth)
      ? storedAuth
      : yield* Effect.gen(function* () {
          const contents =
            env.OPENCODE_AUTH_CONTENT ||
            (yield* fs.readFileString(path.join(dataHome, "opencode", "auth.json")).pipe(
              Effect.catchTags({
                PlatformError: (error) =>
                  error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
              }),
            ));
          const auth = yield* decodeAuthFile(contents);
          return decodeApiAuth(auth["opencode-go"]);
        });
    // OpenCode overlays stored API credentials after environment credentials.
    const apiKey = (Option.isSome(apiAuth) ? apiAuth.value.key : env.OPENCODE_API_KEY)?.trim();
    if (!apiKey) return unsupported;

    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
        HttpClientRequest.bearerToken(apiKey),
      ),
    );
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
    // Go's usage response has no account ID. An unkeyed hash matches across
    // environments without a shared secret. It permits offline guesses, but
    // Go keys are randomly generated.
    const credentialFingerprint = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(`opencode-go\0${apiKey}`))
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
