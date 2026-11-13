import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe } from "vite-plus/test";

import { loadOpenCode2Catalog } from "./openCode2Catalog.ts";
import { makeOpenCode2ModelLoader } from "./status.ts";
import * as OpenCode2Client from "./v2/OpenCode2Client.ts";

const MODELS_BODY = `{"location":{"directory":"/project"},"data":[{"id":"step-5-preview-free","modelID":"step-5-preview-free","providerID":"opencode-go","name":"Step 5 Preview Free","compatibility":{"reasoningField":"reasoning_content"},"package":"@opencode/ai/providers/openai-compatible","settings":{"apiKey":"sk-demo-not-real","baseURL":"http://127.0.0.1:48990/v1","provider":"opencode-go"},"capabilities":{"tools":true,"input":["text","image","video"],"output":["text"]},"variants":[{"id":"low","settings":{"reasoningEffort":"low"}},{"id":"medium","settings":{"reasoningEffort":"medium"}},{"id":"high","settings":{"reasoningEffort":"high"}}],"time":{"released":1789516800000},"cost":[{"input":0,"output":0,"cache":{"read":0,"write":0}}],"status":"active","enabled":true,"limit":{"context":1000000,"input":1000000,"output":65536}},{"id":"step-5-preview-free","modelID":"step-5-preview-free","providerID":"opencode","name":"Step 5 Preview Free","compatibility":{"reasoningField":"reasoning_content"},"package":"@opencode/ai/providers/openai-compatible","settings":{"apiKey":"public","baseURL":"https://opencode.ai/zen/v1","provider":"opencode"},"capabilities":{"tools":true,"input":["text","image","video"],"output":["text"]},"variants":[{"id":"low","settings":{"reasoningEffort":"low"}},{"id":"medium","settings":{"reasoningEffort":"medium"}},{"id":"high","settings":{"reasoningEffort":"high"}}],"time":{"released":1789516800000},"cost":[{"input":0,"output":0,"cache":{"read":0,"write":0}}],"status":"active","enabled":true,"limit":{"context":1000000,"input":1000000,"output":65536}}]}`;

const PROVIDERS_BODY = `{"location":{"directory":"/project"},"data":[{"id":"opencode-go","integrationID":"opencode-go","name":"OpenCode Go","activation":"enabled","package":"@opencode/ai/providers/openai-compatible","settings":{"apiKey":"sk-demo-not-real","baseURL":"http://127.0.0.1:48990/v1","provider":"opencode-go"}},{"id":"opencode","integrationID":"opencode","name":"OpenCode Zen","activation":"enabled","package":"@opencode/ai/providers/openai-compatible","settings":{"apiKey":"public","baseURL":"https://opencode.ai/zen/v1"}}]}`;

const PLUGINS_ACTIVATING_BODY =
  '{"_tag":"ServiceUnavailableError","message":"Location plugins did not finish activating","service":"plugin"}';

type Reply = string | { readonly status: number; readonly body: string };

const layerServerReplying = (
  bodies: Readonly<Record<string, Reply | Effect.Effect<Reply>>>,
  hanging: ReadonlyArray<string> = [],
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const path = new URL(request.url).pathname;
        if (hanging.includes(path)) {
          return yield* Effect.never;
        }
        const recorded = bodies[path];
        const reply = Effect.isEffect(recorded) ? yield* recorded : recorded;
        const { status, body } =
          reply === undefined
            ? { status: 404, body: '{"_tag":"NotFoundError","message":"not recorded"}' }
            : typeof reply === "string"
              ? { status: 200, body: reply }
              : reply;
        return HttpClientResponse.fromWeb(
          request,
          new Response(body, { status, headers: { "content-type": "application/json" } }),
        );
      }),
    ),
  );

const readCatalog = (
  bodies: Readonly<Record<string, Reply | Effect.Effect<Reply>>>,
  hanging: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode2Client.OpenCode2Client;
    const { client } = yield* opencode.connect({
      baseUrl: "http://127.0.0.1:4096",
      password: "secret",
    });
    return yield* loadOpenCode2Catalog(client, "/project");
  }).pipe(
    Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(layerServerReplying(bodies, hanging)))),
  );

describe("loadOpenCode2Catalog", () => {
  it.effect("names the provider each listed model came from", () =>
    Effect.gen(function* () {
      const models = yield* readCatalog({
        "/api/model": MODELS_BODY,
        "/api/provider": PROVIDERS_BODY,
      });

      assert.deepStrictEqual(
        models.map((model) => [`${model.providerID}/${model.id}`, model.providerName]),
        [
          ["opencode-go/step-5-preview-free", "OpenCode Go"],
          ["opencode/step-5-preview-free", "OpenCode Zen"],
        ],
      );
    }),
  );

  it.effect("leaves a model unnamed when the provider list fails", () =>
    Effect.gen(function* () {
      const models = yield* readCatalog({ "/api/model": MODELS_BODY });

      assert.deepStrictEqual(
        models.map((model) => [`${model.providerID}/${model.id}`, model.providerName]),
        [
          ["opencode-go/step-5-preview-free", undefined],
          ["opencode/step-5-preview-free", undefined],
        ],
      );
    }),
  );

  it.effect("lists no models yet when the model list does not answer", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        readCatalog({ "/api/provider": PROVIDERS_BODY }, ["/api/model"]),
      );
      yield* TestClock.adjust("8 seconds");

      assert.deepStrictEqual(yield* Fiber.join(fiber), []);
    }),
  );

  // regression: #17424 only the provider list is optional; a model-list failure fails the read
  it.effect("fails the read when the model list fails", () =>
    Effect.gen(function* () {
      const error = yield* readCatalog({
        "/api/model": '{"_tag":"InternalServerError","message":"catalog unavailable"}',
        "/api/provider": PROVIDERS_BODY,
      }).pipe(Effect.flip);

      assert.strictEqual(error.operation, "model.list");
      assert.match(error.detail, /could not list its models/i);
    }),
  );

  // regression: #30251 a cold OpenCode 2 holds each model read 5 seconds, then 503s until plugins activate
  it.effect("lists models once OpenCode 2 finishes activating its plugins", () =>
    Effect.gen(function* () {
      const activatedAt = (yield* Clock.currentTimeMillis) + 60_000;
      const listModels = Effect.gen(function* () {
        const remaining = activatedAt - (yield* Clock.currentTimeMillis);
        if (remaining <= 0) return MODELS_BODY;
        yield* Effect.sleep("5050 millis");
        return { status: 503, body: PLUGINS_ACTIVATING_BODY };
      });
      const load = yield* makeOpenCode2ModelLoader(
        readCatalog({ "/api/model": listModels, "/api/provider": PROVIDERS_BODY }),
      );
      const fiber = yield* Effect.forkChild(load);
      yield* TestClock.adjust("2 minutes");

      assert.strictEqual((yield* Fiber.join(fiber)).length, 2);
    }),
  );
});
