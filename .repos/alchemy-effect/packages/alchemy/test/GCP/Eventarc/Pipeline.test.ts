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

// Pipeline create/update/delete LROs take ~14 minutes end to end.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;
const LOCATION = "europe-west3";

const waitUntilGone = (name: string) =>
  eventarc.getProjectsLocationsPipelines({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsPipelines on a missing pipeline fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        eventarc.getProjectsLocationsPipelines({
          name: `projects/${project}/locations/${LOCATION}/pipelines/alchemy-missing-pipeline`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:eventarc", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an Eventarc pipeline",
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
            displayName: "forward",
            labels: { env: "test" },
          });
          return { bus, pipeline };
        }),
      );

      expect(created.pipeline.name).toContain("/pipelines/");
      expect(created.pipeline.pipelineId).toEqual(expect.any(String));
      expect(created.pipeline.location).toEqual(LOCATION);
      expect(created.pipeline.labels).toMatchObject({ env: "test" });
      expect(created.pipeline.destinations[0]?.messageBus).toEqual(
        created.bus.name,
      );

      const fetched = yield* eventarc.getProjectsLocationsPipelines({
        name: created.pipeline.name,
      });
      expect(fetched.name).toEqual(created.pipeline.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.destinations?.[0]?.messageBus).toEqual(created.bus.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bus = yield* GCP.Eventarc.MessageBus("Events", {
            messageBusId: created.bus.messageBusId,
            location: LOCATION,
            labels: { env: "test" },
          });
          return yield* GCP.Eventarc.Pipeline("Forward", {
            pipelineId: created.pipeline.pipelineId,
            location: LOCATION,
            destinations: [{ messageBus: bus.name }],
            displayName: "forward-v2",
            retryPolicy: { maxAttempts: 8 },
            labels: { env: "prod", role: "pipeline" },
          });
        }),
      );

      expect(updated.name).toEqual(created.pipeline.name);
      expect(updated.pipelineId).toEqual(created.pipeline.pipelineId);
      expect(updated.displayName).toEqual("forward-v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "pipeline" });
      expect(updated.retryPolicy?.maxAttempts).toEqual(8);

      const refetched = yield* eventarc.getProjectsLocationsPipelines({
        name: created.pipeline.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("pipeline");
      expect(refetched.displayName).toEqual("forward-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.pipeline.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:eventarc", "live"],
    timeout: 2_400_000,
  },
);
