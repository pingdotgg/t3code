import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HELLO_PNG_TEXT } from "./constants.ts";
import TextractTestFunctionLive, { TextractTestFunction } from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "TextractBindings");

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

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation, upstream throttling surfaced as a defect).
// Retry 5xx only; a genuine 4xx/assertion failure surfaces immediately.
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

const getJson = <T>(path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
    Effect.map((body) => body as T),
  );

const postJson = <T>(path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
    Effect.map((body) => body as T),
  );

/** Poll an async job's get route until it leaves IN_PROGRESS (bounded). */
const pollJob = <T extends { jobStatus?: string }>(
  path: string,
  jobId: string,
) =>
  getJson<T>(`${path}?jobId=${jobId}`).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (r): boolean =>
        r.jobStatus !== undefined && r.jobStatus !== "IN_PROGRESS",
      times: 40,
    }),
  );

describe("Textract Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Textract test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Textract test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* TextractTestFunction;
        }).pipe(Effect.provide(TextractTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* Effect.logInfo("Textract test setup: probing readiness");
      yield* HttpClient.get(`${baseUrl}/ping`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );

      // Seed the S3 input object the async Start* routes analyze.
      const seeded = yield* postJson<{ seeded: boolean }>("/seed");
      expect(seeded.seeded).toBe(true);
    }),
    { timeout: 240_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 180_000,
  });

  describe("synchronous analysis", () => {
    test.provider(
      "AnalyzeDocument detects the rendered text",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson<{
            pages?: number;
            lines: string[];
          }>("/analyze-document");
          expect(response.pages).toBe(1);
          expect(response.lines).toContain(HELLO_PNG_TEXT);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "AnalyzeExpense analyzes the document as a receipt",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson<{
            pages?: number;
            expenseDocuments: number;
          }>("/analyze-expense");
          expect(response.pages).toBe(1);
          expect(response.expenseDocuments).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "AnalyzeID analyzes the document as an identity document",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson<{
            identityDocuments: number;
          }>("/analyze-id");
          expect(response.identityDocuments).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 120_000 },
    );
  });

  describe("asynchronous jobs", () => {
    test.provider(
      "StartDocumentTextDetection + GetDocumentTextDetection run to completion",
      (_stack) =>
        Effect.gen(function* () {
          const { jobId } = yield* postJson<{ jobId: string }>(
            "/start-text-detection",
          );
          expect(jobId).toBeTruthy();

          const result = yield* pollJob<{
            jobStatus?: string;
            lines: string[];
          }>("/get-text-detection", jobId);
          expect(result.jobStatus).toBe("SUCCEEDED");
          expect(result.lines).toContain(HELLO_PNG_TEXT);
        }),
      { timeout: 180_000 },
    );

    test.provider(
      "analysis, expense, and lending jobs run to completion",
      (_stack) =>
        Effect.gen(function* () {
          const [analysis, expense, lending] = yield* Effect.all(
            [
              postJson<{ jobId: string }>("/start-analysis"),
              postJson<{ jobId: string }>("/start-expense"),
              postJson<{ jobId: string }>("/start-lending"),
            ],
            { concurrency: 3 },
          );
          expect(analysis.jobId).toBeTruthy();
          expect(expense.jobId).toBeTruthy();
          expect(lending.jobId).toBeTruthy();

          const [analysisResult, expenseResult, lendingResult] =
            yield* Effect.all(
              [
                pollJob<{ jobStatus?: string; blocks: number }>(
                  "/get-analysis",
                  analysis.jobId,
                ),
                pollJob<{ jobStatus?: string; expenseDocuments: number }>(
                  "/get-expense",
                  expense.jobId,
                ),
                pollJob<{ jobStatus?: string; results: number }>(
                  "/get-lending",
                  lending.jobId,
                ),
              ],
              { concurrency: 3 },
            );
          expect(analysisResult.jobStatus).toBe("SUCCEEDED");
          expect(analysisResult.blocks).toBeGreaterThan(0);
          expect(expenseResult.jobStatus).toBe("SUCCEEDED");
          expect(lendingResult.jobStatus).toBe("SUCCEEDED");

          // Lending summary is available once the job completed.
          const summary = yield* getJson<{
            jobStatus?: string;
            documentGroups: number;
          }>(`/get-lending-summary?jobId=${lending.jobId}`);
          expect(summary.jobStatus).toBe("SUCCEEDED");
          expect(summary.documentGroups).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 240_000 },
    );
  });

  describe("adapter management", () => {
    test.provider(
      "GetAdapter, ListAdapters, and ListAdapterVersions read the deployed adapter",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson<{
            adapterName?: string;
            featureTypes?: string[];
            listed: (string | undefined)[];
            versionsCount: number;
          }>("/adapters");
          expect(response.adapterName).toBeTruthy();
          expect(response.featureTypes).toEqual(["QUERIES"]);
          expect(response.listed).toContain(response.adapterName);
          expect(response.versionsCount).toBe(0);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "adapter-version bindings surface typed errors (IAM grants proven)",
      (_stack) =>
        Effect.gen(function* () {
          const probes = yield* getJson<{
            getVersionProbe: string;
            deleteVersionProbe: string;
            createVersionProbe: string;
          }>("/adapter-version-probes");
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(probes.getVersionProbe);
          // DeleteAdapterVersion is idempotent — deleting a nonexistent
          // version succeeds (verified live), which proves the grant.
          expect([
            "success",
            "ResourceNotFoundException",
            "ValidationException",
            "ConflictException",
          ]).toContain(probes.deleteVersionProbe);
          expect([
            "InvalidS3ObjectException",
            "InvalidParameterException",
            "ValidationException",
            "LimitExceededException",
          ]).toContain(probes.createVersionProbe);
        }),
      { timeout: 120_000 },
    );
  });
});
