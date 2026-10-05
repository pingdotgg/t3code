import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as reviews from "@distilled.cloud/gcp/merchantapi_reviews_v1beta";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  accountId,
  logLevel,
  merchantReviewDataSource,
  probeAccount,
  probeDataSource,
  runMerchantReviewLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  reviews.getAccountsMerchantReviews({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!runMerchantReviewLifecycle)(
  "getAccountsMerchantReviews on a missing review fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        reviews.getAccountsMerchantReviews({
          name: `accounts/${probeAccount}/merchantReviews/alchemy-missing-merchant-review`,
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

test.provider.skipIf(runMerchantReviewLifecycle)(
  "insertAccountsMerchantReviews without Merchant Reviews access fails with InsufficientScopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        reviews.insertAccountsMerchantReviews({
          parent: `accounts/${probeAccount}`,
          dataSource: probeDataSource(merchantReviewDataSource),
          body: {
            merchantReviewId: "alchemy-probe-merchant-review",
            merchantReviewAttributes: {
              merchantId: probeAccount,
              reviewTime: "2020-01-01T00:00:00Z",
              content: "probe",
              title: "Alchemy Probe Merchant Review",
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

test.provider.skipIf(!runMerchantReviewLifecycle)(
  "create, update, and delete a merchant review",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.MerchantApiReviews.MerchantReview("Storefront", {
            account: accountId!,
            dataSource: merchantReviewDataSource!,
            merchantReviewAttributes: {
              title: "Great shop",
              content: "Fast shipping",
              rating: 5,
            },
          });
        }),
      );

      expect(created.merchantReviewId.length).toBeGreaterThan(0);
      expect(created.name).toContain("/merchantReviews/");
      expect(created.account).toEqual(accountId);
      expect(created.merchantReviewAttributes?.title).toEqual("Great shop");
      expect(created.merchantReviewAttributes?.content).toEqual(
        "Fast shipping",
      );

      const fetched = yield* reviews.getAccountsMerchantReviews({
        name: created.name,
      });
      expect(fetched.merchantReviewId).toEqual(created.merchantReviewId);
      // Review text is shown to shoppers: no ownership marker.
      expect(fetched.merchantReviewAttributes?.content).toEqual(
        created.merchantReviewAttributes?.content,
      );
      expect(fetched.merchantReviewAttributes?.title).toEqual("Great shop");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.MerchantApiReviews.MerchantReview("Storefront", {
            account: created.account,
            dataSource: merchantReviewDataSource!,
            merchantReviewId: created.merchantReviewId,
            merchantReviewAttributes: {
              title: "Even better",
              content: "Fast shipping and packing",
              rating: 5,
            },
          });
        }),
      );

      expect(updated.merchantReviewId).toEqual(created.merchantReviewId);
      expect(updated.merchantReviewAttributes?.title).toEqual("Even better");
      expect(updated.merchantReviewAttributes?.content).toEqual(
        "Fast shipping and packing",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:merchantapireviews", "live"],
    timeout: 90_000,
  },
);
