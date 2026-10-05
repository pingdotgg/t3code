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
  aiplatform.getProjectsLocationsStudies({ name }).pipe(
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
  "getProjectsLocationsStudies on a missing study fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsStudies({
          name: `projects/${project}/locations/us-central1/studies/1234567890123456789`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page = yield* aiplatform.listProjectsLocationsStudies({
        parent: `projects/${project}/locations/us-central1`,
        pageSize: 10,
      });
      expect((page.studies ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/locations/us-central1/studies/1234567890123456789`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create and delete a vizier study",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.Study("Tune", {
            location: "us-central1",
            displayName: "accuracy_search",
            studySpec,
          });
        }),
      );

      expect(created.name).toContain("/studies/");
      expect(created.displayName).toEqual("accuracy_search");
      expect(created.studySpec?.metrics?.[0]?.metricId).toEqual("accuracy");

      const fetched = yield* aiplatform.getProjectsLocationsStudies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("accuracy_search_alchemy_");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.Study("Tune", {
            location: "us-central1",
            displayName: "accuracy_search",
            studySpec,
          });
        }),
      );
      expect(updated.name).toEqual(created.name);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);
