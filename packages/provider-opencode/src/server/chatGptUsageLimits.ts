import * as NodeSqlite from "node:sqlite";
import { chatGptWorkspaceScope } from "./chatGptWorkspaceScope.ts";
import { OpenCodeCredentialReadError } from "./usageLimits.ts";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const Credential = Schema.Struct({
  type: Schema.Literal("oauth"),
  methodID: Schema.Literals(["chatgpt-browser", "chatgpt-headless", "chatgpt-token-sharing"]),
  access: Schema.NonEmptyString,
  expires: Schema.Finite,
  metadata: Schema.optionalKey(
    Schema.Struct({ accountID: Schema.optionalKey(Schema.NonEmptyString) }),
  ),
});
const decodeStoredValue = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeCredential = Schema.decodeUnknownOption(Credential);
const decodeClaims = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({
      sub: Schema.optionalKey(Schema.NonEmptyString),
      "https://api.openai.com/auth": Schema.optionalKey(
        Schema.Struct({
          user_id: Schema.optionalKey(Schema.NonEmptyString),
          chatgpt_account_id: Schema.optionalKey(Schema.NonEmptyString),
        }),
      ),
    }),
  ),
);

function loginIdentity(auth: typeof Credential.Type, rowId: string) {
  // Claims are only a grouping key, never proof of authentication.
  const payload = Base64Url.decodeString(auth.access.split(".")[1] ?? "");
  const claims = Result.isSuccess(payload)
    ? Option.getOrUndefined(decodeClaims(payload.success))
    : undefined;
  const account = claims?.["https://api.openai.com/auth"];
  const user = account?.user_id ?? claims?.sub;
  const workspace = auth.metadata?.accountID ?? account?.chatgpt_account_id;
  return {
    workspace,
    identity: JSON.stringify([
      "opencode-chatgpt",
      user && workspace ? ["user", user] : ["row", rowId],
      workspace,
    ]),
  };
}
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

// The OpenCode limits endpoint reports Console usage, not the selected ChatGPT subscription.
export const readOpenCodeChatGptUsageLimits = Effect.fn("readOpenCodeChatGptUsageLimits")(
  function* (input: {
    readonly enabled: boolean;
    readonly serverUrl: string;
    readonly databasePath: string | undefined;
  }) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    const failed = () =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode could not read ChatGPT usage.",
      });
    const filename = input.databasePath;
    if (!input.enabled || input.serverUrl.trim() || !filename || filename === ":memory:")
      return unsupported;

    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(filename))) return unsupported;
      const row = yield* Effect.try({
        try: () => {
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
                "SELECT id, value FROM credential WHERE integration_id = 'openai' ORDER BY active DESC, time_created DESC, id DESC LIMIT 1",
              )
              .get();
          } finally {
            db.close();
          }
        },
        catch: (cause) => new OpenCodeCredentialReadError({ databasePath: filename, cause }),
      });
      if (!row) return unsupported;
      const credential = decodeCredential(yield* decodeStoredValue(row.value));
      if (Option.isNone(credential)) return unsupported;
      const auth = credential.value;
      const digest = yield* Digest.Digest;
      const { workspace, identity } = loginIdentity(auth, String(row.id));
      const credentialFingerprint = yield* digest
        .digest(Digest.sha256, new TextEncoder().encode(identity))
        .pipe(Effect.map(Hex.encode), Effect.orDie);
      return yield* Effect.gen(function* () {
        if (auth.expires <= Date.parse(checkedAt))
          return makeUnavailableUsageLimits({
            checkedAt,
            reason: "unsupported",
            message:
              "OpenCode's ChatGPT login has expired. Use OpenCode to refresh it, then refresh Limits.",
          });

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
            id: windows.some((window) => window.id === `chatgpt_${mins}m`)
              ? `chatgpt_${mins}m_${id}`
              : `chatgpt_${mins}m`,
            usageScope: "openai",
            ...(workspace ? { workspaceScope: chatGptWorkspaceScope(workspace) } : {}),
            // Clients predating usageScope must not switch unrelated models to their fallback.
            providerIds: [],
            kind,
            label: `ChatGPT · ${kind === "monthly" ? "Monthly" : kind === "weekly" ? "Weekly" : "Session"}`,
            usedPercent: clampPercent(value.used_percent),
            windowDurationMins: mins,
            ...(value.reset_at > 0 && Option.isSome(reset)
              ? { resetsAt: DateTime.formatIso(reset.value) }
              : {}),
          });
        }
        const weekly = windows.find((window) => window.kind === "weekly");
        return makeUsageLimits({
          checkedAt,
          windows: weekly
            ? windows.map((window) =>
                window.kind === "session" ? { ...window, blockedByWindowId: weekly.id } : window,
              )
            : windows,
        });
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(failed),
        Effect.map((limits) => ({ ...limits, credentialFingerprint })),
      );
    }).pipe(Effect.orElseSucceed(failed));
  },
);
