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
  aiplatform.getProjectsLocationsEvaluationSets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsEvaluationSets on a missing set fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        aiplatform.getProjectsLocationsEvaluationSets({
          name: `${parent}/evaluationSets/1234567890123456789`,
        }),
      );
      expect(error._tag).toEqual("NotFound");
      const page = yield* aiplatform.listProjectsLocationsEvaluationSets({
        parent,
        pageSize: 10,
      });
      expect(
        (page.evaluationSets ?? []).map((item) => item.name),
      ).not.toContain(`${parent}/evaluationSets/1234567890123456789`);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a vertex evaluation set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const item = yield* GCP.AIPlatform.EvaluationItem("Prompt", {
            location: "us-central1",
            displayName: "alchemy-eval-set-item",
            evaluationItemType: "REQUEST",
            evaluationRequest: { prompt: { text: "What is 2+2?" } },
            labels: { env: "test" },
          });
          const set = yield* GCP.AIPlatform.EvaluationSet("Prompts", {
            location: "us-central1",
            displayName: "alchemy-eval-set",
            evaluationItems: [item.name],
          });
          return { item, set };
        }),
      );

      expect(created.set.name).toContain("/evaluationSets/");
      expect(created.set.location).toEqual("us-central1");
      expect(created.set.evaluationItems).toContain(created.item.name);

      const fetched = yield* aiplatform.getProjectsLocationsEvaluationSets({
        name: created.set.name,
      });
      expect(fetched.name).toEqual(created.set.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const item = yield* GCP.AIPlatform.EvaluationItem("Prompt", {
            evaluationItemId: created.item.evaluationItemId,
            location: "us-central1",
            displayName: "alchemy-eval-set-item",
            evaluationItemType: "REQUEST",
            evaluationRequest: { prompt: { text: "What is 2+2?" } },
            labels: { env: "test" },
          });
          const second = yield* GCP.AIPlatform.EvaluationItem("Followup", {
            location: "us-central1",
            displayName: "alchemy-eval-set-item-2",
            evaluationItemType: "REQUEST",
            evaluationRequest: { prompt: { text: "What is 3+3?" } },
            labels: { env: "test" },
          });
          const set = yield* GCP.AIPlatform.EvaluationSet("Prompts", {
            evaluationSetId: created.set.evaluationSetId,
            location: "us-central1",
            displayName: "alchemy-eval-set",
            evaluationItems: [item.name, second.name],
          });
          return { item, second, set };
        }),
      );

      expect(updated.set.name).toEqual(created.set.name);
      expect(updated.set.evaluationItems).toContain(updated.second.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.set.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 180_000,
  },
);
