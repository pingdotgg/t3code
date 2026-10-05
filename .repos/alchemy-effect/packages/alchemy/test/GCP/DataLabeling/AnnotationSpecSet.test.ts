import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datalabeling from "@distilled.cloud/gcp/datalabeling_v1beta1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  probe,
  currentProject,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsAnnotationSpecSets on a missing set fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        probe(
          datalabeling.getProjectsAnnotationSpecSets({
            name: `projects/${project}/annotationSpecSets/alchemy-missing-specs`,
          }),
        ),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datalabeling", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, replace, and delete an annotation spec set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataLabeling.AnnotationSpecSet("Classes", {
            displayName: "pets",
            description: "companion animals",
            annotationSpecs: [{ displayName: "dog" }, { displayName: "cat" }],
          });
        }),
      );

      expect(created.name).toContain("/annotationSpecSets/");
      expect(created.displayName).toEqual("pets");
      expect(created.description).toEqual("companion animals");
      expect(created.annotationSpecs.map((spec) => spec.displayName)).toEqual([
        "dog",
        "cat",
      ]);

      const fetched = yield* datalabeling.getProjectsAnnotationSpecSets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("companion animals");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataLabeling.AnnotationSpecSet("Classes", {
            annotationSpecSetId: created.annotationSpecSetId,
            displayName: "pets",
            description: "updated companion animals",
            annotationSpecs: [{ displayName: "dog" }, { displayName: "cat" }],
          });
        }),
      );

      expect(updated.description).toEqual("updated companion animals");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datalabeling.getProjectsAnnotationSpecSets({ name: updated.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datalabeling", "live"],
    timeout: 90_000,
  },
);
