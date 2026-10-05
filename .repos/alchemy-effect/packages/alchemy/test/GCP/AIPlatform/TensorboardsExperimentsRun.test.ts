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
  aiplatform.getProjectsLocationsTensorboardsExperimentsRuns({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsTensorboardsExperimentsRuns on a missing run fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsTensorboardsExperimentsRuns({
          name: `projects/${project}/locations/us-central1/tensorboards/1234567890123456789/experiments/alchemy-missing/runs/alchemy-missing`,
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
  "create, update, and delete a tensorboard run",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const board = yield* GCP.AIPlatform.Tensorboard("Board", {
            location: "us-central1",
            displayName: "alchemy-run-board",
            labels: { env: "test" },
          });
          const experiment = yield* GCP.AIPlatform.TensorboardsExperiment(
            "Group",
            {
              parent: board.name,
              displayName: "run-group",
              labels: { env: "test" },
            },
          );
          return yield* GCP.AIPlatform.TensorboardsExperimentsRun("Pass", {
            parent: experiment.name,
            displayName: "pass-1",
            description: "first",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/runs/");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* aiplatform.getProjectsLocationsTensorboardsExperimentsRuns({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const board = yield* GCP.AIPlatform.Tensorboard("Board", {
            location: "us-central1",
            displayName: "alchemy-run-board",
            labels: { env: "test" },
          });
          const experiment = yield* GCP.AIPlatform.TensorboardsExperiment(
            "Group",
            {
              parent: board.name,
              displayName: "run-group",
              labels: { env: "test" },
            },
          );
          return yield* GCP.AIPlatform.TensorboardsExperimentsRun("Pass", {
            parent: experiment.name,
            runId: created.runId,
            displayName: "pass-2",
            description: "second",
            labels: { env: "prod" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("second");
      expect(updated.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 120_000,
  },
);
