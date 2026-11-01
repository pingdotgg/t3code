import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vision from "@distilled.cloud/gcp/vision_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { location, logLevel, currentProject, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  vision.getProjectsLocationsProducts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsProducts on a missing product fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vision.getProjectsLocationsProducts({
          name: `projects/${project}/locations/${location}/products/alchemy-missing-product`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vision", "live"], timeout: 90_000 },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsLocationsProducts on a new project fails with ProductSearchNotOnboarded",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vision.createProjectsLocationsProducts({
          parent: `projects/${project}/locations/${location}`,
          productId: "alchemy-vision-probe",
          body: {
            displayName: "Alchemy probe",
            productCategory: "homegoods-v2",
          },
        }),
      );
      expect(error._tag).toEqual("ProductSearchNotOnboarded");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vision", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a product",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Vision.Product("Shoe", {
            location,
            displayName: "Trail runner",
            description: "mesh upper",
            productCategory: "apparel-v2",
            productLabels: [{ key: "color", value: "blue" }],
          });
        }),
      );

      expect(
        created.name.startsWith(
          `projects/${project}/locations/${location}/products/`,
        ),
      ).toEqual(true);
      expect(created.productId.length).toBeGreaterThan(0);
      expect(created.displayName).toEqual("Trail runner");
      expect(created.description).toEqual("mesh upper");
      expect(created.productCategory).toEqual("apparel-v2");
      expect(created.productLabels).toEqual([{ key: "color", value: "blue" }]);

      const fetched = yield* vision.getProjectsLocationsProducts({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("Trail runner");
      expect(fetched.description).toEqual("mesh upper");
      expect(fetched.productCategory).toEqual("apparel-v2");
      expect(fetched.productLabels).toEqual([{ key: "color", value: "blue" }]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Vision.Product("Shoe", {
            location,
            productId: created.productId,
            displayName: "Trail runner v2",
            description: "knit upper",
            productCategory: "apparel-v2",
            productLabels: [
              { key: "color", value: "green" },
              { key: "size", value: "10" },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("Trail runner v2");
      expect(updated.description).toEqual("knit upper");
      expect(updated.productLabels).toEqual([
        { key: "color", value: "green" },
        { key: "size", value: "10" },
      ]);

      const fetchedUpdate = yield* vision.getProjectsLocationsProducts({
        name: created.name,
      });
      expect(fetchedUpdate.displayName).toEqual("Trail runner v2");
      expect(fetchedUpdate.description).toEqual("knit upper");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vision", "live"], timeout: 90_000 },
);
