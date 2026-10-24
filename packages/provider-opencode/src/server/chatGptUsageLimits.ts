import * as NodeSqlite from "node:sqlite";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
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

const Credential = Schema.Struct({
  type: Schema.Literal("oauth"),
  methodID: Schema.Literals(["chatgpt-browser", "chatgpt-token-sharing"]),
  access: Schema.NonEmptyString,
  expires: Schema.Finite,
  metadata: Schema.optionalKey(
    Schema.Struct({ accountID: Schema.optionalKey(Schema.NonEmptyString) }),
  ),
});
const decodeStoredValue = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeCredential = Schema.decodeUnknownOption(Credential);
const Window = Schema.Struct({
  used_percent: Schema.Finite,
  limit_window_seconds: Schema.Int.check(Schema.isGreaterThan(0)),
  reset_at: Schema.Finite,
});
const Usage = Schema.Struct({
  rate_limit: Schema.NullOr(
    Schema.Struct({
      primary_window: Schema.optionalKey(Schema.NullOr(Window)),
      secondary_window: Schema.optionalKey(Schema.NullOr(Window)),
    }),
  ),
});

// OpenCode does not yet expose connection usage through its public API.
export const readOpenCodeChatGptUsageLimits = Effect.fn("readOpenCodeChatGptUsageLimits")(
  function* (input: {
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
      if (env.OPENCODE_DB === ":memory:") return unsupported;
      const filename = path.resolve(dataHome, "opencode", env.OPENCODE_DB || "opencode.db");
      if (!(yield* fs.exists(filename))) return unsupported;
      const row = yield* Effect.try(() => {
        const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
        try {
          db.exec("PRAGMA busy_timeout = 100");
          if (
            !db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'",
              )
              .get()
          )
            return undefined;
          // Select before decoding so an API key cannot fall back to an old OAuth account.
          return db
            .prepare(
              "SELECT id, value FROM credential WHERE integration_id = 'openai' AND active IS NOT 0 ORDER BY active DESC, time_created DESC, id DESC LIMIT 1",
            )
            .get();
        } finally {
          db.close();
        }
      });
      if (!row) return unsupported;
      const credential = decodeCredential(yield* decodeStoredValue(row.value));
      if (Option.isNone(credential)) return unsupported;
      const auth = credential.value;
      const crypto = yield* Crypto.Crypto;
      const credentialFingerprint = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(`opencode-chatgpt\0${auth.metadata?.accountID ?? row.id}`),
        )
        .pipe(Effect.map(Hex.encode), Effect.orDie);
      if (auth.expires <= Date.parse(checkedAt))
        return {
          ...makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message:
              "OpenCode's ChatGPT login has expired. Use OpenCode to refresh it, then refresh Limits.",
          }),
          credentialFingerprint,
        };

      return yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(
          HttpClientRequest.get("https://chatgpt.com/backend-api/wham/usage").pipe(
            HttpClientRequest.bearerToken(auth.access),
            HttpClientRequest.setHeaders({
              "User-Agent": "t3-code",
              ...(auth.metadata?.accountID
                ? { "ChatGPT-Account-Id": auth.metadata.accountID }
                : {}),
            }),
          ),
        );
        // Token-sharing logins may not be entitled to the Codex account API.
        if (response.status === 403) return unsupported;
        const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Usage)),
        );
        const windows: ServerProviderUsageWindow[] = [];
        for (const [id, value] of [
          ["primary", body.rate_limit?.primary_window],
          ["secondary", body.rate_limit?.secondary_window],
        ] as const) {
          if (!value) continue;
          // The OSS plan reports its weekly allowance in the primary position.
          const mins = Math.ceil(value.limit_window_seconds / 60);
          const kind = mins >= 43200 ? "monthly" : mins >= 10080 ? "weekly" : "session";
          const reset = DateTime.make(value.reset_at * 1000);
          windows.push({
            id: `chatgpt_${id}`,
            kind,
            label: `ChatGPT · ${kind === "monthly" ? "Monthly" : kind === "weekly" ? "Weekly" : "Session"}`,
            usedPercent: clampPercent(value.used_percent),
            windowDurationMins: mins,
            ...(value.reset_at > 0 && Option.isSome(reset)
              ? { resetsAt: DateTime.formatIso(reset.value) }
              : {}),
          });
        }
        return makeUsageLimits({ checkedAt, windows });
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() =>
          makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "OpenCode could not read ChatGPT usage.",
          }),
        ),
        Effect.map((limits) => ({ ...limits, credentialFingerprint })),
      );
    }).pipe(
      Effect.orElseSucceed(() =>
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "OpenCode could not read ChatGPT usage.",
        }),
      ),
    );
  },
);
