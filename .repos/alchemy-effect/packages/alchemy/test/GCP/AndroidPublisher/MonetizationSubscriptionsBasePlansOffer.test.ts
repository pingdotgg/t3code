import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as androidpublisher from "@distilled.cloud/gcp/androidpublisher_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  logLevel,
  packageName,
  probePackageName,
  missingTag,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (
  appId: string,
  productId: string,
  basePlanId: string,
  offerId: string,
) =>
  androidpublisher
    .getMonetizationSubscriptionsBasePlansOffers({
      packageName: appId,
      productId,
      basePlanId,
      offerId,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getMonetizationSubscriptionsBasePlansOffers on a missing offer fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidpublisher.getMonetizationSubscriptionsBasePlansOffers({
          packageName: probePackageName,
          productId: "alchemy_missing_sub",
          basePlanId: "monthly",
          offerId: "alchemy-missing-offer",
        }),
      );
      expect(error._tag).toEqual(missingTag);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidpublisher", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createMonetizationSubscriptionsBasePlansOffers without Play access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidpublisher.createMonetizationSubscriptionsBasePlansOffers({
          packageName: probePackageName,
          productId: "alchemy_probe_sub",
          basePlanId: "monthly",
          offerId: "intro",
          "regionsVersion.version": "2025/01",
          body: {
            packageName: probePackageName,
            productId: "alchemy_probe_sub",
            basePlanId: "monthly",
            offerId: "intro",
            phases: [
              {
                duration: "P1W",
                recurrenceCount: 1,
                regionalConfigs: [{ regionCode: "US", free: {} }],
              },
            ],
            regionalConfigs: [
              { regionCode: "US", newSubscriberAvailability: true },
            ],
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidpublisher", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a subscription offer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const subscription =
            yield* GCP.AndroidPublisher.MonetizationSubscription("Premium", {
              packageName: packageName!,
              listings: [{ languageCode: "en-US", title: "Premium" }],
              basePlans: [
                {
                  basePlanId: "monthly",
                  autoRenewingBasePlanType: { billingPeriodDuration: "P1M" },
                  regionalConfigs: [
                    {
                      regionCode: "US",
                      newSubscriberAvailability: true,
                      price: { currencyCode: "USD", units: "5" },
                    },
                  ],
                },
              ],
            });
          const offer =
            yield* GCP.AndroidPublisher.MonetizationSubscriptionsBasePlansOffer(
              "Intro",
              {
                packageName: packageName!,
                productId: subscription.productId,
                basePlanId: "monthly",
              },
            );
          return { subscription, offer };
        }),
      );

      expect(created.offer.offerId.length).toBeGreaterThan(0);
      expect(created.offer.productId).toEqual(created.subscription.productId);

      const fetched =
        yield* androidpublisher.getMonetizationSubscriptionsBasePlansOffers({
          packageName: created.offer.packageName,
          productId: created.offer.productId,
          basePlanId: created.offer.basePlanId,
          offerId: created.offer.offerId,
        });
      expect(fetched.offerId).toEqual(created.offer.offerId);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const subscription =
            yield* GCP.AndroidPublisher.MonetizationSubscription("Premium", {
              packageName: created.subscription.packageName,
              productId: created.subscription.productId,
              listings: [{ languageCode: "en-US", title: "Premium" }],
              basePlans: [
                {
                  basePlanId: "monthly",
                  autoRenewingBasePlanType: { billingPeriodDuration: "P1M" },
                  regionalConfigs: [
                    {
                      regionCode: "US",
                      newSubscriberAvailability: true,
                      price: { currencyCode: "USD", units: "5" },
                    },
                  ],
                },
              ],
            });
          const offer =
            yield* GCP.AndroidPublisher.MonetizationSubscriptionsBasePlansOffer(
              "Intro",
              {
                packageName: created.offer.packageName,
                productId: created.offer.productId,
                basePlanId: created.offer.basePlanId,
                offerId: created.offer.offerId,
                regionalConfigs: [
                  { regionCode: "US", newSubscriberAvailability: false },
                ],
              },
            );
          return { subscription, offer };
        }),
      );

      expect(updated.offer.offerId).toEqual(created.offer.offerId);
      expect(
        updated.offer.regionalConfigs?.[0]?.newSubscriberAvailability,
      ).toEqual(false);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.offer.packageName,
        created.offer.productId,
        created.offer.basePlanId,
        created.offer.offerId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidpublisher", "live"],
    timeout: 90_000,
  },
);
