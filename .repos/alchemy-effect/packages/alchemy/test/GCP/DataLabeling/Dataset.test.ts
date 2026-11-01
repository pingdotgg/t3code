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
  "getProjectsDatasets on a missing dataset fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        probe(
          datalabeling.getProjectsDatasets({
            name: `projects/${project}/datasets/alchemy-missing-dataset`,
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
  "create, replace, and delete a dataset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataLabeling.Dataset("Images", {
            displayName: "product-photos",
            description: "sku images",
          });
        }),
      );

      expect(created.name).toContain("/datasets/");
      expect(created.displayName).toEqual("product-photos");
      expect(created.description).toEqual("sku images");

      const fetched = yield* datalabeling.getProjectsDatasets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("sku images");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DataLabeling.Dataset("Images", {
            datasetId: created.datasetId,
            displayName: "product-photos",
            description: "updated sku images",
          });
        }),
      );

      expect(updated.description).toEqual("updated sku images");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datalabeling.getProjectsDatasets({ name: updated.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datalabeling", "live"],
    timeout: 90_000,
  },
);
