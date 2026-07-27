import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as S3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import BucketEventSourceFunctionLive, {
  BucketEventSourceFunction,
} from "./fixtures/event-source-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "S3EventSource");

// Lambda function URL cold-start plus IAM propagation can take well over a
// minute on a fresh deploy under parallel-suite load. Budget ~150s.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let fixtureBucketName: string | undefined;

describe("S3 Bucket Event Source", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "S3 EventSource test: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("S3 EventSource test: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* BucketEventSourceFunction;
        }).pipe(Effect.provide(BucketEventSourceFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* Effect.logInfo(
        `S3 EventSource test: function URL ready (${functionUrl}), probing readiness`,
      );

      // A missing key returns 404 via the NoSuchKey path — that's the
      // signal the handler is reachable.
      yield* HttpClient.get(`${baseUrl}/processed?key=__ready__`).pipe(
        Effect.flatMap((response) =>
          response.status === 404 || response.status === 200
            ? Effect.succeed(response)
            : response.text.pipe(
                Effect.flatMap((body) =>
                  Effect.fail(
                    new FunctionNotReady({
                      status: response.status,
                      body,
                    }),
                  ),
                ),
              ),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `S3 EventSource test: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      yield* Effect.logInfo(
        "S3 EventSource test: fixture responded successfully",
      );

      // Capture the fixture's bucket name so afterAll can assert it is
      // really gone after the trailing destroy. The route answers 503 until
      // resource Outputs hydrate, so retry through that window.
      const named = yield* HttpClient.get(`${baseUrl}/bucket-name`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(
                new Error(`bucket-name not ready: ${response.status}`),
              ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      fixtureBucketName = (named as { bucketName: string }).bucketName;
      expect(fixtureBucketName).toBeTruthy();
    }),
    { timeout: 240_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Prove the trailing destroy removed the fixture bucket (skip if
      // setup never captured the name). afterAll lacks the providers layer
      // test bodies get, so provide it for the out-of-band distilled call.
      if (fixtureBucketName) {
        yield* Core.withProviders(
          assertBucketDeleted(fixtureBucketName),
          testOptions,
          "S3EventSource",
        );
      }
    }),
    { timeout: 120_000 },
  );

  test.provider(
    "object created under the watched prefix triggers the subscription to write derived state",
    (_stack) =>
      Effect.gen(function* () {
        const key = "e2e-object";

        // Trigger: write an object under `incoming/`, which the Lambda
        // event-source subscription should observe.
        const putResponse = yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { key, value: "hello from s3 event source" },
          ),
        ).pipe(Effect.flatMap((r) => r.json));
        expect(putResponse).toHaveProperty("ok", true);

        // Poll the `/processed` route until the subscription has written the
        // derived object. S3 -> Lambda notification delivery is eventually
        // consistent, so retry with a generous budget.
        const fetchProcessed = Effect.gen(function* () {
          const response = yield* HttpClient.get(
            `${baseUrl}/processed?key=${encodeURIComponent(key)}`,
          );
          if (response.status !== 200) {
            return yield* Effect.fail(new ProcessedNotReady());
          }
          const body = (yield* response.json) as { processed: unknown };
          if (!body.processed) {
            return yield* Effect.fail(new ProcessedNotReady());
          }
          return body.processed as ProcessedRecord;
        });

        const processed = yield* fetchProcessed.pipe(
          Effect.retry({
            while: (error) => error._tag === "ProcessedNotReady",
            schedule: Schedule.max([
              Schedule.fixed("5 seconds"),
              Schedule.recurs(48),
            ]),
          }),
        );

        expect(processed.key).toBe(`incoming/${key}`);
        expect(processed.size).toBeGreaterThan(0);
        expect(processed.eTag).toBeTruthy();
      }),
    { timeout: 600_000 },
  );
});

interface ProcessedRecord {
  key: string;
  size: number;
  eTag: string;
}

class ProcessedNotReady extends Data.TaggedError("ProcessedNotReady") {}

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

// Out-of-band assert-gone after the final destroy: retry while headBucket
// still succeeds (S3 delete visibility is eventually consistent), settle on
// the typed NotFound.
const assertBucketDeleted = Effect.fn(function* (name: string) {
  yield* S3.headBucket({ Bucket: name }).pipe(
    Effect.flatMap(() => Effect.fail(new BucketStillExists())),
    Effect.retry({
      while: (e) => e._tag === "BucketStillExists",
      schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(10)]),
    }),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catch(() => Effect.void),
  );
});

class FunctionNotReady extends Data.TaggedError("FunctionNotReady")<{
  readonly status: number;
  readonly body: string;
}> {}
