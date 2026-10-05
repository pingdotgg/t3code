import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/gcp/ml_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, currentProject, region, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  ml.getProjectsModels({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsModels on a missing model fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        ml.getProjectsModels({
          name: `projects/${project}/models/alchemy-missing-model`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ml", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsModels is rejected with AiPlatformDeprecated",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.ML.Model("Classifier", {
              description: "probe",
              labels: { env: "test" },
              regions: [region],
            });
          }),
        ),
      );
      expect(error._tag).toEqual("AiPlatformDeprecated");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ml", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a model",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ML.Model("Classifier", {
            description: "image classifier",
            labels: { env: "test" },
            regions: [region],
          });
        }),
      );

      expect(created.name.startsWith(`projects/${project}/models/`)).toEqual(
        true,
      );
      expect(created.modelId.length).toBeGreaterThan(0);
      expect(created.description).toEqual("image classifier");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.regions).toEqual([region]);

      const fetched = yield* ml.getProjectsModels({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("image classifier");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ML.Model("Classifier", {
            modelId: created.modelId,
            description: "image classifier v2",
            labels: { env: "prod" },
            regions: [region],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("image classifier v2");

      const fetchedUpdate = yield* ml.getProjectsModels({
        name: created.name,
      });
      expect(fetchedUpdate.description).toContain("image classifier v2");
      expect(fetchedUpdate.description).toContain("alchemy-id=");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:ml", "live"], timeout: 90_000 },
);
