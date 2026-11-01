import {
  makeLanguageModel,
  type LanguageModelOptions,
} from "@/Neon/LanguageModel.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { LanguageModel, Tool, Toolkit } from "effect/ai";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const secret = "nt_live_SECRET_SENTINEL";
const Sum = Tool.make("sum", {
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
});
const Tools = Toolkit.make(Sum);
const tools = Tools.toLayer({ sum: ({ a, b }) => Effect.succeed(a + b) });
const toolCall = {
  id: "call_1",
  type: "function",
  function: { name: "sum", arguments: '{"a":2,"b":3}' },
};
const completion = (message: unknown, finish = "stop", usage?: unknown) => ({
  choices: [{ message, finish_reason: finish }],
  usage,
});
const chunk = (
  delta: unknown,
  finish: string | null = null,
  usage?: unknown,
) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
  usage,
});
const sse = (...events: Array<unknown>) =>
  events
    .map(
      (value) =>
        `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`,
    )
    .join("");

const harness = (
  respond: () => globalThis.Response,
  parameters?: LanguageModelOptions["parameters"],
) => {
  const requests: Array<{
    url: string;
    authorization: string | undefined;
    body: unknown;
  }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.body._tag !== "Uint8Array")
        throw new Error("Expected a JSON request");
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(new TextDecoder().decode(request.body.body)),
      });
      return HttpClientResponse.fromWeb(request, respond());
    }),
  );
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    makeLanguageModel({
      model: "test-model",
      parameters,
      client: {
        chatBaseUrl: Effect.succeed("https://branch.invalid/v1/"),
        token: Effect.succeed(Redacted.make(secret)),
      },
    }),
  ).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(RuntimeContext.phantom),
  );
  return { layer, requests };
};

test.effect(
  "Chat route, scoped bearer, parameters and detailed usage",
  () =>
    Effect.gen(function* () {
      const { layer, requests } = harness(
        () =>
          Response.json(
            completion({ content: "Hello" }, "stop", {
              prompt_tokens: 20,
              completion_tokens: 12,
              prompt_tokens_details: { cached_tokens: 5 },
              completion_tokens_details: { reasoning_tokens: 7 },
            }),
          ),
        { temperature: 0.2, maxTokens: 30, seed: 4 },
      );
      expect(requests).toHaveLength(0);
      const response = yield* LanguageModel.generateText({
        prompt: "Hello",
      }).pipe(Effect.provide(layer));
      expect(response.text).toBe("Hello");
      expect(response.usage.inputTokens).toMatchObject({
        total: 20,
        uncached: 15,
        cacheRead: 5,
      });
      expect(response.usage.outputTokens).toMatchObject({
        total: 12,
        text: 5,
        reasoning: 7,
      });
      expect(requests[0]).toMatchObject({
        url: "https://branch.invalid/v1/chat/completions",
        authorization: `Bearer ${secret}`,
        body: {
          model: "test-model",
          stream: false,
          max_tokens: 30,
          temperature: 0.2,
          seed: 4,
        },
      });
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);

test.effect(
  "content blocks and absent usage are not fabricated as zero",
  () =>
    Effect.gen(function* () {
      const { layer } = harness(() =>
        Response.json(
          completion({
            content: [
              { type: "text", text: "Hello" },
              { type: "text", text: " world" },
            ],
          }),
        ),
      );
      const response = yield* LanguageModel.generateText({ prompt: "Hi" }).pipe(
        Effect.provide(layer),
      );
      expect(response.text).toBe("Hello world");
      expect(response.usage.inputTokens.total).toBeUndefined();
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);

test.effect(
  "schema output sends strict JSON Schema and decodes the object",
  () =>
    Effect.gen(function* () {
      const { layer, requests } = harness(() =>
        Response.json(completion({ content: '{"greeting":"Hello"}' })),
      );
      const response = yield* LanguageModel.generateObject({
        prompt: "Greet",
        objectName: "Greeting",
        schema: Schema.Struct({ greeting: Schema.String }),
      }).pipe(Effect.provide(layer));
      expect(response.value).toEqual({ greeting: "Hello" });
      expect(requests[0]?.body).toMatchObject({
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "Greeting",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["greeting"],
            },
          },
        },
      });
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);

test.effect(
  "function tools execute and forced choice uses the OpenAI wire shape",
  () =>
    Effect.gen(function* () {
      const { layer, requests } = harness(() =>
        Response.json(
          completion({ content: null, tool_calls: [toolCall] }, "tool_calls"),
        ),
      );
      const response = yield* LanguageModel.generateText({
        prompt: "Add two and three",
        toolkit: Tools,
        toolChoice: { tool: "sum" },
      }).pipe(Effect.provide(layer), Effect.provide(tools));
      expect(response.toolCalls[0]?.params).toEqual({ a: 2, b: 3 });
      expect(response.toolResults[0]?.result).toBe(5);
      expect(response.finishReason).toBe("tool-calls");
      expect(requests[0]?.body).toMatchObject({
        tool_choice: { type: "function", function: { name: "sum" } },
        tools: [{ type: "function", function: { name: "sum" } }],
      });
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);

test.effect(
  "prompt round-trips assistant calls and tool results",
  () =>
    Effect.gen(function* () {
      const { layer, requests } = harness(() =>
        Response.json(completion({ content: "Five" })),
      );
      yield* LanguageModel.generateText({
        prompt: [
          { role: "system", content: "Calculate" },
          { role: "user", content: [{ type: "text", text: "Add" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                id: "call_1",
                name: "sum",
                params: { a: 2, b: 3 },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                id: "call_1",
                name: "sum",
                result: 5,
                isFailure: false,
              },
            ],
          },
        ],
      }).pipe(Effect.provide(layer));
      expect(requests[0]?.body).toMatchObject({
        messages: [
          { role: "system", content: "Calculate" },
          { role: "user", content: [{ type: "text", text: "Add" }] },
          { role: "assistant", content: null, tool_calls: [toolCall] },
          { role: "tool", tool_call_id: "call_1", content: "5" },
        ],
      });
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);

test.effect(
  "SSE emits text ordering, late usage and one finish",
  () =>
    Effect.gen(function* () {
      const { layer, requests } = harness(
        () =>
          new Response(
            sse(
              chunk({ role: "assistant", content: "Hel" }),
              chunk({ content: "lo" }),
              chunk({}, "stop"),
              {
                choices: [],
                usage: { prompt_tokens: 4, completion_tokens: 2 },
              },
              "[DONE]",
            ),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const parts = yield* LanguageModel.streamText({ prompt: "Hi" }).pipe(
        Stream.provide(layer),
        Stream.runCollect,
      );
      expect(parts.map((part) => part.type)).toEqual([
        "text-start",
        "text-delta",
        "text-delta",
        "text-end",
        "finish",
      ]);
      expect(
        parts.find((part) => part.type === "finish")?.usage.inputTokens.total,
      ).toBe(4);
      expect(requests[0]?.body).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);

test.effect(
  "interleaved streamed tools append fragments and execute once per call",
  () =>
    Effect.gen(function* () {
      const { layer } = harness(
        () =>
          new Response(
            sse(
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: "one",
                    type: "function",
                    function: { name: "sum", arguments: '{"a":2,' },
                  },
                  {
                    index: 1,
                    id: "two",
                    type: "function",
                    function: { name: "sum", arguments: '{"a":4,' },
                  },
                ],
              }),
              chunk({
                tool_calls: [
                  { index: 1, function: { arguments: '"b":5}' } },
                  { index: 0, function: { arguments: '"b":3}' } },
                ],
              }),
              chunk({}, "tool_calls"),
              "[DONE]",
            ),
          ),
      );
      const parts = yield* LanguageModel.streamText({
        prompt: "Add",
        toolkit: Tools,
        toolChoice: "required",
      }).pipe(Stream.provide(layer), Stream.provide(tools), Stream.runCollect);
      expect(
        parts
          .filter((part) => part.type === "tool-call")
          .map((part) => part.params),
      ).toEqual([
        { a: 2, b: 3 },
        { a: 4, b: 5 },
      ]);
      expect(
        parts
          .filter((part) => part.type === "tool-result")
          .map((part) => part.result)
          .sort(),
      ).toEqual([5, 9]);
      expect(
        parts.filter((part) => part.type === "tool-params-start"),
      ).toHaveLength(2);
      expect(parts.filter((part) => part.type === "finish")).toHaveLength(1);
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);

for (const [name, body] of [
  ["malformed JSON", "data: not-json\n\n"],
  ["premature EOF", sse(chunk({ content: "partial" }))],
  ["missing DONE", sse(chunk({ content: "partial" }, "stop"))],
  ["empty stream", ""],
  [
    "invalid schema",
    sse({ choices: [{ delta: { content: 42 }, index: 0 }] }, "[DONE]"),
  ],
  [
    "error event",
    'event: error\ndata: {"error":{"message":"nt_live_SECRET_SENTINEL"}}\n\n',
  ],
] as const) {
  test.effect(
    `stream rejects ${name} without disclosing upstream payload`,
    () =>
      Effect.gen(function* () {
        const { layer } = harness(() => new Response(body));
        const result = yield* LanguageModel.streamText({ prompt: "Hi" }).pipe(
          Stream.provide(layer),
          Stream.runCollect,
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(JSON.stringify(result)).not.toContain(secret);
      }),
    { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
  );
}

for (const [status, code, tag] of [
  [401, undefined, "AuthenticationError"],
  [403, undefined, "AuthenticationError"],
  [402, undefined, "QuotaExhaustedError"],
  [429, "REQUEST_LIMIT_EXCEEDED", "QuotaExhaustedError"],
  [429, undefined, "RateLimitError"],
  [502, undefined, "InternalProviderError"],
  [400, undefined, "InvalidRequestError"],
] as const) {
  test.effect(
    `HTTP ${status} ${code ?? ""} maps to ${tag} and scrubs secrets`,
    () =>
      Effect.gen(function* () {
        const { layer } = harness(() =>
          Response.json(
            { error: { code, message: `Bearer ${secret}` } },
            { status, headers: { "retry-after": "2" } },
          ),
        );
        const result = yield* LanguageModel.generateText({ prompt: "Hi" }).pipe(
          Effect.provide(layer),
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure.reason._tag).toBe(tag);
        expect(JSON.stringify(result)).not.toContain(secret);
      }),
    { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
  );
}

test.effect(
  "malformed tool JSON fails rather than executing a partial tool",
  () =>
    Effect.gen(function* () {
      const { layer } = harness(() =>
        Response.json(
          completion(
            {
              tool_calls: [
                {
                  ...toolCall,
                  function: { ...toolCall.function, arguments: "{" },
                },
              ],
            },
            "tool_calls",
          ),
        ),
      );
      const result = yield* LanguageModel.generateText({
        prompt: "Hi",
        toolkit: Tools,
      }).pipe(Effect.provide(layer), Effect.provide(tools), Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);

test.effect(
  "invalid JSON schema responses fail Effect's structured-output validation",
  () =>
    Effect.gen(function* () {
      const { layer } = harness(() =>
        Response.json(completion({ content: '{"greeting":42}' })),
      );
      const result = yield* LanguageModel.generateObject({
        prompt: "Greet",
        schema: Schema.Struct({ greeting: Schema.String }),
      }).pipe(Effect.provide(layer), Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);

test.effect(
  "disabled-account rejection is non-retryable quota exhaustion, not a bad token",
  () =>
    Effect.gen(function* () {
      const { layer } = harness(() =>
        Response.json(
          { error: { message: "ai gateway not enabled for account" } },
          { status: 403 },
        ),
      );
      const result = yield* LanguageModel.generateText({ prompt: "Hi" }).pipe(
        Effect.provide(layer),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.reason._tag).toBe("QuotaExhaustedError");
        expect(result.failure.reason.isRetryable).toBe(false);
      }
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);

test.effect(
  "fragmented UTF-8 SSE chunks preserve multibyte text",
  () =>
    Effect.gen(function* () {
      const { layer } = harness(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const bytes = new TextEncoder().encode(
                  sse(chunk({ content: "héllo 🌍" }, "stop"), "[DONE]"),
                );
                for (const byte of bytes)
                  controller.enqueue(new Uint8Array([byte]));
                controller.close();
              },
            }),
          ),
      );
      const parts = yield* LanguageModel.streamText({ prompt: "Hi" }).pipe(
        Stream.provide(layer),
        Stream.runCollect,
      );
      expect(
        parts
          .filter((part) => part.type === "text-delta")
          .map((part) => part.delta)
          .join(""),
      ).toBe("héllo 🌍");
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);

test.effect(
  "truncated streamed tools never run a handler",
  () =>
    Effect.gen(function* () {
      const { layer } = harness(
        () =>
          new Response(
            sse(
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: "one",
                    type: "function",
                    function: { name: "sum", arguments: '{"a":2,' },
                  },
                ],
              }),
              chunk({}, "length"),
              "[DONE]",
            ),
          ),
      );
      const parts = yield* LanguageModel.streamText({
        prompt: "Add",
        toolkit: Tools,
      }).pipe(Stream.provide(layer), Stream.provide(tools), Stream.runCollect);
      expect(parts.filter((part) => part.type === "tool-result")).toHaveLength(
        0,
      );
      expect(parts.find((part) => part.type === "finish")?.reason).toBe(
        "length",
      );
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);

test.effect(
  "image inputs preserve order while audio fails before HTTP",
  () =>
    Effect.gen(function* () {
      const { layer, requests } = harness(() =>
        Response.json(completion({ content: "Image" })),
      );
      yield* LanguageModel.generateText({
        prompt: [
          {
            role: "user",
            content: [
              { type: "text", text: "Before" },
              {
                type: "file",
                mediaType: "image/png",
                data: new Uint8Array([1, 2]),
              },
              { type: "text", text: "After" },
            ],
          },
        ],
      }).pipe(Effect.provide(layer));
      expect(requests[0]?.body).toMatchObject({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Before" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AQI=" },
              },
              { type: "text", text: "After" },
            ],
          },
        ],
      });
      const result = yield* LanguageModel.generateText({
        prompt: [
          {
            role: "user",
            content: [{ type: "file", mediaType: "audio/wav", data: "AA==" }],
          },
        ],
      }).pipe(Effect.provide(layer), Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(requests).toHaveLength(1);
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);

test.effect(
  "downstream cancellation closes the HTTP stream without waiting for DONE",
  () =>
    Effect.gen(function* () {
      let cancelled = false;
      const { layer } = harness(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(sse(chunk({ content: "Hello" }))),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      );
      yield* LanguageModel.streamText({ prompt: "Hi" }).pipe(
        Stream.provide(layer),
        Stream.take(1),
        Stream.runDrain,
      );
      expect(cancelled).toBe(true);
    }),
  { tags: ["unit", "provider:neon", "provider:neon:languagemodel", "local"] },
);
