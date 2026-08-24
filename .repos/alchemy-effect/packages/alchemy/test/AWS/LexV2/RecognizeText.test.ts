import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import LexTestFunctionLive, { LexTestFunction } from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "LexV2Bindings");

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

/**
 * POST /recognize with a bounded 5xx retry — the Lambda role's fresh
 * `lex:RecognizeText` policy propagates eventually, surfacing as 502
 * AccessDeniedException for the first seconds.
 */
const call = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(request);
    const body = yield* response.text;
    if (response.status >= 500) {
      return yield* Effect.fail(
        new TransientUpstream({ status: response.status, body }),
      );
    }
    if (response.status !== 200) {
      // Terminal — fail fast with the typed tag in the message.
      return yield* Effect.die(new Error(`status ${response.status}: ${body}`));
    }
    return JSON.parse(body) as Record<string, any>;
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(8),
      ]),
    }),
  );

const recognize = (text: string, sessionId: string) =>
  call(
    HttpClientRequest.post(`${baseUrl}/recognize`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ text, sessionId }),
    ),
  );

describe("LexV2 Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("LexV2 e2e setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "LexV2 e2e setup: deploying role -> bot -> locale -> intent -> version (build) -> alias -> Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* LexTestFunction;
        }).pipe(Effect.provide(LexTestFunctionLive)),
      );
      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(15),
          ]),
        }),
      );
    }),
    // The bounded locale build can consume ~90s by itself. Lambda creation
    // and IAM/function-URL propagation follow that build, so leave headroom
    // for those bounded phases when the full AWS sweep saturates the account.
    { timeout: 210_000 },
  );
  afterAll(sharedStack.destroy(), { timeout: 180_000 });

  describe("RecognizeText", () => {
    test.provider(
      "recognizes a greeting utterance as the Greet intent",
      () =>
        Effect.gen(function* () {
          const body = yield* recognize("hello", "alchemy-e2e-greet");
          expect(body.intent).toBe("Greet");
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "routes an unmatched utterance to the fallback intent",
      () =>
        Effect.gen(function* () {
          const body = yield* recognize(
            "purple monkey dishwasher",
            "alchemy-e2e-fallback",
          );
          expect(body.intent).toBe("FallbackIntent");
        }),
      { timeout: 120_000 },
    );
  });

  describe("CodeHookEventSource", () => {
    test.provider(
      "fulfillment code hook closes the intent with the handler's message",
      () =>
        Effect.gen(function* () {
          const body = yield* recognize("order a pizza", "alchemy-e2e-order");
          expect(body.intent).toBe("OrderPizza");
          expect(body.state).toBe("Fulfilled");
          expect(body.messages).toContain(
            "Order placed for alchemy-e2e-order!",
          );
        }),
      { timeout: 120_000 },
    );
  });

  describe("Sessions", () => {
    test.provider(
      "put, get, and delete a session",
      () =>
        Effect.gen(function* () {
          const sessionId = "alchemy-e2e-session";

          // PutSession seeds attributes.
          const put = yield* call(
            HttpClientRequest.post(`${baseUrl}/session`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                sessionId,
                attributes: { favorite: "pepperoni" },
              }),
            ),
          );
          expect(put.sessionId).toBe(sessionId);

          // GetSession reads them back.
          const got = yield* call(
            HttpClientRequest.get(`${baseUrl}/session?sessionId=${sessionId}`),
          );
          expect(got.attributes).toMatchObject({ favorite: "pepperoni" });

          // DeleteSession ends the conversation ...
          const deleted = yield* call(
            HttpClientRequest.delete(
              `${baseUrl}/session?sessionId=${sessionId}`,
            ),
          );
          expect(deleted.sessionId).toBe(sessionId);

          // ... so a fresh GetSession reports the typed not-found tag.
          const response = yield* HttpClient.get(
            `${baseUrl}/session?sessionId=${sessionId}`,
          );
          const body = (yield* response.json) as { error?: string };
          expect(body.error).toBe("ResourceNotFoundException");
        }),
      { timeout: 120_000 },
    );
  });

  describe("RecognizeUtterance", () => {
    test.provider(
      "recognizes a text utterance and returns response metadata",
      () =>
        Effect.gen(function* () {
          const body = yield* call(
            HttpClientRequest.post(`${baseUrl}/utterance`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                text: "hello",
                sessionId: "alchemy-e2e-utterance",
              }),
            ),
          );
          expect(body.sessionId).toBe("alchemy-e2e-utterance");
          expect(body.contentType).toContain("text/plain");
        }),
      { timeout: 120_000 },
    );
  });
});
