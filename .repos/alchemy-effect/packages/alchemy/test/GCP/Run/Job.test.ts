import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { spawnSync } from "node:child_process";
import MarkerJob, { MARKER_OBJECT } from "./fixtures/job.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const dockerAvailable = (() => {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 })
        .status === 0
    );
  } catch {
    return false;
  }
})();

const IMAGE = "us-docker.pkg.dev/cloudrun/container/job:latest";

class JobRunNotReady extends Data.TaggedError("JobRunNotReady")<{
  reason: string;
}> {}

const waitUntilGone = (name: string) =>
  cloudrun.getProjectsLocationsJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Run.Job("Migrate", {
            location: "us-central1",
            labels: { env: "test" },
            containers: [{ image: IMAGE }],
          });
        }),
      );

      expect(created.name).toContain("/jobs/");
      expect(created.jobId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.image).toEqual(IMAGE);

      const fetched = yield* cloudrun.getProjectsLocationsJobs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.template?.template?.containers?.[0]?.image).toEqual(IMAGE);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Run.Job("Migrate", {
            jobId: created.jobId,
            location: "us-central1",
            labels: { env: "prod", role: "migrate" },
            maxRetries: 1,
            timeout: "120s",
            containers: [
              {
                image: IMAGE,
                env: [{ name: "STAGE", value: "prod" }],
              },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "migrate" });
      expect(updated.maxRetries).toEqual(1);
      expect(updated.timeout).toEqual("120s");

      const refetched = yield* cloudrun.getProjectsLocationsJobs({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("migrate");
      expect(refetched.template?.template?.maxRetries).toEqual(1);
      expect(refetched.template?.template?.timeout).toEqual("120s");
      expect(refetched.template?.template?.containers?.[0]?.env).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "STAGE", value: "prod" }),
        ]),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 120_000 },
);

test.provider.skipIf(!dockerAvailable)(
  "effect-native Job run writes a Storage object",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const job = yield* MarkerJob;
          return { name: job.name, project: job.project };
        }),
      );

      yield* cloudrun.runProjectsLocationsJobs({ name: out.name });

      const execution = yield* cloudrun
        .listProjectsLocationsJobsExecutions({
          parent: out.name,
          pageSize: 10,
        })
        .pipe(
          Effect.map((page) => page.executions?.[0]),
          Effect.filterOrFail(
            (item): item is cloudrun.GoogleCloudRunV2Execution =>
              item !== undefined &&
              (item.completionTime ?? "").length > 0 &&
              (item.succeededCount ?? 0) >= 1,
            (item) =>
              new JobRunNotReady({
                reason: item?.completionTime
                  ? `failed:${item.failedCount ?? 0}`
                  : "pending",
              }),
          ),
          Effect.retry({
            while: (error): error is JobRunNotReady =>
              error._tag === "JobRunNotReady" && error.reason === "pending",
            // Cloud Run schedules a fresh execution slowly: even Google's
            // sample job takes ~2 minutes to start in the test project.
            schedule: Schedule.spaced("10 seconds"),
            times: 36,
          }),
        );
      expect((execution.succeededCount ?? 0) >= 1).toEqual(true);

      const listed = yield* storage.listBuckets({
        project: out.project,
        maxResults: 1000,
      });
      const markerBucket = (listed.items ?? []).find((bucket) =>
        (bucket.labels?.["alchemy-id"] ?? "").includes("jobrunmarker"),
      );
      expect(markerBucket?.name).toEqual(expect.any(String));
      const object = yield* storage.getObjects({
        bucket: markerBucket!.name!,
        object: MARKER_OBJECT,
      });
      expect(object.name).toEqual(MARKER_OBJECT);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(out.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 540_000 },
);
