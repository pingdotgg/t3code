import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import TranslateTestFunctionLive, {
  TERMINOLOGY_NAME,
  TranslateTestFunction,
} from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "TranslateBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation). Retry only 5xx; a genuine 4xx/assertion
// failure surfaces immediately.
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
        Schedule.exponential("2 seconds"),
        Schedule.recurs(5),
      ]),
    }),
  );

describe.sequential("Translate Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Translate test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Translate test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* TranslateTestFunction;
        }).pipe(Effect.provide(TranslateTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/ping`;
      yield* Effect.logInfo(
        `Translate test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Translate test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 180_000,
  });

  describe("TranslateText", () => {
    test.provider(
      "translates text and applies the fixture terminology",
      (_stack) =>
        Effect.gen(function* () {
          // A freshly imported terminology can take a moment to propagate to
          // TranslateText — poll the route (bounded) until the custom term
          // lands in the translation.
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/translate`),
          ).pipe(
            Effect.flatMap((r) => r.json),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (r): boolean =>
                (r as { withTerminology?: string }).withTerminology?.includes(
                  "Alquimia",
                ) === true,
              times: 8,
            }),
          )) as {
            error?: string;
            basic: string;
            withTerminology: string;
            appliedTerminologies: string[];
          };

          expect(response.error).toBeUndefined();
          expect(response.basic.toLowerCase()).toContain("hola");
          expect(response.withTerminology).toContain("Alquimia");
          expect(response.appliedTerminologies).toContain(TERMINOLOGY_NAME);
        }),
      { timeout: 180_000 },
    );
  });

  describe("TranslateDocument", () => {
    test.provider(
      "translates a plain-text document and decodes the redacted content",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/document`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            translated: string;
            sourceLanguageCode: string;
            targetLanguageCode: string;
          };

          expect(response.error).toBeUndefined();
          expect(response.translated.toLowerCase()).toContain("buenos");
          expect(response.sourceLanguageCode).toBe("en");
          expect(response.targetLanguageCode).toBe("es");
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListLanguages", () => {
    test.provider(
      "lists supported languages including Spanish",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/languages`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            count: number;
            codes: string[];
          };

          expect(response.error).toBeUndefined();
          expect(response.count).toBeGreaterThan(10);
          expect(response.codes).toContain("es");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetTerminology + ListTerminologies", () => {
    test.provider(
      "reads the fixture glossary and lists it",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/terminologies`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            name: string | null;
            termCount: number | null;
            sourceLanguageCode: string | null;
            downloadLocation: string | null;
            listedNames: string[];
          };

          expect(response.error).toBeUndefined();
          expect(response.name).toBe(TERMINOLOGY_NAME);
          expect(response.termCount).toBe(1);
          expect(response.sourceLanguageCode).toBe("en");
          expect(response.listedNames).toContain(TERMINOLOGY_NAME);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListParallelData + GetParallelData", () => {
    test.provider(
      "lists parallel data and drives the typed not-found path",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/parallel-data`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            listedCount: number;
            missingTag: string;
          };

          expect(response.error).toBeUndefined();
          expect(response.listedCount).toBeGreaterThanOrEqual(0);
          expect(response.missingTag).toBe("ResourceNotFoundException");
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListTextTranslationJobs + Describe/Stop not-found", () => {
    test.provider(
      "lists jobs and drives the typed not-found paths",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/jobs`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            listedCount: number;
            describeTag: string;
            stopTag: string;
          };

          expect(response.error).toBeUndefined();
          expect(response.listedCount).toBeGreaterThanOrEqual(0);
          expect(response.describeTag).toBe("ResourceNotFoundException");
          expect(response.stopTag).toBe("ResourceNotFoundException");
        }),
      { timeout: 120_000 },
    );
  });

  describe("StartTextTranslationJob + DescribeTextTranslationJob + StopTextTranslationJob", () => {
    test.provider(
      "starts a real batch job, describes it, and stops it",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/job-lifecycle`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            jobId: string;
            startStatus: string | null;
            describedStatus: string | null;
            stopStatus: string | null;
          };

          expect(response.error).toBeUndefined();
          expect(response.jobId).toMatch(/^[0-9a-f]{32}$/);
          expect(["SUBMITTED", "IN_PROGRESS"]).toContain(response.startStatus);
          expect(response.describedStatus).toBeTruthy();
          expect([
            "STOP_REQUESTED",
            "STOPPED",
            "COMPLETED",
            "SUBMITTED",
            "IN_PROGRESS",
          ]).toContain(response.stopStatus);
        }),
      { timeout: 120_000 },
    );
  });
});
