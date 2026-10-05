import type { QueryAIGatewayClient, LanguageModelOptions } from "alchemy/Neon";
import { FunctionRequest } from "alchemy/Neon";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, test as bunTest } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AiError, LanguageModel, Response } from "effect/ai";
import * as Sse from "effect/encoding/Sse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import { chat } from "../src/ai/EffectApi.ts";

const test = {
  effect: (
    name: string,
    body: () => Effect.Effect<unknown, unknown>,
    options?: { timeout: number },
  ) => bunTest(name, () => Effect.runPromise(body()), options?.timeout),
};

const environment = {
  NEON_EXAMPLE_API_KEY: "example-secret",
  NEON_AI_MODEL: "mock-model",
  NEON_AI_ALLOW_PAID: "false",
};
const usage = new Response.Usage({
  inputTokens: {
    total: 1,
    uncached: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
});
const textParts: Array<Response.StreamPartEncoded> = [
  { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: "Hello 🌍" },
  { type: "text-end", id: "text" },
  { type: "finish", reason: "stop", usage },
];
const mockModel = (
  stream: Stream.Stream<
    Response.StreamPartEncoded,
    AiError.AiError
  > = Stream.fromIterable(textParts),
) => {
  const calls: Array<LanguageModelOptions> = [];
  const prompts: Array<LanguageModel.ProviderOptions["prompt"]> = [];
  const runtimeIds: Array<string> = [];
  const ai: Pick<QueryAIGatewayClient, "model"> = {
    model: (options) => {
      calls.push(options);
      return Layer.effect(
        LanguageModel.LanguageModel,
        Effect.gen(function* () {
          const runtime = yield* RuntimeContext;
          runtimeIds.push(runtime.id);
          return yield* LanguageModel.make({
            generateText: () =>
              Effect.die("Example should use LanguageModel.streamText"),
            streamText: (options) => {
              prompts.push(options.prompt);
              return stream;
            },
          });
        }),
      );
    },
  };
  return { ai, calls, prompts, runtimeIds };
};
const invoke = (
  ai: Pick<QueryAIGatewayClient, "model">,
  env: Readonly<Record<string, string | undefined>> = environment,
  body = '{"prompt":"Hello"}',
  authorization: string | null | undefined = "Bearer example-secret",
  signal?: AbortSignal,
) =>
  Effect.gen(function* () {
    const request = yield* Effect.sync(
      () =>
        new Request("https://example.invalid/chat", {
          method: "POST",
          body,
          signal,
          headers: {
            "content-type": "application/json",
            ...(authorization == null ? {} : { authorization }),
          },
        }),
    );
    return yield* chat(ai, env).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.provideService(FunctionRequest, request),
      Effect.provideService(RuntimeContext, {
        Type: "test",
        id: "captured-request",
        env: {},
        get: () => Effect.succeed(undefined),
        set: (id) => Effect.succeed(id),
      }),
    );
  });
const bodyStream = (response: HttpServerResponse.HttpServerResponse) => {
  if (response.body._tag !== "Stream")
    return Stream.die("Expected SSE response body");
  return response.body.stream;
};
const text = (response: HttpServerResponse.HttpServerResponse) =>
  bodyStream(response).pipe(
    Stream.decodeText(),
    Stream.runCollect,
    Effect.map((chunks) => chunks.join("")),
  );
const UiEvent = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  delta: Schema.optional(Schema.String),
  errorText: Schema.optional(Schema.String),
  finishReason: Schema.optional(Schema.String),
});
const events = (wire: string) =>
  Stream.succeed(wire).pipe(
    Stream.pipeThroughChannel(Sse.decode<never, unknown>()),
    Stream.map((event) => event.data),
    Stream.filter((data) => data !== "[DONE]"),
    Stream.mapEffect((data) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(UiEvent))(data),
    ),
    Stream.runCollect,
  );

for (const [name, authorization] of [
  ["missing", undefined],
  ["wrong", "Bearer wrong"],
] as const) {
  test.effect(
    `Effect example returns 401 for ${name} authorization before validation`,
    () =>
      Effect.gen(function* () {
        const mock = mockModel();
        const response = yield* invoke(
          mock.ai,
          environment,
          "not JSON",
          authorization ?? null,
        );
        expect(response.status).toBe(401);
        expect(mock.calls).toHaveLength(0);
      }).pipe(Effect.scoped),
  );
}

for (const [name, body] of [
  ["malformed JSON", "{"],
  ["missing prompt", "{}"],
  ["null", "null"],
  ["non-string prompt", '{"prompt":4}'],
  ["blank prompt", '{"prompt":"   "}'],
  ["oversized prompt", JSON.stringify({ prompt: "x".repeat(4001) })],
] as const) {
  test.effect(
    `Effect example returns 400 for ${name} before the paid gate`,
    () =>
      Effect.gen(function* () {
        const mock = mockModel();
        const response = yield* invoke(mock.ai, environment, body);
        expect(response.status).toBe(400);
        expect(mock.calls).toHaveLength(0);
      }).pipe(Effect.scoped),
  );
}

for (const [name, env] of [
  ["disabled inference", environment],
  [
    "missing model",
    { ...environment, NEON_AI_ALLOW_PAID: "true", NEON_AI_MODEL: undefined },
  ],
  ["non-explicit opt-in", { ...environment, NEON_AI_ALLOW_PAID: "1" }],
] as const) {
  test.effect(
    `Effect example returns 503 for ${name} without constructing a model`,
    () =>
      Effect.gen(function* () {
        const mock = mockModel();
        const response = yield* invoke(mock.ai, env);
        expect(response.status).toBe(503);
        expect(mock.calls).toHaveLength(0);
      }).pipe(Effect.scoped),
  );
}

test.effect(
  "Effect example calls the bound LanguageModel and preserves context in its deferred SSE body",
  () =>
    Effect.gen(function* () {
      const mock = mockModel();
      const response = yield* invoke(mock.ai, {
        ...environment,
        NEON_AI_ALLOW_PAID: "true",
      });
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("text/event-stream");
      expect(response.headers["x-vercel-ai-ui-message-stream"]).toBe("v1");
      expect(mock.calls).toEqual([
        { model: "mock-model", parameters: { maxTokens: 128 } },
      ]);
      expect(mock.prompts).toHaveLength(0);
      // Consume after invoke's request-service provision has ended.
      const wire = yield* text(response);
      expect(mock.runtimeIds).toEqual(["captured-request"]);
      expect(mock.prompts).toHaveLength(1);
      expect(mock.prompts[0]?.content).toMatchObject([
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ]);
      const parsed = yield* events(wire);
      expect(parsed.map((event) => event.type)).toEqual([
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "finish",
      ]);
      expect(parsed.find((event) => event.type === "text-delta")?.delta).toBe(
        "Hello 🌍",
      );
      expect(wire).toContain("data: [DONE]");
    }).pipe(Effect.scoped),
);

test.effect(
  "Effect example sanitizes AiError SSE failures without retrying or leaking credentials",
  () =>
    Effect.gen(function* () {
      const mock = mockModel(
        Stream.concat(
          Stream.fromIterable(textParts.slice(0, 2)),
          Stream.fail(
            AiError.make({
              module: "test",
              method: "streamText",
              reason: new AiError.InvalidRequestError({
                description: "UPSTREAM_TOKEN_SENTINEL",
              }),
            }),
          ),
        ),
      );
      const response = yield* invoke(mock.ai, {
        ...environment,
        NEON_AI_ALLOW_PAID: "true",
      });
      const wire = yield* text(response);
      const parsed = yield* events(wire);
      expect(parsed.filter((event) => event.type === "error")).toHaveLength(1);
      expect(
        parsed.find((event) => event.type === "error")?.errorText,
      ).toContain("Gateway rejected the request");
      expect(parsed.some((event) => event.type === "finish")).toBe(false);
      expect(wire).not.toContain("UPSTREAM_TOKEN_SENTINEL");
      expect(wire).not.toContain("example-secret");
      expect(wire).toContain("data: [DONE]");
      expect(mock.prompts).toHaveLength(1);
    }).pipe(Effect.scoped),
);

test.effect(
  "Effect example request abort interrupts upstream model consumption",
  () =>
    Effect.gen(function* () {
      const controller = yield* Effect.sync(() => new AbortController());
      const started = yield* Deferred.make<void>();
      let finalized = false;
      const mock = mockModel(
        Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
          Stream.drain,
          Stream.concat(Stream.never),
          Stream.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
      );
      const response = yield* invoke(
        mock.ai,
        { ...environment, NEON_AI_ALLOW_PAID: "true" },
        undefined,
        undefined,
        controller.signal,
      );
      const consumer = yield* bodyStream(response).pipe(
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Effect.sync(() => controller.abort());
      yield* Fiber.join(consumer);
      expect(finalized).toBe(true);
    }).pipe(Effect.scoped),
  { timeout: 5000 },
);

test.effect(
  "Effect example does not start model inference for an already-aborted request",
  () =>
    Effect.gen(function* () {
      const controller = yield* Effect.sync(() => new AbortController());
      yield* Effect.sync(() => controller.abort());
      const mock = mockModel();
      const response = yield* invoke(
        mock.ai,
        { ...environment, NEON_AI_ALLOW_PAID: "true" },
        undefined,
        undefined,
        controller.signal,
      );
      yield* bodyStream(response).pipe(Stream.runDrain);
      expect(mock.prompts).toHaveLength(0);
    }).pipe(Effect.scoped),
  { timeout: 5000 },
);

test.effect(
  "Effect example downstream cancellation closes the model stream",
  () =>
    Effect.gen(function* () {
      let finalized = false;
      const mock = mockModel(
        Stream.fromIterable(textParts.slice(0, 2)).pipe(
          Stream.concat(Stream.never),
          Stream.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
      );
      const response = yield* invoke(mock.ai, {
        ...environment,
        NEON_AI_ALLOW_PAID: "true",
      });
      yield* bodyStream(response).pipe(
        Stream.decodeText(),
        Stream.takeUntil((chunk) => chunk.includes("text-delta")),
        Stream.runDrain,
      );
      expect(finalized).toBe(true);
    }).pipe(Effect.scoped),
  { timeout: 5000 },
);

test.effect(
  "example source uses the canonical Effect model and gateway reference documentation is discoverable",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const examplePath = yield* path.fromFileUrl(
        new URL("../src/ai/EffectApi.ts", import.meta.url),
      );
      const gatewayPath = yield* path.fromFileUrl(
        new URL(
          "../../../packages/alchemy/src/Neon/AIGateway.ts",
          import.meta.url,
        ),
      );
      const source = yield* fs.readFileString(examplePath);
      expect(source).toContain("const model = ai.model(");
      expect(source).toContain("LanguageModel.streamText(");
      expect(source).toContain("Stream.provideContext(context)");
      expect(source).not.toContain("@neon/ai-sdk-provider");
      expect(source).not.toContain('from "ai"');
      for (const name of [
        "NEON_EXAMPLE_API_KEY",
        "NEON_AI_MODEL",
        "NEON_AI_ALLOW_PAID",
      ]) {
        expect(source).toContain(`environment.${name}`);
        expect(source).toContain(`("${name}")`);
      }
      expect(yield* fs.readFileString(gatewayPath)).toContain(
        " * @resource\n * @category AI Gateway",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
