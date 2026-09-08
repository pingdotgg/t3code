import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import BedrockLanguageModelFunctionLive, {
  BedrockLanguageModelFunction,
} from "./language-model-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BedrockLanguageModel");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load. Budget ~150s of
// readiness polling.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// parallel load (cold re-init, IAM propagation, Bedrock throttling). Retry
// 5xx only; a genuine 4xx/assertion failure surfaces immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(5),
      ]),
    }),
  );

interface StreamPart {
  type: string;
  id?: string;
  name?: string;
  delta?: string;
  reason?: string;
  usage?: {
    inputTokens?: { total?: number };
    outputTokens?: { total?: number };
  };
}

const parseSse = (sse: string): ReadonlyArray<StreamPart> =>
  sse
    .split("\n\n")
    .map((frame) => frame.replace(/^data:\s*/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StreamPart);

describe("Bedrock LanguageModel", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Bedrock LanguageModel setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Bedrock LanguageModel setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* BedrockLanguageModelFunction;
        }).pipe(Effect.provide(BedrockLanguageModelFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `Bedrock LanguageModel setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Bedrock LanguageModel setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 120_000,
  });

  test.provider(
    "generateText answers with text, usage, and a terminal finish reason",
    (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(
            `${baseUrl}/generate?prompt=${encodeURIComponent("Say pong.")}`,
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          text: string;
          finishReason: string;
          usage: { inputTokens: number; outputTokens: number };
        };

        expect(typeof response.text).toBe("string");
        expect(response.text.length).toBeGreaterThan(0);
        expect(response.usage.inputTokens).toBeGreaterThan(0);
        expect(response.usage.outputTokens).toBeGreaterThan(0);
        // A normal Converse completion (`end_turn`) maps to `stop`.
        expect(["stop", "length"]).toContain(response.finishReason);
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "withModelParameters overrides maxTokens at runtime",
    (_stack) =>
      Effect.gen(function* () {
        // The binding's default is maxTokens: 1024; the route clamps to 8
        // via withModelParameters. Truncation proves the override reached
        // Bedrock: the model runs out of budget mid-answer.
        const response = (yield* send(
          HttpClientRequest.get(
            `${baseUrl}/generate-short?prompt=${encodeURIComponent(
              "Write a detailed multi-paragraph essay about the history of infrastructure as code.",
            )}`,
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          finishReason: string;
          outputTokens: number;
        };

        expect(response.finishReason).toBe("length");
        expect(response.outputTokens).toBeLessThanOrEqual(8);
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "withModelParameters routes a call to another bound model",
    (_stack) =>
      Effect.gen(function* () {
        // The layer binds [nova-micro, nova-lite]; this route overrides
        // modelId to nova-lite. A 200 with text proves the per-call model
        // selection and the multi-model IAM grant both work.
        const response = (yield* send(
          HttpClientRequest.get(
            `${baseUrl}/generate-lite?prompt=${encodeURIComponent("Say pong.")}`,
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          text: string;
          finishReason: string;
        };

        expect(response.text.length).toBeGreaterThan(0);
        expect(["stop", "length"]).toContain(response.finishReason);
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "streamText emits ordered parts: text-start → text-delta+ → text-end → finish",
    (_stack) =>
      Effect.gen(function* () {
        const sse = yield* send(
          HttpClientRequest.get(
            `${baseUrl}/stream?prompt=${encodeURIComponent(
              "Write a short paragraph (around 80 words) about why TypeScript developers might enjoy Effect TS.",
            )}`,
          ),
        ).pipe(Effect.flatMap((r) => r.text));
        const parts = parseSse(sse);

        const startIdx = parts.findIndex((p) => p.type === "text-start");
        const firstDeltaIdx = parts.findIndex((p) => p.type === "text-delta");
        const deltas = parts.filter((p) => p.type === "text-delta");
        const lastDeltaIdx = parts.lastIndexOf(deltas[deltas.length - 1]!);
        const endIdx = parts.findIndex((p) => p.type === "text-end");
        const finishIdx = parts.findIndex((p) => p.type === "finish");

        // Adapter invariant: a text block opens before its first delta and
        // closes before the terminal finish part.
        expect(startIdx).toBeGreaterThanOrEqual(0);
        expect(firstDeltaIdx).toBeGreaterThan(startIdx);
        expect(endIdx).toBeGreaterThan(lastDeltaIdx);
        expect(finishIdx).toBe(parts.length - 1);

        // Bedrock streams one text-delta per contentBlockDelta event — a
        // long response must produce many (a single fused delta would mean
        // the adapter buffered the stream).
        expect(deltas.length).toBeGreaterThan(3);
        const text = deltas.map((p) => p.delta ?? "").join("");
        expect(text.length).toBeGreaterThan(20);

        // The metadata event's usage must survive into the finish part.
        const finish = parts[finishIdx]!;
        expect(finish.usage?.inputTokens?.total).toBeGreaterThan(0);
        expect(finish.usage?.outputTokens?.total).toBeGreaterThan(0);
        expect(["stop", "length"]).toContain(finish.reason);
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "generateText invokes a tool and returns its result",
    (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(
            `${baseUrl}/tool?prompt=${encodeURIComponent(
              "What's the weather in San Francisco?",
            )}`,
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          finishReason: string;
          toolCalls: Array<{
            id: string;
            name: string;
            params: { city: string };
          }>;
          toolResults: Array<{
            id: string;
            name: string;
            result: { city: string; temperatureF: number; condition: string };
            isFailure: boolean;
          }>;
        };

        expect(response.toolCalls.length).toBeGreaterThan(0);
        const call = response.toolCalls[0]!;
        expect(call.name).toBe("get_weather");
        expect(typeof call.params.city).toBe("string");
        expect(call.params.city.toLowerCase()).toContain("san francisco");

        expect(response.toolResults.length).toBeGreaterThan(0);
        const result = response.toolResults[0]!;
        expect(result.name).toBe("get_weather");
        expect(result.isFailure).toBe(false);
        expect(result.result.temperatureF).toBe(72);
        expect(result.result.condition).toBe("sunny");
      }),
    { timeout: 120_000 },
  );

  test.provider(
    "streamText emits tool-params parts whose deltas concatenate to the arguments",
    (_stack) =>
      Effect.gen(function* () {
        const sse = yield* send(
          HttpClientRequest.get(
            `${baseUrl}/tool-stream?prompt=${encodeURIComponent(
              "What's the weather in Portland?",
            )}`,
          ),
        ).pipe(Effect.flatMap((r) => r.text));
        const parts = parseSse(sse);

        const starts = parts.filter((p) => p.type === "tool-params-start");
        const ends = parts.filter((p) => p.type === "tool-params-end");
        expect(starts.length).toBeGreaterThan(0);
        expect(starts[0]?.name).toBe("get_weather");
        // Adapter invariant: every contentBlockStart-opened tool block is
        // closed by contentBlockStop (or finalize), matched by id.
        expect(new Set(ends.map((p) => p.id))).toEqual(
          new Set(starts.map((p) => p.id)),
        );

        const firstId = starts[0]!.id!;
        const joined = parts
          .filter((p) => p.type === "tool-params-delta" && p.id === firstId)
          .map((p) => p.delta ?? "")
          .join("");
        const args = yield* Effect.try({
          try: () => JSON.parse(joined) as { city?: string },
          catch: (cause) =>
            new Error(
              `Invalid concatenated tool arguments ${JSON.stringify(joined)}: ${cause}`,
            ),
        });
        expect(typeof args.city).toBe("string");
        expect(args.city!.toLowerCase()).toContain("portland");

        expect(parts[parts.length - 1]?.type).toBe("finish");
      }),
    { timeout: 120_000 },
  );
});
