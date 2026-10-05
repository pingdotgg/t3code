import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  scheduler.getProjectsLocationsJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, replace, and delete a scheduler job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudScheduler.Job("Ping", {
            schedule: "0 0 1 1 *",
            timeZone: "UTC",
            description: "ping",
            httpTarget: {
              uri: "https://example.com/",
              httpMethod: "GET",
            },
          });
        }),
      );

      expect(created.jobId).toEqual(expect.any(String));
      expect(created.name).toContain("/jobs/");
      expect(created.location).toEqual("us-central1");
      expect(created.schedule).toEqual("0 0 1 1 *");
      expect(created.timeZone).toEqual("UTC");
      expect(created.description).toEqual("ping");
      expect(created.paused).toEqual(false);
      expect(created.httpTarget?.uri).toEqual("https://example.com/");
      expect(created.httpTarget?.httpMethod).toEqual("GET");

      const fetched = yield* scheduler.getProjectsLocationsJobs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.schedule).toEqual("0 0 1 1 *");
      expect(fetched.state).toEqual("ENABLED");
      expect(fetched.description).toEqual("ping");
      expect(fetched.httpTarget?.uri).toEqual("https://example.com/");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudScheduler.Job("Ping", {
            jobId: created.jobId,
            location: "us-central1",
            schedule: "0 0 1 2 *",
            timeZone: "America/Chicago",
            description: "ping v2",
            paused: true,
            retryConfig: { retryCount: 2 },
            httpTarget: {
              uri: "https://example.com/health",
              httpMethod: "GET",
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.jobId).toEqual(created.jobId);
      expect(updated.schedule).toEqual("0 0 1 2 *");
      expect(updated.timeZone).toEqual("America/Chicago");
      expect(updated.description).toEqual("ping v2");
      expect(updated.retryConfig?.retryCount).toEqual(2);
      expect(updated.paused).toEqual(true);
      expect(updated.httpTarget?.uri).toEqual("https://example.com/health");

      const fetchedUpdate = yield* scheduler.getProjectsLocationsJobs({
        name: updated.name,
      });
      expect(fetchedUpdate.schedule).toEqual("0 0 1 2 *");
      expect(fetchedUpdate.timeZone).toEqual("America/Chicago");
      expect(fetchedUpdate.retryConfig?.retryCount).toEqual(2);
      expect(fetchedUpdate.httpTarget?.uri).toEqual(
        "https://example.com/health",
      );
      expect(fetchedUpdate.state).toEqual("PAUSED");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudScheduler.Job("Ping", {
            jobId: created.jobId,
            location: "us-east1",
            schedule: "0 0 1 1 *",
            httpTarget: {
              uri: "https://example.com/",
              httpMethod: "GET",
            },
          });
        }),
      );

      expect(replaced.jobId).toEqual(created.jobId);
      expect(replaced.location).toEqual("us-east1");
      expect(replaced.name).toContain("/locations/us-east1/");
      expect(replaced.name).not.toEqual(created.name);

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      const fetchedReplace = yield* scheduler.getProjectsLocationsJobs({
        name: replaced.name,
      });
      expect(fetchedReplace.name).toEqual(replaced.name);
      expect(fetchedReplace.state).toEqual("ENABLED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudscheduler", "live"],
    timeout: 120_000,
  },
);
