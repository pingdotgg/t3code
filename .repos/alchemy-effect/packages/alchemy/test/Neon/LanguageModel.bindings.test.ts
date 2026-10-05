import type { AIGateway } from "@/Neon/AIGateway.ts";
import { backendEnvKey } from "@/Neon/BackendConnection.ts";
import { QueryAIGateway, QueryAIGatewayHttp } from "@/Neon/QueryAIGateway.ts";
import { FunctionEnvironment } from "@/Neon/FunctionEnvironment.ts";
import * as Output from "@/Output.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { expect, test } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

const gateway: AIGateway = {
  FQN: "Gateway",
  LogicalId: "Gateway",
  Props: { branch: { projectId: "project", branchId: "branch" } },
  projectId: Output.literal("project"),
  branchId: Output.literal("branch"),
  baseUrl: Output.literal("https://branch.invalid"),
  credential: undefined,
};

const runtimeMode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const previous = yield* Effect.sync(() => {
      const previous = globalThis.__ALCHEMY_RUNTIME__;
      globalThis.__ALCHEMY_RUNTIME__ = true;
      return previous;
    });
    return yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          globalThis.__ALCHEMY_RUNTIME__ = previous;
        }),
      ),
    );
  });

const services = (injected: boolean, environment?: Record<string, string>) =>
  QueryAIGatewayHttp.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        RuntimeContext.phantom,
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            [backendEnvKey(gateway.FQN, "AI_GATEWAY_URL")]:
              "https://branch.invalid",
            [backendEnvKey(gateway.FQN, "AI_GATEWAY_TOKEN")]:
              "managed-scoped-token",
            [backendEnvKey(gateway.FQN, "AI_GATEWAY_INJECTED")]: injected
              ? "yes"
              : "no",
          }),
        ),
        environment
          ? Layer.succeed(FunctionEnvironment, environment)
          : Layer.empty,
      ),
    ),
  );

for (const mode of ["injected", "managed", "managed-with-injection"] as const) {
  test.effect(
    `HTTP AI client uses ${mode} credentials without account keys`,
    () =>
      runtimeMode(
        Effect.gen(function* () {
          const client = yield* QueryAIGateway(gateway);
          expect(Layer.isLayer(client.model({ model: "gpt-5-mini" }))).toBe(
            true,
          );
          expect(yield* client.chatBaseUrl).toBe("https://branch.invalid/v1");
          expect(yield* client.responsesBaseUrl).toBe(
            "https://branch.invalid/openai/v1",
          );
          expect(yield* client.anthropicBaseUrl).toBe(
            "https://branch.invalid/anthropic",
          );
          const token = yield* client.token;
          expect(Redacted.isRedacted(token)).toBe(true);
          expect(Redacted.value(token)).toBe(
            mode === "injected"
              ? "injected-scoped-token"
              : "managed-scoped-token",
          );
          expect(JSON.stringify(token)).not.toContain("scoped-token");
        }).pipe(
          Effect.provide(
            services(
              mode === "injected",
              mode === "managed"
                ? undefined
                : {
                    NEON_AI_GATEWAY_BASE_URL: "https://branch.invalid/",
                    NEON_AI_GATEWAY_TOKEN: "injected-scoped-token",
                    NEON_API_KEY: "DO_NOT_BIND_ACCOUNT_KEY",
                  },
            ),
          ),
        ),
      ),
    {
      tags: [
        "unit",
        "provider:neon",
        "provider:neon:aigateway",
        "provider:neon:backendconnection",
        "provider:neon:function",
        "provider:neon:languagemodel",
        "local",
      ],
      exclusive: true,
    },
  );
}

for (const [name, environment, message] of [
  [
    "wrong branch",
    {
      NEON_AI_GATEWAY_BASE_URL: "https://other.invalid",
      NEON_AI_GATEWAY_TOKEN: "other-token",
    },
    "does not match",
  ],
  [
    "missing grant",
    {
      NEON_AI_GATEWAY_BASE_URL: "https://branch.invalid",
      NEON_API_KEY: "DO_NOT_BIND_ACCOUNT_KEY",
    },
    "did not inject",
  ],
  ["missing environment", undefined, "does not match"],
] as const) {
  test.effect(
    `HTTP AI client rejects ${name} instead of falling back to another token`,
    () =>
      runtimeMode(
        Effect.gen(function* () {
          const client = yield* QueryAIGateway(gateway);
          const result = yield* Effect.result(Effect.sandbox(client.token));
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(String(result.failure)).toContain(message);
            expect(String(result.failure)).not.toContain(
              "DO_NOT_BIND_ACCOUNT_KEY",
            );
          }
        }).pipe(Effect.provide(services(true, environment))),
      ),
    {
      tags: [
        "unit",
        "provider:neon",
        "provider:neon:aigateway",
        "provider:neon:backendconnection",
        "provider:neon:function",
        "provider:neon:languagemodel",
        "local",
      ],
      exclusive: true,
    },
  );
}
