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
    email: Schema.optional(Schema.String),
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
    // A billing read that succeeded but carries no percentage is an account
    // with nothing metered yet, not one that can never report: xAI omits the
    // field entirely (rather than sending 0) until usage registers, then fills
    // it in. Calling that `unsupported` would strand the account — the Limits
    // view drops unsupported entries and deliberately mutes their notice, so a
    // freshly signed-in Grok account would vanish with no explanation until it
    // happened to be used, and `applyUsageLimitsUpdate` would refuse the
    // mid-turn windows that could have recovered it.
    return makeUsageLimits({ checkedAt, windows: [] });
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

/**
 * The grok.com login the CLI uses by default, or undefined when the CLI is
 * configured to pick another account, endpoint, or an API key.
 */
const readGrokCredential = Effect.fn("readGrokCredential")(function* (
  environment: NodeJS.ProcessEnv,
) {
  // T3's ACP adapter explicitly selects API-key auth when this variable is set.
  if (environment.XAI_API_KEY?.trim()) return undefined;
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
    return undefined;
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
      return undefined;
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
  return credential?.auth_mode === "api_key" ? undefined : credential;
});

/**
 * Reads the default grok.com login once and reports its usage limits along with
 * its email, so the email always names the account whose quota was read.
 */
export const readGrokAccount = Effect.fn("readGrokAccount")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Grok could not read usage limits.",
  });
  const credential = yield* Effect.option(
    readGrokCredential(environment).pipe(Effect.timeout("10 seconds")),
  );
  if (Option.isNone(credential)) return { email: undefined, usageLimits: probeFailed };
  const email = credential.value?.email?.trim() || undefined;
  const token = credential.value?.key?.trim();
  if (!token) {
    return { email, usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }) };
  }
  // A failed quota request still knows which account it asked about.
  const usageLimits = yield* Effect.gen(function* () {
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
    Effect.orElseSucceed(() => probeFailed),
  );
  return { email, usageLimits };
});
