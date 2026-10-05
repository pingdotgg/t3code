import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Option from "effect/Option";
import type { LanguageModel } from "effect/ai/LanguageModel";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import { defaultProviderMode } from "../ProviderMode.ts";
import { scopeIdentity, usesInjectedCredentials } from "./CredentialScope.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { AIGateway } from "./AIGateway.ts";
import {
  backendEnvKey,
  backendSecret,
  backendString,
  bindBackendEnvironment,
} from "./BackendConnection.ts";
import { Credential, validateCredential } from "./Credential.ts";
import { FunctionEnvironment } from "./FunctionEnvironment.ts";
import {
  makeLanguageModelLayer,
  type LanguageModelOptions,
} from "./LanguageModel.ts";

export interface QueryAIGatewayClient {
  /** Bare gateway root for SDKs that handle their own routing. */
  baseUrl: Effect.Effect<string, never, RuntimeContext>;
  /** OpenAI Chat Completions base URL, ending in /v1. */
  chatBaseUrl: Effect.Effect<string, never, RuntimeContext>;
  /** OpenAI Responses base URL, ending in /openai/v1. */
  responsesBaseUrl: Effect.Effect<string, never, RuntimeContext>;
  /** Native Anthropic SDK base URL, ending in /anthropic (without /v1). */
  anthropicBaseUrl: Effect.Effect<string, never, RuntimeContext>;
  /** Redacted branch-service bearer credential with ai_gateway:invoke access. */
  token: Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;
  /** Effect AI using Chat Completions, with no inference during deployment. */
  model(
    options: LanguageModelOptions,
  ): Layer.Layer<LanguageModel, never, RuntimeContext>;
}

/**
 * Obtain an Effect AI LanguageModel or SDK-compatible endpoint and credential
 * effects; no model calls happen during deployment. QueryAIGatewayHttp uses
 * the same-branch Function's injected grant, otherwise a tracked branch credential.
 * An explicit credential overrides injection. The injected grant remains available
 * to the whole Function process; a binding is not a permission sandbox.
 *
 * ### Configure a model client
 * **Example:** OpenAI-compatible chat configuration
 * ```typescript
 * const ai = yield* Neon.QueryAIGateway(gateway);
 * // Inside the request handler:
 * const baseURL = yield* ai.chatBaseUrl;
 * const apiKey = yield* ai.token;
 * ```
 *
 * ### Use Effect AI
 * **Example:** Generate text in a request handler
 * ```typescript
 * const ai = yield* Neon.QueryAIGateway(gateway);
 * const model = ai.model({ model: "gpt-5-mini" });
 * // Inside a Function or Worker handler:
 * const reply = yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
 *   Effect.provide(model),
 * );
 * ```
 *
 * `model` uses Chat Completions, including for Claude models. For Responses-only
 * models or native Anthropic features, use `responsesBaseUrl` or
 * `anthropicBaseUrl` with the corresponding SDK and the redacted `token`.
 *
 * @binding
 * @product AI Gateway
 * @category AI Gateway
 */
export interface QueryAIGateway extends Binding.Service<
  QueryAIGateway,
  "Neon.QueryAIGateway",
  (gateway: AIGateway) => Effect.Effect<QueryAIGatewayClient>
> {}
export const QueryAIGateway = Binding.Service<QueryAIGateway>(
  "Neon.QueryAIGateway",
);

const client = (
  baseUrl: QueryAIGatewayClient["baseUrl"],
  token: QueryAIGatewayClient["token"],
): QueryAIGatewayClient => {
  const chatBaseUrl = baseUrl.pipe(
    Effect.map((base) => `${base.replace(/\/$/, "")}/v1`),
  );
  return {
    baseUrl,
    token,
    chatBaseUrl,
    responsesBaseUrl: baseUrl.pipe(
      Effect.map((base) => `${base.replace(/\/$/, "")}/openai/v1`),
    ),
    anthropicBaseUrl: baseUrl.pipe(
      Effect.map((base) => `${base.replace(/\/$/, "")}/anthropic`),
    ),
    model: (options) =>
      makeLanguageModelLayer({
        ...options,
        client: { chatBaseUrl, token },
      }),
  };
};

/** HTTP client with injected same-branch or managed scoped credentials. */
export const QueryAIGatewayHttp = Layer.effect(
  QueryAIGateway,
  Effect.gen(function* () {
    const environment = yield* Effect.serviceOption(FunctionEnvironment);
    const createCredential = yield* Credential;
    return Effect.fn(function* (gateway: AIGateway) {
      const urlKey = backendEnvKey(gateway.FQN, "AI_GATEWAY_URL");
      const tokenKey = backendEnvKey(gateway.FQN, "AI_GATEWAY_TOKEN");
      const injectedKey = backendEnvKey(gateway.FQN, "AI_GATEWAY_INJECTED");
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (!host)
          return yield* Effect.die(
            new Error("QueryAIGatewayHttp requires a Function or Worker host"),
          );
        const mode = host.Mode ?? (yield* defaultProviderMode);
        const injected =
          !gateway.credential &&
          usesInjectedCredentials(host, gateway.Props, mode);
        const env: Record<
          string,
          Output.Output<string | Redacted.Redacted<string>>
        > = {
          [urlKey]: gateway.baseUrl,
          [injectedKey]: Output.literal(injected ? "yes" : "no"),
        };
        if (!injected) {
          const scopeId = scopeIdentity(gateway.Props) ?? gateway.FQN;
          const credentialId = yield* Effect.sync(() =>
            createHash("sha256")
              .update(`${host.FQN}:${scopeId}:ai_gateway:invoke`)
              .digest("hex")
              .slice(0, 24),
          );
          const credential =
            gateway.credential ??
            (yield* createCredential(`AIGateway${credentialId}`, {
              ...(gateway.Props.branch !== undefined
                ? { branch: gateway.Props.branch }
                : { project: gateway.Props.project }),
              scopes: ["ai_gateway:invoke"],
            }));
          env[tokenKey] = Output.all(
            credential.projectId,
            credential.branchId,
            credential.scopes,
            gateway.projectId,
            gateway.branchId,
            credential.apiToken,
          ).pipe(
            Output.mapEffect(
              ([
                projectId,
                branchId,
                scopes,
                targetProjectId,
                targetBranchId,
                token,
              ]) =>
                validateCredential(
                  { projectId, branchId, scopes },
                  { projectId: targetProjectId, branchId: targetBranchId },
                  "ai_gateway:invoke",
                ).pipe(Effect.as(token), Effect.orDie),
            ),
          );
        }
        yield* bindBackendEnvironment(
          `Neon.QueryAIGateway:${gateway.FQN}`,
          env,
        );
      }
      const baseUrl = backendString(urlKey);
      const token = Effect.gen(function* () {
        if ((yield* backendString(injectedKey)) !== "yes")
          return yield* backendSecret(tokenKey);
        const expected = (yield* baseUrl).replace(/\/$/, "");
        const env = Option.getOrUndefined(environment);
        if (env?.NEON_AI_GATEWAY_BASE_URL?.replace(/\/$/, "") !== expected)
          return yield* Effect.die(
            new Error("AI Gateway injection does not match the target branch"),
          );
        if (!env.NEON_AI_GATEWAY_TOKEN)
          return yield* Effect.die(
            new Error("Neon did not inject an AI Gateway credential"),
          );
        return Redacted.make(env.NEON_AI_GATEWAY_TOKEN);
      });
      return client(baseUrl, token);
    });
  }),
);
