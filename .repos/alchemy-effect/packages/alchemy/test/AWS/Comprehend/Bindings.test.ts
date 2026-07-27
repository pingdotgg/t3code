import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ComprehendTestFunctionLive, { ComprehendTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ComprehendBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Freshly attached IAM policies propagate eventually; an early Comprehend
// call can surface AccessDenied as a 500 through the handler's orDie. Retry
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
      while: (e): boolean => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(6),
      ]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe("Comprehend Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Comprehend test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Comprehend test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ComprehendTestFunction;
        }).pipe(Effect.provide(ComprehendTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `Comprehend test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Comprehend test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 180_000 });

  describe("real-time analysis (DetectDominantLanguage, DetectEntities, DetectKeyPhrases, DetectPiiEntities, DetectSentiment, DetectSyntax, DetectTargetedSentiment, DetectToxicContent, ContainsPiiEntities)", () => {
    test.provider(
      "every single-document detect binding returns a real inference",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* getJson("/detect-all")) as {
            languageCode: string;
            entityTypes: string[];
            keyPhraseCount: number;
            piiTypes: string[];
            sentiment: string;
            syntaxTags: string[];
            targetedEntityCount: number;
            toxicity: number;
            piiLabels: string[];
          };

          // DetectDominantLanguage
          expect(result.languageCode).toBe("en");
          // DetectEntities — "Bob" is a PERSON, "Seattle" a LOCATION.
          expect(result.entityTypes).toContain("PERSON");
          expect(result.entityTypes).toContain("LOCATION");
          // DetectKeyPhrases
          expect(result.keyPhraseCount).toBeGreaterThan(0);
          // DetectPiiEntities — the text contains a name and an email.
          expect(result.piiTypes).toContain("NAME");
          expect(result.piiTypes).toContain("EMAIL");
          // DetectSentiment
          expect(result.sentiment).toBe("POSITIVE");
          // DetectSyntax — "cat" and "mat" are nouns.
          expect(result.syntaxTags).toContain("NOUN");
          // DetectTargetedSentiment — screen + battery entities.
          expect(result.targetedEntityCount).toBeGreaterThan(0);
          // DetectToxicContent — a compliment scores near zero.
          expect(result.toxicity).toBeLessThan(0.5);
          // ContainsPiiEntities
          expect(result.piiLabels).toContain("NAME");
        }),
      { timeout: 120_000 },
    );
  });

  describe("batch real-time analysis (BatchDetectDominantLanguage, BatchDetectEntities, BatchDetectKeyPhrases, BatchDetectSentiment, BatchDetectSyntax, BatchDetectTargetedSentiment)", () => {
    test.provider(
      "every batch detect binding returns index-aligned results",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* getJson("/batch-all")) as {
            languageResults: number;
            firstLanguage: string;
            entityResults: number;
            keyPhraseResults: number;
            sentimentResults: number;
            firstSentiment: string;
            syntaxResults: number;
            targetedResults: number;
          };

          expect(result.languageResults).toBe(2);
          expect(result.firstLanguage).toBe("en");
          expect(result.entityResults).toBe(1);
          expect(result.keyPhraseResults).toBe(2);
          expect(result.sentimentResults).toBe(2);
          expect(result.firstSentiment).toBe("POSITIVE");
          expect(result.syntaxResults).toBe(1);
          expect(result.targetedResults).toBe(1);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ClassifyDocument", () => {
    test.provider(
      "drives the typed ResourceUnavailableException path for a missing endpoint",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* getJson("/classify-document")) as {
            tag: string;
          };
          expect(result.tag).toBe("ResourceUnavailableException");
        }),
      { timeout: 120_000 },
    );
  });

  describe("List*Jobs (all nine families)", () => {
    test.provider(
      "every list binding returns a page",
      (_stack) =>
        Effect.gen(function* () {
          const counts = (yield* getJson("/jobs/list-all")) as Record<
            string,
            number
          >;
          for (const family of [
            "documentClassification",
            "dominantLanguage",
            "entities",
            "events",
            "keyPhrases",
            "piiEntities",
            "sentiment",
            "targetedSentiment",
            "topics",
          ]) {
            expect(counts[family]).toBeGreaterThanOrEqual(0);
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("Describe*Job (all nine families)", () => {
    test.provider(
      "every describe binding surfaces the typed JobNotFoundException",
      (_stack) =>
        Effect.gen(function* () {
          const tags = (yield* getJson(
            "/jobs/describe-not-found-all",
          )) as Record<string, string>;
          expect(tags).toEqual({
            documentClassification: "JobNotFoundException",
            dominantLanguage: "JobNotFoundException",
            entities: "JobNotFoundException",
            // Events detection is closed to new customers; entitled accounts
            // return JobNotFoundException instead.
            events: expect.stringMatching(
              /^(JobNotFoundException|NotAuthorizedException)$/,
            ),
            keyPhrases: "JobNotFoundException",
            piiEntities: "JobNotFoundException",
            sentiment: "JobNotFoundException",
            targetedSentiment: "JobNotFoundException",
            topics: "JobNotFoundException",
          });
        }),
      { timeout: 120_000 },
    );
  });

  describe("Stop*Job (all seven stoppable families)", () => {
    test.provider(
      "every stop binding surfaces the typed JobNotFoundException",
      (_stack) =>
        Effect.gen(function* () {
          const tags = (yield* postJson("/jobs/stop-not-found-all")) as Record<
            string,
            string
          >;
          expect(tags).toEqual({
            dominantLanguage: "JobNotFoundException",
            entities: "JobNotFoundException",
            // Events detection is closed to new customers — the stop path
            // hits the entitlement gate before the job lookup, surfacing the
            // (patched) typed NotAuthorizedException.
            events: expect.stringMatching(
              /^(JobNotFoundException|NotAuthorizedException)$/,
            ),
            keyPhrases: "JobNotFoundException",
            piiEntities: "JobNotFoundException",
            sentiment: "JobNotFoundException",
            targetedSentiment: "JobNotFoundException",
          });
        }),
      { timeout: 120_000 },
    );
  });

  describe("Start*Job (eight non-sentiment families)", () => {
    test.provider(
      "every start binding reaches Comprehend and surfaces the typed validation error",
      (_stack) =>
        Effect.gen(function* () {
          const tags = (yield* postJson("/jobs/start-invalid-all")) as Record<
            string,
            string
          >;
          // A missing IAM/PassRole grant would surface AccessDenied as a 500
          // (untyped, through orDie) — a typed server-side validation tag
          // proves role injection + the grant end-to-end.
          for (const [family, tag] of Object.entries(tags)) {
            expect(
              [
                "ValidationException",
                "InvalidRequestException",
                "ResourceNotFoundException",
                "NotAuthorizedException",
              ],
              `family ${family} returned ${tag}`,
            ).toContain(tag);
          }
          expect(Object.keys(tags).sort()).toEqual([
            "documentClassification",
            "dominantLanguage",
            "entities",
            "events",
            "keyPhrases",
            "piiEntities",
            "targetedSentiment",
            "topics",
          ]);
        }),
      { timeout: 120_000 },
    );
  });

  describe("StartSentimentDetectionJob + DescribeSentimentDetectionJob + StopSentimentDetectionJob", () => {
    test.provider(
      "runs a real async job lifecycle: start, describe, stop",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* postJson("/jobs/sentiment/lifecycle")) as {
            jobId: string;
            startStatus: string;
            describedStatus: string;
            stopStatus: string;
          };
          expect(result.jobId.length).toBeGreaterThan(0);
          expect(["SUBMITTED", "IN_PROGRESS"]).toContain(result.startStatus);
          expect(["SUBMITTED", "IN_PROGRESS"]).toContain(
            result.describedStatus,
          );
          expect(["STOP_REQUESTED", "STOPPED"]).toContain(result.stopStatus);
        }),
      { timeout: 120_000 },
    );
  });
});
