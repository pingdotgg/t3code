import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { AiAsyncWorker } from "./fixtures/AiAsyncWorker.ts";
import AiBindingTestWorker from "./fixtures/AiBindingWorker.ts";

// Fresh `workers.dev` URLs return non-200 (404 / 500 "Script not found") for
// a few seconds while the edge propagates. Each test uses
// `HttpClient.filterStatusOk` so `Effect.retry` rides through these by
// converting the bad-status response into a retryable Effect failure.

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "AiBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* AiBindingTestWorker;
    const asyncWorker = yield* AiAsyncWorker;
    return {
      url: worker.url.as<string>(),
      asyncUrl: asyncWorker.url.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

type StreamPart = {
  type: string;
  delta?: string;
  reason?: string;
};

const parseSse = (sse: string): ReadonlyArray<StreamPart> =>
  sse
    .split("\n\n")
    .map((frame) => frame.replace(/^data:\s*/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StreamPart);

test(
  "deployed worker runs a Workers AI model via the plain AI binding",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client
      .get(`${out.url}/run?prompt=${encodeURIComponent("Say pong.")}`)
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    expect(res.status).toBe(200);

    // Workers AI answers either the native shape (`{ response }`) or the
    // OpenAI shape (`{ choices: [{ message: { content } }] }`).
    const body = (yield* res.json) as {
      response?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.response ?? body.choices?.[0]?.message?.content;
    expect(typeof text).toBe("string");
    expect((text as string).length).toBeGreaterThan(0);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "deployed worker lists Workers AI models via the binding",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client.get(`${out.url}/models`).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
    expect(res.status).toBe(200);

    const body = (yield* res.json) as { count: number; names: string[] };
    expect(body.count).toBeGreaterThan(0);
    expect(body.names.some((name) => name.includes("llama-3.3"))).toBe(true);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "deployed worker generates text via AI-binding-backed LanguageModel",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client
      .get(`${out.url}/generate?prompt=${encodeURIComponent("Say pong.")}`)
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    expect(res.status).toBe(200);

    const body = (yield* res.json) as {
      text: string;
      finishReason: string;
      usage: {
        inputTokens: number | undefined;
        outputTokens: number | undefined;
      };
    };

    expect(typeof body.text).toBe("string");
    expect(body.text.length).toBeGreaterThan(0);
    // Invariant shared with the gateway-backed adapter: `mapUsage` populates
    // both counts and a normal completion maps to `stop`.
    expect(body.usage.inputTokens).toBeGreaterThan(0);
    expect(body.usage.outputTokens).toBeGreaterThan(0);
    expect(body.finishReason).toBe("stop");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "async worker runs a Workers AI model via env AI binding",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client
      .get(`${out.asyncUrl}/run?prompt=${encodeURIComponent("Say pong.")}`)
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    expect(res.status).toBe(200);

    const body = (yield* res.json) as {
      mode: string;
      result: {
        response?: string;
        choices?: Array<{ message?: { content?: string } }>;
      };
    };
    expect(body.mode).toBe("async");
    const text =
      body.result.response ?? body.result.choices?.[0]?.message?.content;
    expect(typeof text).toBe("string");
    expect((text as string).length).toBeGreaterThan(0);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "async worker lists Workers AI models via env AI binding",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client.get(`${out.asyncUrl}/models`).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
    expect(res.status).toBe(200);

    const body = (yield* res.json) as {
      mode: string;
      count: number;
      names: string[];
    };
    expect(body.mode).toBe("async");
    expect(body.count).toBeGreaterThan(0);
    expect(body.names.some((name) => name.includes("llama-3.3"))).toBe(true);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "deployed worker streams text via AI-binding-backed LanguageModel",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    // A cold or transient call can answer 200 with an empty SSE (no tokens
    // streamed), which `filterStatusOk` does not catch. Fold the parse into
    // the retried effect so the same backoff rides out the blip.
    const parts = yield* client
      .get(`${out.url}/stream?prompt=${encodeURIComponent("Say pong.")}`)
      .pipe(
        Effect.flatMap((res) => res.text),
        Effect.map(parseSse),
        Effect.flatMap((parts) =>
          parts.some((p) => p.type === "text-delta") &&
          parts.some((p) => p.type === "finish")
            ? Effect.succeed(parts)
            : Effect.fail(new Error("AI stream not ready: empty/unfinished")),
        ),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );

    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta ?? "")
      .join("");
    const finish = parts.find((p) => p.type === "finish");

    expect(parts.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(finish).toBeDefined();
  }).pipe(logLevel),
  { timeout: 180_000 },
);
