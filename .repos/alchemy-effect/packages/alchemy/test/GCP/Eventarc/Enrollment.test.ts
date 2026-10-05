import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as eventarc from "@distilled.cloud/gcp/eventarc_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Enrollment depends on a Pipeline, whose create/update/delete LROs take
// over 15 minutes end to end.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;
const LOCATION = "europe-west1";

const waitUntilGone = (name: string) =>
  eventarc.getProjectsLocationsEnrollments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsEnrollments on a missing enrollment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        eventarc.getProjectsLocationsEnrollments({
          name: `projects/${project}/locations/${LOCATION}/enrollments/alchemy-missing-enrollment`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:eventarc", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an Eventarc enrollment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bus = yield* GCP.Eventarc.MessageBus("Events", {
            location: LOCATION,
            labels: { env: "test" },
          });
          const pipeline = yield* GCP.Eventarc.Pipeline("Forward", {
            location: LOCATION,
            destinations: [{ messageBus: bus.name }],
            labels: { env: "test" },
          });
          const enrollment = yield* GCP.Eventarc.Enrollment("All", {
            location: LOCATION,
            messageBus: bus.name,
            destination: pipeline.name,
            celMatch: "true",
            displayName: "all events",
            labels: { env: "test" },
          });
          return { bus, pipeline, enrollment };
        }),
      );

      expect(created.enrollment.name).toContain("/enrollments/");
      expect(created.enrollment.enrollmentId).toEqual(expect.any(String));
      expect(created.enrollment.location).toEqual(LOCATION);
      expect(created.enrollment.celMatch).toEqual("true");
      expect(created.enrollment.messageBus).toEqual(created.bus.name);
      expect(created.enrollment.destination).toEqual(created.pipeline.name);
      expect(created.enrollment.labels).toMatchObject({ env: "test" });

      const fetched = yield* eventarc.getProjectsLocationsEnrollments({
        name: created.enrollment.name,
      });
      expect(fetched.name).toEqual(created.enrollment.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.celMatch).toEqual("true");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bus = yield* GCP.Eventarc.MessageBus("Events", {
            messageBusId: created.bus.messageBusId,
            location: LOCATION,
            labels: { env: "test" },
          });
          const pipeline = yield* GCP.Eventarc.Pipeline("Forward", {
            pipelineId: created.pipeline.pipelineId,
            location: LOCATION,
            destinations: [{ messageBus: bus.name }],
            labels: { env: "test" },
          });
          return yield* GCP.Eventarc.Enrollment("All", {
            enrollmentId: created.enrollment.enrollmentId,
            location: LOCATION,
            messageBus: bus.name,
            destination: pipeline.name,
            celMatch:
              "message.type == 'google.cloud.pubsub.topic.v1.messagePublished'",
            displayName: "pubsub only",
            labels: { env: "prod", role: "enrollment" },
          });
        }),
      );

      expect(updated.name).toEqual(created.enrollment.name);
      expect(updated.enrollmentId).toEqual(created.enrollment.enrollmentId);
      expect(updated.displayName).toEqual("pubsub only");
      expect(updated.labels).toMatchObject({
        env: "prod",
        role: "enrollment",
      });
      expect(updated.celMatch).toContain("messagePublished");

      const refetched = yield* eventarc.getProjectsLocationsEnrollments({
        name: created.enrollment.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("enrollment");
      expect(refetched.displayName).toEqual("pubsub only");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.enrollment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:eventarc", "live"],
    timeout: 2_400_000,
  },
);
