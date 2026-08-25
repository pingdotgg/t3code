import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HELLO_PNG_TEXT, TRANSLATE_TEXT } from "./constants.ts";
import AICapabilitiesTestFunctionLive, {
  AICapabilitiesTestFunction,
} from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AICapabilitiesBindings");

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
// parallel load (cold re-init, IAM propagation, upstream throttling surfaced
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

describe("AI Capabilities Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "AICapabilities test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("AICapabilities test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AICapabilitiesTestFunction;
        }).pipe(Effect.provide(AICapabilitiesTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `AICapabilities test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `AICapabilities test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("Rekognition.DetectLabels", () => {
    test.provider(
      "detects labels in checked-in image bytes",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/detect-labels`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            labels: string[];
            labelModelVersion?: string;
          };

          expect(Array.isArray(response.labels)).toBe(true);
          expect(response.labels.length).toBeGreaterThan(0);
          // The fixture image is rendered text — Rekognition consistently
          // labels it as textual content.
          expect(response.labels).toContain("Text");
        }),
      { timeout: 120_000 },
    );
  });

  describe("Textract.DetectDocumentText", () => {
    test.provider(
      "detects the rendered text in checked-in document bytes",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/detect-document-text`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            lines: string[];
            pages?: number;
          };

          expect(response.pages).toBe(1);
          expect(Array.isArray(response.lines)).toBe(true);
          expect(response.lines).toContain(HELLO_PNG_TEXT);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Polly.SynthesizeSpeech", () => {
    test.provider(
      "synthesizes text to non-empty mp3 audio bytes",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/synthesize-speech`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            contentType?: string;
            byteLength: number;
          };

          expect(response.contentType).toContain("audio/mpeg");
          expect(response.byteLength).toBeGreaterThan(1000);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Translate.TranslateText", () => {
    test.provider(
      "translates English to Spanish",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/translate-text`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            translatedText: string;
            sourceLanguageCode: string;
            targetLanguageCode: string;
          };

          expect(response.sourceLanguageCode).toBe("en");
          expect(response.targetLanguageCode).toBe("es");
          expect(response.translatedText.trim().length).toBeGreaterThan(0);
          expect(response.translatedText).not.toBe(TRANSLATE_TEXT);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Comprehend.DetectSentiment", () => {
    test.provider(
      "detects positive sentiment",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/detect-sentiment`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            sentiment?: string;
            sentimentScore?: { Positive?: number };
          };

          expect(["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED"]).toContain(
            response.sentiment,
          );
          // SENTIMENT_TEXT is unambiguously positive.
          expect(response.sentiment).toBe("POSITIVE");
          expect(response.sentimentScore?.Positive ?? 0).toBeGreaterThan(0.5);
        }),
      { timeout: 120_000 },
    );
  });
});
