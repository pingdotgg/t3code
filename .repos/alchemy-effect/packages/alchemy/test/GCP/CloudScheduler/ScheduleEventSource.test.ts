import * as GCP from "@/GCP";
import { makeObjectMedia } from "@/GCP/Storage/ObjectMedia.ts";
import * as Test from "@/Test/Alchemy";
import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { spawnSync } from "node:child_process";
import ScheduleService, {
  Markers,
  markerFor,
  SCHEDULE_BODY,
} from "./fixtures/schedule-service.ts";

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

test.provider.skipIf(!dockerAvailable)(
  "a Cloud Scheduler job invokes an effect-native Function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* ScheduleService;
          const bucket = yield* Markers;
          return {
            uri: service.uri,
            project: service.project,
            bucket: bucket.bucketName,
          };
        }),
      );

      // The job POSTs to the service with an OIDC token.
      const { jobs = [] } = yield* scheduler.listProjectsLocationsJobs({
        parent: `projects/${out.project}/locations/us-central1`,
        pageSize: 500,
      });
      const job = jobs.find((candidate) =>
        candidate.httpTarget?.uri?.startsWith(
          `${out.uri}/__alchemy/scheduler/`,
        ),
      );
      expect(job).toBeDefined();
      expect(job!.httpTarget?.httpMethod).toEqual("POST");
      expect(job!.httpTarget?.oidcToken?.serviceAccountEmail).toBeDefined();
      expect(job!.httpTarget?.oidcToken?.audience).toEqual(
        `${out.uri}/__alchemy/scheduler/heartbeat`,
      );

      // Force one run instead of waiting for the (yearly) cron. The job's
      // default retry policy redelivers until the host accepts it.
      const jobName = job!.name!.split("/").pop()!;
      const media = yield* makeObjectMedia;
      yield* scheduler.runProjectsLocationsJobs({ name: job!.name!, body: {} });
      const marker = yield* media
        .download({ bucket: out.bucket, object: markerFor(jobName) })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "GCP.Storage.ObjectNotFound",
            schedule: Schedule.spaced("5 seconds"),
            times: 48,
          }),
        );
      const event = JSON.parse(new TextDecoder().decode(marker.body));
      expect(event.jobName).toEqual(jobName);
      expect(event.body).toEqual(SCHEDULE_BODY);
      expect(event.scheduleTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      yield* stack.destroy();

      const gone = yield* scheduler
        .getProjectsLocationsJobs({ name: job!.name! })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudscheduler", "live"],
    timeout: 600_000,
  },
);
