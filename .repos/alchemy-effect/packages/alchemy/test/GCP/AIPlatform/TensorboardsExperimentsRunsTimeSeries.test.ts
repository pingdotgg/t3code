import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
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
  aiplatform
    .getProjectsLocationsTensorboardsExperimentsRunsTimeSeries({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsTensorboardsExperimentsRunsTimeSeries on a missing series fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsTensorboardsExperimentsRunsTimeSeries({
          name: `projects/${project}/locations/us-central1/tensorboards/1234567890123456789/experiments/alchemy-missing/runs/alchemy-missing/timeSeries/1234567890123456789`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a tensorboard time series",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const board = yield* GCP.AIPlatform.Tensorboard("Board", {
            location: "us-central1",
            displayName: "alchemy-ts-board",
            labels: { env: "test" },
          });
          const experiment = yield* GCP.AIPlatform.TensorboardsExperiment(
            "Group",
            {
              parent: board.name,
              displayName: "ts-group",
              labels: { env: "test" },
            },
          );
          const run = yield* GCP.AIPlatform.TensorboardsExperimentsRun("Pass", {
            parent: experiment.name,
            displayName: "ts-pass",
            labels: { env: "test" },
          });
          return yield* GCP.AIPlatform.TensorboardsExperimentsRunsTimeSeries(
            "Loss",
            {
              parent: run.name,
              displayName: "loss",
              description: "training loss",
              valueType: "SCALAR",
              pluginName: "scalars",
            },
          );
        }),
      );

      expect(created.name).toContain("/timeSeries/");
      expect(created.valueType).toEqual("SCALAR");
      expect(created.description).toEqual("training loss");

      const fetched =
        yield* aiplatform.getProjectsLocationsTensorboardsExperimentsRunsTimeSeries(
          { name: created.name },
        );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const board = yield* GCP.AIPlatform.Tensorboard("Board", {
            location: "us-central1",
            displayName: "alchemy-ts-board",
            labels: { env: "test" },
          });
          const experiment = yield* GCP.AIPlatform.TensorboardsExperiment(
            "Group",
            {
              parent: board.name,
              displayName: "ts-group",
              labels: { env: "test" },
            },
          );
          const run = yield* GCP.AIPlatform.TensorboardsExperimentsRun("Pass", {
            parent: experiment.name,
            displayName: "ts-pass",
            labels: { env: "test" },
          });
          return yield* GCP.AIPlatform.TensorboardsExperimentsRunsTimeSeries(
            "Loss",
            {
              parent: run.name,
              timeSeriesId: created.timeSeriesId,
              displayName: "loss-v2",
              description: "training loss v2",
              valueType: "SCALAR",
              pluginName: "scalars",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("training loss v2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 120_000,
  },
);
