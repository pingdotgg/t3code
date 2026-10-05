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
  aiplatform.getProjectsLocationsTuningJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsTuningJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsTuningJobs({
          name: `${parent}/tuningJobs/1234567890123456789`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page = yield* aiplatform.listProjectsLocationsTuningJobs({
        parent,
        pageSize: 10,
      });
      expect((page.tuningJobs ?? []).map((item) => item.name)).not.toContain(
        `${parent}/tuningJobs/1234567890123456789`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create and cancel a tuning job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AIPlatform.TuningJob("Tune", {
            location: "us-central1",
            baseModel: "gemini-2.5-flash",
            supervisedTuningSpec: {
              trainingDatasetUri:
                "gs://cloud-samples-data/ai-platform/tuning/sft_train.jsonl",
            },
          });
        }),
      );

      expect(created.name.length).toBeGreaterThan(0);
      const live = yield* aiplatform.getProjectsLocationsTuningJobs({
        name: created.name,
      });
      expect(live.name).toBe(created.name);

      yield* stack.destroy();
      yield* waitUntilGone(created.name);
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 120_000,
  },
);
