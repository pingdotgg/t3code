import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vision from "@distilled.cloud/gcp/vision_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { location, logLevel, currentProject, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  vision.getProjectsLocationsProductSets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsProductSets on a missing set fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vision.getProjectsLocationsProductSets({
          name: `projects/${project}/locations/${location}/productSets/alchemy-missing-set`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vision", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a product set",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.Vision.Product("Shoe", {
            location,
            displayName: "Trail runner",
            productCategory: "apparel-v2",
          });
          const set = yield* GCP.Vision.ProductSet("Catalog", {
            location,
            displayName: "Summer",
          });
          return { product, set };
        }),
      );

      expect(
        created.set.name.startsWith(
          `projects/${project}/locations/${location}/productSets/`,
        ),
      ).toEqual(true);
      expect(created.set.productSetId.length).toBeGreaterThan(0);
      expect(created.set.displayName).toEqual("Summer");
      expect(created.set.location).toEqual(location);
      expect(created.set.products).toEqual([]);

      const fetched = yield* vision.getProjectsLocationsProductSets({
        name: created.set.name,
      });
      expect(fetched.name).toEqual(created.set.name);
      expect(fetched.displayName).toEqual("Summer");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.Vision.Product("Shoe", {
            location,
            productId: created.product.productId,
            displayName: "Trail runner",
            productCategory: "apparel-v2",
          });
          const set = yield* GCP.Vision.ProductSet("Catalog", {
            location,
            productSetId: created.set.productSetId,
            displayName: "Fall",
            products: [product.name],
          });
          return { product, set };
        }),
      );

      expect(updated.set.name).toEqual(created.set.name);
      expect(updated.set.displayName).toEqual("Fall");
      expect(updated.set.products).toContain(created.product.name);

      const fetchedUpdate = yield* vision.getProjectsLocationsProductSets({
        name: created.set.name,
      });
      expect(fetchedUpdate.displayName).toEqual("Fall");

      const members = yield* vision.listProjectsLocationsProductSetsProducts({
        name: created.set.name,
        pageSize: 100,
      });
      expect((members.products ?? []).map((product) => product.name)).toContain(
        created.product.name,
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.set.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vision", "live"], timeout: 90_000 },
);
