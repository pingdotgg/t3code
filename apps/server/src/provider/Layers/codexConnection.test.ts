import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/unstable/http";
import type * as CodexRpc from "effect-codex-app-server/rpc";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { describe } from "vite-plus/test";

import { checkCodexConnection } from "./codexConnection.ts";

// Codex 0.157.1 config/read emits this URL even for a pristine home.
const nativeConfig = {
  model_provider: null,
  model_providers: {},
  chatgpt_base_url: "https://chatgpt.com/backend-api/",
} satisfies CodexSchema.V2ConfigReadResponse__Config;

const clientFor = (
  account: CodexSchema.V2GetAccountResponse__Account | null,
  config: CodexSchema.V2ConfigReadResponse__Config = nativeConfig,
): Parameters<typeof checkCodexConnection>[0] => ({
  request: <M extends CodexRpc.ClientRequestMethod>(method: M) => {
    const response =
      method === "config/read"
        ? { config, origins: {} }
        : method === "account/read"
          ? { account, requiresOpenaiAuth: true }
          : undefined;
    NodeAssert.ok(response, "A connection probe must not issue a turn or other mutating request");
    return Effect.succeed(response as unknown as CodexRpc.ClientRequestResponsesByMethod[M]);
  },
});

describe("Codex connection recovery probe", () => {
  for (const stalledMethod of ["config/read", "account/read"] as const) {
    it.effect(`returns to recovery backoff when ${stalledMethod} stalls`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const client = clientFor({ type: "apiKey" });
        const probe = yield* checkCodexConnection(
          {
            request: (method, params) =>
              method === stalledMethod
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(client.request(method, params)),
                  )
                : client.request(method, params),
          },
          { cwd: "/project", environment: {} },
        ).pipe(Effect.provide(FetchHttpClient.layer), Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("5 seconds");
        NodeAssert.ok(probe.pollUnsafe(), "The complete probe must finish within five seconds");
        NodeAssert.equal(yield* Fiber.join(probe), false);
      }),
    );
  }

  for (const [account, endpoint, baseUrl] of [
    [{ type: "apiKey" }, "https://api.openai.com/v1/responses", "https://chatgpt.com/backend-api/"],
    [
      { type: "chatgpt", email: null, planType: "free" },
      "https://chatgpt.com/backend-api/codex/responses",
      "https://chatgpt.com/backend-api/",
    ],
    [
      { type: "chatgpt", email: null, planType: "free" },
      "https://chatgpt.com/backend-api/codex/responses",
      "https://chatgpt.com/backend-api",
    ],
  ] as const) {
    it.effect(
      `checks the ${account.type} model endpoint with base ${baseUrl} without starting work`,
      () =>
        Effect.gen(function* () {
          let requested = false;
          const reachable = yield* checkCodexConnection(
            clientFor(account, { ...nativeConfig, chatgpt_base_url: baseUrl }),
            {
              cwd: "/project",
              environment: {},
            },
          ).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(
              FetchHttpClient.Fetch,
              Object.assign(
                async (url: string | URL | Request, init?: RequestInit) => {
                  requested = true;
                  NodeAssert.equal(String(url), endpoint);
                  NodeAssert.equal(init?.method, "HEAD");
                  NodeAssert.equal(init?.redirect, "manual");
                  NodeAssert.equal(new Headers(init?.headers).get("authorization"), null);
                  return new Response(null, { status: 401 });
                },
                { preconnect: () => undefined },
              ),
            ),
          );
          NodeAssert.equal(requested, true);
          NodeAssert.equal(reachable, true);
        }),
    );
  }

  for (const status of [302, 408, 429, 500, 503, "offline"] as const) {
    it.effect(`does not report restored connectivity for ${status}`, () =>
      Effect.gen(function* () {
        const reachable = yield* checkCodexConnection(clientFor({ type: "apiKey" }), {
          cwd: "/project",
          environment: {},
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(
            FetchHttpClient.Fetch,
            Object.assign(
              async () => {
                if (status === "offline") throw new TypeError("Network is unreachable");
                return new Response(null, { status });
              },
              { preconnect: () => undefined },
            ),
          ),
        );
        NodeAssert.equal(reachable, false);
      }),
    );
  }

  for (const [name, config, environment, launchArgs] of [
    ["custom provider", { model_provider: "custom" }, {}, ""],
    ["configured base URL", { chatgpt_base_url: "https://proxy.example" }, {}, ""],
    [
      "native host custom path",
      { chatgpt_base_url: "https://chatgpt.com/backend-api/custom" },
      {},
      "",
    ],
    [
      "native URL query override",
      { chatgpt_base_url: "https://chatgpt.com/backend-api/?route=custom" },
      {},
      "",
    ],
    [
      "native-looking alternate host",
      { chatgpt_base_url: "https://chatgpt.com.example/backend-api/" },
      {},
      "",
    ],
    [
      "provider override",
      { model_providers: { openai: { base_url: "https://proxy.example" } } },
      {},
      "",
    ],
    ["environment override", {}, { OPENAI_BASE_URL: "https://proxy.example" }, ""],
    ["HTTP proxy", {}, { HTTPS_PROXY: "https://proxy.example" }, ""],
    ["launch overrides", {}, {}, "-c model_provider=custom"],
  ] as const) {
    it.effect(`leaves ${name} unsupported instead of probing an unrelated endpoint`, () =>
      Effect.gen(function* () {
        const reachable = yield* checkCodexConnection(clientFor({ type: "apiKey" }, config), {
          cwd: "/project",
          environment,
          launchArgs,
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(
            FetchHttpClient.Fetch,
            Object.assign(
              async () => {
                NodeAssert.fail("Unsupported provider routes must not make a probe request");
              },
              { preconnect: () => undefined },
            ),
          ),
        );
        NodeAssert.equal(reachable, undefined);
      }),
    );
  }
});
