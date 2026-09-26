import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import type * as CodexClient from "effect-codex-app-server/client";

const isEmptyProviderConfig = Schema.is(Schema.Record(Schema.String, Schema.Never));

/**
 * Check the model endpoint, not the local app-server. Custom routes and proxies
 * need their own readiness contract; reaching a proxy does not establish that
 * its upstream connection recovered.
 */
export const checkCodexConnection = Effect.fn("checkCodexConnection")(
  function* (
    client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
    options: {
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
      readonly launchArgs?: string;
    },
  ) {
    if (
      options.launchArgs?.trim() ||
      Object.entries(options.environment).some(
        ([key, value]) =>
          value && /^(?:https?_proxy|all_proxy|openai_base_url|chatgpt_base_url)$/i.test(key),
      )
    ) {
      return undefined;
    }
    const { config } = yield* client.request("config/read", {
      cwd: options.cwd,
      includeLayers: false,
    });
    if (
      (config.model_provider != null && config.model_provider !== "openai") ||
      (config.model_providers != null && !isEmptyProviderConfig(config.model_providers)) ||
      (config.chatgpt_base_url != null &&
        (typeof config.chatgpt_base_url !== "string" ||
          config.chatgpt_base_url.replace(/\/+$/, "") !== "https://chatgpt.com/backend-api")) ||
      config.openai_base_url != null ||
      config.profile != null
    ) {
      return undefined;
    }
    const { account } = yield* client.request("account/read", { refreshToken: false });
    const endpoint =
      account?.type === "chatgpt"
        ? "https://chatgpt.com/backend-api/codex/responses"
        : account?.type === "apiKey"
          ? "https://api.openai.com/v1/responses"
          : undefined;
    if (!endpoint) return undefined;

    const http = yield* HttpClient.HttpClient;
    return yield* http.head(endpoint).pipe(
      Effect.map(
        (response) =>
          response.status >= 200 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429 &&
          !(response.status >= 300 && response.status < 400),
      ),
      Effect.catch(() => Effect.succeed(false)),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    );
  },
  Effect.timeout("5 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.succeed(false)),
);
