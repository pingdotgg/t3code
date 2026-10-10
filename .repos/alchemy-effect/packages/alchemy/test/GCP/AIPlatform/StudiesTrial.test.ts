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
  aiplatform.getProjectsLocationsStudiesTrials({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const studySpec = {
  metrics: [{ metricId: "accuracy", goal: "MAXIMIZE" as const }],
  parameters: [
    {
      parameterId: "learning_rate",
      doubleValueSpec: { minValue: 0.001, maxValue: 0.1 },
    },
  ],
  algorithm: "RANDOM_SEARCH" as const,
};

test.provider(
  "getProjectsLocationsStudiesTrials on a missing trial fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsStudiesTrials({
          name: `projects/${project}/locations/us-central1/studies/1234567890123456789/trials/1`,
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
  "create and delete a user-provided vizier trial",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const study = yield* GCP.AIPlatform.Study("Tune", {
            location: "us-central1",
            displayName: "trial_search",
            studySpec,
          });
          return yield* GCP.AIPlatform.StudiesTrial("Seed", {
            parent: study.name,
            parameters: [{ parameterId: "learning_rate", value: 0.01 }],
          });
        }),
      );

      expect(created.name).toContain("/trials/");
      expect(created.parameters[0]?.parameterId).toEqual("learning_rate");

      const fetched = yield* aiplatform.getProjectsLocationsStudiesTrials({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);
