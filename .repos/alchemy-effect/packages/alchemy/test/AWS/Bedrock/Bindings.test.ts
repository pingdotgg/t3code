import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import BedrockTestFunctionLive, { BedrockTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BedrockBindings");

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
// parallel load (cold re-init, IAM propagation, Bedrock throttling surfaced
// as a defect). Retry 5xx only; a genuine 4xx/assertion failure surfaces
// immediately.
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

describe("Bedrock Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Bedrock test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Bedrock test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* BedrockTestFunction;
        }).pipe(Effect.provide(BedrockTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `Bedrock test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Bedrock test setup: fixture not ready yet (${String(error)})`,
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

  describe("CountTokens", () => {
    test.provider(
      "counts input tokens without invoking the model",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/count-tokens`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            inputTokens: number;
          };

          expect(response.inputTokens).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Rerank", () => {
    test.provider(
      "reranks inline documents by relevance to the query",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/rerank`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            results: Array<{ index: number; relevanceScore: number }>;
          };

          expect(response.results).toHaveLength(2);
          // The alchemy document must outrank the banana document.
          expect(response.results[0]!.index).toBe(0);
          expect(response.results[0]!.relevanceScore).toBeGreaterThan(
            response.results[1]!.relevanceScore,
          );
        }),
      { timeout: 120_000 },
    );
  });

  describe("InvokeAgent", () => {
    test.provider(
      "invokes the bound agent alias and streams a completion",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/invoke-agent`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            sessionId: string;
            chunkEvents: number;
            text: string;
          };

          expect(response.sessionId.length).toBeGreaterThan(0);
          expect(response.chunkEvents).toBeGreaterThan(0);
          // Assert a non-empty completion — never exact model output.
          expect(response.text.trim().length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetAgentMemory + DeleteAgentMemory", () => {
    test.provider(
      "reads and clears the agent's long-term memory for a memory id",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/agent-memory`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            memoryContents: number;
            deleted: boolean;
          };

          // Session summaries generate asynchronously long after a session
          // ends, so a fresh agent has none — the route proves the IAM
          // grants and the read+delete round-trip, not summary generation.
          expect(response.memoryContents).toBeGreaterThanOrEqual(0);
          expect(response.deleted).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Converse", () => {
    test.provider(
      "converses with the bound model and returns a completion",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/converse`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            text: string;
            stopReason: string;
            outputTokens: number;
          };

          // Assert a non-empty completion — never exact model output (LLMs
          // are nondeterministic even at temperature 0).
          expect(response.text.trim().length).toBeGreaterThan(0);
          expect(["end_turn", "max_tokens"]).toContain(response.stopReason);
          expect(response.outputTokens).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ConverseStream", () => {
    test.provider(
      "streams a conversation as typed events",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/converse-stream`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            text: string;
            deltaEvents: number;
            totalEvents: number;
            stopReason: string | undefined;
          };

          // Assert a non-empty streamed completion — never exact model output.
          expect(response.text.trim().length).toBeGreaterThan(0);
          expect(response.deltaEvents).toBeGreaterThan(0);
          expect(response.totalEvents).toBeGreaterThan(response.deltaEvents);
          expect(["end_turn", "max_tokens"]).toContain(response.stopReason);
        }),
      { timeout: 120_000 },
    );
  });

  describe("InvokeModelWithResponseStream", () => {
    test.provider(
      "streams raw payload chunks from the bound model",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/invoke-model-stream`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            contentType: string;
            chunkEvents: number;
            text: string;
          };

          expect(response.contentType).toBe("application/json");
          expect(response.chunkEvents).toBeGreaterThan(0);
          // Assert a non-empty streamed completion — never exact model output.
          expect(response.text.trim().length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("InvokeModel", () => {
    test.provider(
      "invokes the bound model with a raw payload and streams the response",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/invoke-model`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            contentType: string;
            text: string;
            stopReason: string;
          };

          expect(response.contentType).toBe("application/json");
          // Assert a non-empty completion — never exact model output.
          expect(response.text.trim().length).toBeGreaterThan(0);
          expect(["end_turn", "max_tokens"]).toContain(response.stopReason);
        }),
      { timeout: 120_000 },
    );
  });
});
