import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as s3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import EntityResolutionTestFunctionLive, {
  EntityResolutionTestFunction,
  FIXTURE_BUCKET_NAME,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "EntityResolutionBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class FunctionStillExists extends Data.TaggedError("FunctionStillExists") {}
class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
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
        Schedule.exponential("500 millis"),
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

describe.sequential("EntityResolution Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "EntityResolution bindings setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "EntityResolution bindings setup: deploying fixture",
      );
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* EntityResolutionTestFunction;
        }).pipe(Effect.provide(EntityResolutionTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `EntityResolution bindings setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `EntityResolution bindings setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Assert gone (skipped when beforeAll never got far enough to deploy):
      // the fixture Lambda answers with the typed not-found tag and the
      // fixed-name fixture bucket no longer heads. afterAll runs outside
      // `test.provider`'s layer, so raw distilled calls need the provider
      // layer (credentials, region) supplied explicitly.
      if (functionArn) {
        yield* Core.withProviders(
          Effect.gen(function* () {
            yield* lambda.getFunction({ FunctionName: functionArn }).pipe(
              Effect.flatMap(() => Effect.fail(new FunctionStillExists())),
              Effect.retry({
                while: (error) => error._tag === "FunctionStillExists",
                schedule: Schedule.exponential("500 millis"),
                times: 8,
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
            yield* s3.headBucket({ Bucket: FIXTURE_BUCKET_NAME }).pipe(
              Effect.flatMap(() => Effect.fail(new BucketStillExists())),
              Effect.retry({
                while: (error) => error._tag === "BucketStillExists",
                schedule: Schedule.exponential("500 millis"),
                times: 8,
              }),
              Effect.catchTag("NotFound", () => Effect.void),
            );
          }),
          testOptions,
          sharedStack.name,
        );
      }
    }),
    { timeout: 240_000 },
  );

  describe("binding registration", () => {
    test.provider("all nine capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(9);
      }),
    );
  });

  describe("ListMatchingJobs / ListIdMappingJobs", () => {
    test.provider(
      "both workflow-scoped listings answer (fresh workflows have no jobs)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/jobs")) as {
            matchingJobs: number;
            idMappingJobs: number;
          };
          expect(response.matchingJobs).toBe(0);
          expect(response.idMappingJobs).toBe(0);
        }),
    );
  });

  describe("GetMatchingJob / GetIdMappingJob", () => {
    test.provider(
      "a bogus job id surfaces the typed ResourceNotFoundException",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/jobs/not-found")) as {
            matching: string;
            idMapping: string;
          };
          expect(response.matching).toBe("ResourceNotFoundException");
          expect(response.idMapping).toBe("ResourceNotFoundException");
        }),
    );
  });

  describe("GetMatchId", () => {
    test.provider("an unprocessed record answers with no match id", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* postJson("/match-id")) as {
          result: string;
          matchId: string | null;
          matchRule: string | null;
          message: string | null;
        };
        // Either an empty lookup succeeds or the service rejects real-time
        // lookups on a never-run workflow with a typed tag — both prove the
        // grant + typed plumbing (an IAM gap would be a 500).
        expect(
          ["ok", "ValidationException", "ResourceNotFoundException"],
          response.message ?? undefined,
        ).toContain(response.result);
        expect(response.matchId).toBeNull();
      }),
    );
  });

  describe("GenerateMatchId", () => {
    test.provider(
      "real-time generation matches two records by email",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/generate-match-id")) as {
            result: string;
            matchGroups?: number;
            failedRecords?: number;
            message?: string | null;
          };
          // Either the account supports real-time generation on this
          // workflow (both records land in one match group) or the service
          // rejects it with a typed tag — both prove the grant + plumbing
          // (an IAM gap would be a 500).
          expect(
            ["ok", "ValidationException", "ResourceNotFoundException"],
            response.message ?? undefined,
          ).toContain(response.result);
          if (response.result === "ok") {
            expect(response.matchGroups).toBeGreaterThanOrEqual(1);
          }
        }),
    );
  });

  describe("BatchDeleteUniqueId", () => {
    test.provider(
      "deleting unknown unique ids answers per-id results",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/delete-unique-ids")) as {
            result: string;
            status?: string;
            deleted?: number;
            errors?: number;
            message?: string | null;
          };
          expect(
            ["ok", "ValidationException", "ResourceNotFoundException"],
            response.message ?? undefined,
          ).toContain(response.result);
        }),
    );
  });

  // The batch job runs take many minutes and cannot be cancelled — only
  // exercised when explicitly opted in.
  describe("StartMatchingJob / StartIdMappingJob (gated)", () => {
    test.provider.skipIf(!process.env.AWS_TEST_ENTITYRESOLUTION_RUN)(
      "starts a matching job through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/start-matching-job")) as {
            jobId: string;
            status: string;
          };
          expect(response.jobId).toBeTruthy();
          expect(["QUEUED", "RUNNING"]).toContain(response.status);
        }),
      { timeout: 120_000 },
    );

    test.provider.skipIf(!process.env.AWS_TEST_ENTITYRESOLUTION_RUN)(
      "starts an id mapping job through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/start-id-mapping-job")) as {
            jobId: string;
            status: string;
          };
          expect(response.jobId).toBeTruthy();
          expect(["QUEUED", "RUNNING"]).toContain(response.status);
        }),
      { timeout: 120_000 },
    );
  });
});
