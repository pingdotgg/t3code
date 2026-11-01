import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as recommendationengine from "@distilled.cloud/gcp/recommendationengine_v1beta1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { currentProject, entitled, logLevel, missingNameOf } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  recommendationengine.getProjectsLocationsCatalogsCatalogItems({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!entitled)(
  "getProjectsLocationsCatalogsCatalogItems on a missing item fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        recommendationengine.getProjectsLocationsCatalogsCatalogItems({
          name: missingNameOf(project),
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:recommendationengine", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(entitled)(
  "getProjectsLocationsCatalogsCatalogItems fails with ServiceDisabled while the API is disabled",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        recommendationengine.getProjectsLocationsCatalogsCatalogItems({
          name: missingNameOf(project),
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:recommendationengine", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!entitled || !!process.env.FAST)(
  "create, update, and delete a catalog item",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.RecommendationEngine.CatalogsCatalogItem("Shirt", {
            title: "Cotton tee",
            description: "test tee",
            categoryHierarchies: [{ categories: ["Apparel", "T-Shirts"] }],
            productMetadata: {
              currencyCode: "USD",
              exactPrice: { displayPrice: 20 },
              stockState: "IN_STOCK",
            },
          });
        }),
      );

      expect(created.name).toContain("/catalogItems/");
      expect(created.title).toEqual("Cotton tee");
      expect(created.description).toEqual("test tee");
      expect(created.categoryHierarchies[0]?.categories).toEqual(
        expect.arrayContaining(["Apparel", "T-Shirts"]),
      );

      const fetched =
        yield* recommendationengine.getProjectsLocationsCatalogsCatalogItems({
          name: created.name,
        });
      expect(fetched.id).toEqual(created.catalogItemId);
      // Description and tags feed recommendations: no ownership marker.
      expect(fetched.description).toEqual("test tee");
      expect(fetched.title).toEqual("Cotton tee");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.RecommendationEngine.CatalogsCatalogItem("Shirt", {
            catalogItemId: created.catalogItemId,
            catalog: created.catalog,
            location: created.location,
            title: "Linen tee",
            description: "updated tee",
            categoryHierarchies: [{ categories: ["Apparel", "T-Shirts"] }],
            productMetadata: {
              currencyCode: "USD",
              exactPrice: { displayPrice: 24 },
              stockState: "IN_STOCK",
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.title).toEqual("Linen tee");
      expect(updated.productMetadata?.exactPrice?.displayPrice).toEqual(24);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:recommendationengine", "live"],
    timeout: 90_000,
  },
);
