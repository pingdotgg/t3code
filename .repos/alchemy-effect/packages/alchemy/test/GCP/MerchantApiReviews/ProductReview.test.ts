import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as reviews from "@distilled.cloud/gcp/merchantapi_reviews_v1beta";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  accountId,
  logLevel,
  probeAccount,
  probeDataSource,
  productReviewDataSource,
  runProductReviewLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  reviews.getAccountsProductReviews({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!runProductReviewLifecycle)(
  "getAccountsProductReviews on a missing review fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        reviews.getAccountsProductReviews({
          name: `accounts/${probeAccount}/productReviews/alchemy-missing-product-review`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:merchantapireviews", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runProductReviewLifecycle)(
  "insertAccountsProductReviews without Product Reviews access fails with InsufficientScopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        reviews.insertAccountsProductReviews({
          parent: `accounts/${probeAccount}`,
          dataSource: probeDataSource(productReviewDataSource),
          body: {
            productReviewId: "alchemy-probe-product-review",
            productReviewAttributes: {
              reviewTime: "2020-01-01T00:00:00Z",
              content: "probe",
              title: "Alchemy Probe Product Review",
              skus: ["alchemy-probe-sku"],
            },
          },
        }),
      );
      expect(error._tag).toEqual("InsufficientScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:merchantapireviews", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runProductReviewLifecycle)(
  "create, update, and delete a product review",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.MerchantApiReviews.ProductReview("Tote", {
            account: accountId!,
            dataSource: productReviewDataSource!,
            productReviewAttributes: {
              title: "Sturdy tote",
              content: "Holds a laptop and lunch",
              rating: 5,
              skus: ["tote-navy"],
            },
          });
        }),
      );

      expect(created.productReviewId.length).toBeGreaterThan(0);
      expect(created.name).toContain("/productReviews/");
      expect(created.account).toEqual(accountId);
      expect(created.productReviewAttributes?.title).toEqual("Sturdy tote");
      expect(created.productReviewAttributes?.content).toEqual(
        "Holds a laptop and lunch",
      );

      const fetched = yield* reviews.getAccountsProductReviews({
        name: created.name,
      });
      expect(fetched.productReviewId).toEqual(created.productReviewId);
      // Review text is shown to shoppers: no ownership marker.
      expect(fetched.productReviewAttributes?.content).toEqual(
        created.productReviewAttributes?.content,
      );
      expect(fetched.productReviewAttributes?.title).toEqual("Sturdy tote");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.MerchantApiReviews.ProductReview("Tote", {
            account: created.account,
            dataSource: productReviewDataSource!,
            productReviewId: created.productReviewId,
            productReviewAttributes: {
              title: "Roomy tote",
              content: "Holds a laptop, lunch, and jacket",
              rating: 4,
              skus: ["tote-navy"],
            },
          });
        }),
      );

      expect(updated.productReviewId).toEqual(created.productReviewId);
      expect(updated.productReviewAttributes?.title).toEqual("Roomy tote");
      expect(updated.productReviewAttributes?.content).toEqual(
        "Holds a laptop, lunch, and jacket",
      );
      expect(updated.productReviewAttributes?.rating).toEqual(4);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:merchantapireviews", "live"],
    timeout: 90_000,
  },
);
