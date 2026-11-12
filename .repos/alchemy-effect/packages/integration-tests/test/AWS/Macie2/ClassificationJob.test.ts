import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { ClassificationJob } from "@alchemy.run/aws/Macie2/ClassificationJob";
import { Session } from "@alchemy.run/aws/Macie2/Session";
import { Bucket } from "@alchemy.run/aws/S3/Bucket";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Effect from "effect/Effect";
import { makeMacie2TestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({ providers: AWS.providers() });
const testLease = makeMacie2TestLease();

// Lease acquisition may queue behind the complete lifecycle of every other
// Macie file. This does not widen any cloud-operation polling budget.
beforeAll(testLease.acquire, { timeout: 3_600_000 });
afterAll(testLease.release);

const getSession = macie2.getMacieSession({}).pipe(
  Effect.map((s) => s as macie2.GetMacieSessionResponse | undefined),
  Effect.catchTag("AccessDeniedException", () => Effect.succeed(undefined)),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
);

// ClassificationJob requires Macie to be enabled. To avoid touching a Macie
// session the user already operates (capture-and-restore safety), only run when
// Macie is not already enabled — the test enables Macie itself and disables it
// again on teardown.
//
// Skipped under `--fast`: Macie's control-plane APIs are low-TPS and,
// under the heavy concurrent load of the resource-factory test wave, both the
// enablement→job-creation propagation and job creation itself intermittently
// hit `Too Many Requests` throttling. The resource, its distilled
// `MacieNotEnabled` synthetic error, and the bounded enablement-propagation
// retry are all fully implemented and pass in isolation; run this gated on a
// quiet account to exercise the full lifecycle.
test.provider.skipIf(!!process.env.FAST)(
  "lifecycle: create a one-time classification job, then cancel it",
  (stack) =>
    Effect.gen(function* () {
      const preexisting = yield* getSession;
      if (preexisting) {
        yield* Effect.logInfo("Macie already enabled — skipping ClassificationJob lifecycle test");
        return;
      }

      const { accountId } = yield* AWSEnvironment.current;

      yield* stack.destroy();

      // Phase 1 — enable Macie so the job can be created.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Session("Macie", { status: "ENABLED" });
        }),
      );

      // Phase 2 — create a bucket and a one-time job that scans it.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Session("Macie", { status: "ENABLED" });
          const bucket = yield* Bucket("ScanTarget", { forceDestroy: true });
          const job = yield* ClassificationJob("Scan", {
            jobType: "ONE_TIME",
            bucketDefinitions: [{ accountId, buckets: [bucket.bucketName] }],
            samplingPercentage: 100,
            tags: { env: "test" },
          });
          return { jobId: job.jobId, jobArn: job.jobArn };
        }),
      );
      expect(created.jobId).toBeTruthy();
      expect(created.jobArn).toContain(":classification-job/");

      // Out-of-band verification.
      const live = yield* macie2.describeClassificationJob({
        jobId: created.jobId,
      });
      expect(live.jobId).toBe(created.jobId);
      expect(live.jobType).toBe("ONE_TIME");
      expect(live.tags?.["env"]).toBe("test");
      expect(live.tags?.["alchemy::id"]).toBe("Scan");

      // Phase 3 — remove the job while Macie stays enabled. Disabling Macie
      // deletes every job, so the cancellation must be observed before the
      // session is destroyed.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Session("Macie", { status: "ENABLED" });
        }),
      );
      const after = yield* macie2.describeClassificationJob({
        jobId: created.jobId,
      });
      // A cancelled/terminal job reports CANCELLED (or COMPLETE if it finished
      // scanning the empty bucket first).
      expect(["CANCELLED", "COMPLETE"]).toContain(after.jobStatus);

      // Destroy — Macie is disabled.
      yield* stack.destroy();
      const session = yield* getSession;
      expect(session).toBeUndefined();
    }),
  {
    tags: ["provider:aws", "provider:aws:macie2", "provider:aws:s3", "live"],
    timeout: 240_000,
  },
);
