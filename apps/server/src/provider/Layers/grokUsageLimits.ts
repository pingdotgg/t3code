import * as NodeOS from "node:os";
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

const GrokCredentials = Schema.Record(
  Schema.String,
  Schema.Struct({
    key: Schema.optional(Schema.String),
    auth_mode: Schema.optional(Schema.String),
  }),
);
const decodeCredentials = Schema.decodeEffect(Schema.fromJsonString(GrokCredentials));
const GrokUsageResponse = Schema.Struct({
  config: Schema.optional(
    Schema.Struct({
      creditUsagePercent: Schema.optional(Schema.Number),
      currentPeriod: Schema.optional(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          end: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});

export function grokUsageResponseToLimits(
  response: typeof GrokUsageResponse.Type,
  checkedAt: string,
) {
  const usedPercent = response.config?.creditUsagePercent;
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  const period = response.config?.currentPeriod;
  const periodType = period?.type?.replace(/^USAGE_PERIOD_TYPE_/, "");
  const kind = periodType === "WEEKLY" ? "weekly" : periodType === "MONTHLY" ? "monthly" : "other";
  const reset = period?.end ? DateTime.make(period.end) : Option.none();
  const window: ServerProviderUsageWindow = {
    id: "subscription",
    kind,
    label: kind === "weekly" ? "Weekly" : kind === "monthly" ? "Monthly" : "Subscription",
    usedPercent: clampPercent(usedPercent),
    ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
  };
  return makeUsageLimits({ checkedAt, windows: [window] });
}

export const readGrokUsageLimits = Effect.fn("readGrokUsageLimits")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    // T3's ACP adapter explicitly selects API-key auth when this variable is set.
    if (environment.XAI_API_KEY?.trim()) {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    // Alternate auth deployments can select another scope or account from the same file.
    if (
      [
        "GROK_OIDC_ISSUER",
        "GROK_OIDC_CLIENT_ID",
        "GROK_OAUTH2_ISSUER",
        "GROK_OAUTH2_CLIENT_ID",
        "GROK_OAUTH2_PRINCIPAL_TYPE",
        "GROK_OAUTH2_PRINCIPAL_ID",
        "GROK_AUTH_PROVIDER_COMMAND",
        "GROK_LOCAL_AUTH",
        "GROK_CLI_CHAT_PROXY_BASE_URL",
        "GROK_MODELS_BASE_URL",
        "GROK_CONFIG",
        "GROK_CONFIG_PATH",
      ].some((name) => environment[name]?.trim())
    ) {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home =
      environment.GROK_HOME?.trim() ||
      path.join(environment.HOME || environment.USERPROFILE || NodeOS.homedir(), ".grok");
    for (const configPath of [
      path.join(home, "config.toml"),
      path.join(home, "managed_config.toml"),
      path.join(home, "requirements.toml"),
      "/etc/grok/managed_config.toml",
      "/etc/grok/requirements.toml",
    ]) {
      const config = yield* fs.readFileString(configPath).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
        }),
      );
      // These sections can change the selected account or endpoint. Leave custom deployments to the CLI.
      if (/^\s*(?:\[\[?\s*)?["']?(?:auth|grok_com_config|endpoints)["']?\s*[.\]=]/m.test(config)) {
        return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
      }
    }
    const contents =
      environment.GROK_AUTH?.trim() ||
      (yield* fs.readFileString(path.join(home, "auth.json")).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
        }),
      ));
    const credentials = yield* decodeCredentials(contents);
    // Never pick an arbitrary account from other deployments stored in the same file.
    const credential =
      credentials["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"] ??
      credentials["https://accounts.x.ai/sign-in"];
    const token = credential?.auth_mode === "api_key" ? undefined : credential?.key?.trim();
    if (!token) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get("https://cli-chat-proxy.grok.com/v1/billing?format=credits").pipe(
        HttpClientRequest.bearerToken(token),
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(GrokUsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return grokUsageResponseToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.catch(() =>
      Effect.succeed(
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Grok could not read usage limits.",
        }),
      ),
    ),
  );
});
