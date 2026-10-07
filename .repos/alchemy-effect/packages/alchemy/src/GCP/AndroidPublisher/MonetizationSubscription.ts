import * as androidpublisher from "@distilled.cloud/gcp/androidpublisher_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_REGIONS_VERSION,
  defaultSubscriptionListings,
  getSubscription,
  jsonEqual,
  publicBasePlans,
  toDisplayName,
  toProductId,
  updateMaskOf,
} from "./internal.ts";

export type MonetizationSubscriptionProps = {
  /**
   * Play package name of the parent app (for example `com.example.app`).
   * Immutable — changing it replaces the subscription.
   */
  packageName: string;
  /**
   * Unique product id within the app. Lower-case letters, numbers,
   * underscores, and dots; 1-40 characters. If omitted, a unique id is
   * generated. Immutable — changing it replaces the subscription.
   */
  productId?: string;
  /**
   * Localized store listings. Must include the app's default language; an
   * `en-US` listing titled after the product id is used when omitted.
   */
  listings?: androidpublisher.SubscriptionListing[];
  /**
   * Base plans (prices and billing periods). Draft until activated.
   */
  basePlans?: androidpublisher.BasePlan[];
  /**
   * Tax and legal-compliance settings.
   */
  taxAndComplianceSettings?: androidpublisher.SubscriptionTaxAndComplianceSettings;
  /**
   * Countries where purchase is restricted to payment methods registered
   * in the same country.
   */
  restrictedPaymentCountries?: androidpublisher.RestrictedPaymentCountries;
  /**
   * Regions-version string used when creating or updating regional
   * prices (for example `2025/01`).
   * @default "2025/01"
   */
  regionsVersion?: string;
  /**
   * Propagation latency tolerance for product updates.
   */
  latencyTolerance?:
    | androidpublisher.PatchMonetizationSubscriptionsLatencyToleranceEnum
    | (string & {});
};

export type MonetizationSubscription = Resource<
  "GCP.AndroidPublisher.MonetizationSubscription",
  MonetizationSubscriptionProps,
  {
    /** Play package name. */
    packageName: string;
    /** Product id. */
    productId: string;
    /** Project id used when the subscription was reconciled. */
    project: string;
    /** Localized store listings. */
    listings: androidpublisher.SubscriptionListing[] | undefined;
    /** Base plans (output-only state omitted from equality). */
    basePlans: androidpublisher.BasePlan[] | undefined;
    /** Tax and compliance settings. */
    taxAndComplianceSettings:
      | androidpublisher.SubscriptionTaxAndComplianceSettings
      | undefined;
    /** Payment-country restrictions. */
    restrictedPaymentCountries:
      | androidpublisher.RestrictedPaymentCountries
      | undefined;
    /** Whether the subscription is archived. */
    archived: boolean | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Play subscription product (`monetization.subscriptions`).
 *
 * Subscriptions have no labels field, so ownership rests on the
 * deterministic product id: `read` reports a subscription it finds without
 * prior state as unowned (adopt it with `--adopt`). `packageName` and
 * `productId` are identity — changing either replaces the subscription.
 * Listings, base plans, tax settings, and payment-country restrictions
 * update in place. A subscription can only be deleted while every base
 * plan is still a draft.
 *
 * ### Creating a Subscription
 * **Example:** Generated product id
 * ```typescript
 * const subscription = yield* GCP.AndroidPublisher.MonetizationSubscription(
 *   "Premium",
 *   {
 *     packageName: "com.example.app",
 *     listings: [{ languageCode: "en-US", title: "Premium" }],
 *   },
 * );
 * ```
 *
 * **Example:** Explicit id and monthly base plan
 * ```typescript
 * const subscription = yield* GCP.AndroidPublisher.MonetizationSubscription(
 *   "Premium",
 *   {
 *     packageName: "com.example.app",
 *     productId: "premium",
 *     listings: [{ languageCode: "en-US", title: "Premium" }],
 *     basePlans: [
 *       {
 *         basePlanId: "monthly",
 *         autoRenewingBasePlanType: { billingPeriodDuration: "P1M" },
 *         regionalConfigs: [
 *           {
 *             regionCode: "US",
 *             newSubscriberAvailability: true,
 *             price: { currencyCode: "USD", units: "5" },
 *           },
 *         ],
 *       },
 *     ],
 *   },
 * );
 * ```
 *
 * ### Updating a Subscription
 * **Example:** Change the listing title
 * ```typescript
 * // Same logical id as before; only the listing changes.
 * const subscription = yield* GCP.AndroidPublisher.MonetizationSubscription(
 *   "Premium",
 *   {
 *     packageName: "com.example.app",
 *     listings: [{ languageCode: "en-US", title: "Premium Plus" }],
 *   },
 * );
 * ```
 *
 * @resource
 * @category AndroidPublisher
 */
export const MonetizationSubscription = Resource<MonetizationSubscription>(
  "GCP.AndroidPublisher.MonetizationSubscription",
);

export class MonetizationSubscriptionNotResolved extends Data.TaggedError(
  "GCP.AndroidPublisher.MonetizationSubscriptionNotResolved",
)<{
  packageName: string;
  productId: string;
}> {}

const toAttrs = (
  subscription: androidpublisher.Subscription,
  project: string,
) => ({
  packageName: subscription.packageName ?? "",
  productId: subscription.productId ?? "",
  project,
  listings: subscription.listings,
  basePlans: publicBasePlans(subscription.basePlans),
  taxAndComplianceSettings: subscription.taxAndComplianceSettings,
  restrictedPaymentCountries: subscription.restrictedPaymentCountries,
  archived: subscription.archived,
});

const desiredBody = (input: {
  packageName: string;
  productId: string;
  listings: androidpublisher.SubscriptionListing[];
  news: MonetizationSubscriptionProps;
}): androidpublisher.Subscription => ({
  packageName: input.packageName,
  productId: input.productId,
  listings: input.listings,
  basePlans: input.news.basePlans,
  taxAndComplianceSettings: input.news.taxAndComplianceSettings,
  restrictedPaymentCountries: input.news.restrictedPaymentCountries,
});

const needsSync = (
  current: androidpublisher.Subscription,
  desired: androidpublisher.Subscription,
) =>
  !jsonEqual(current.listings, desired.listings) ||
  (desired.basePlans !== undefined &&
    !jsonEqual(
      publicBasePlans(current.basePlans),
      publicBasePlans(desired.basePlans),
    )) ||
  (desired.taxAndComplianceSettings !== undefined &&
    !jsonEqual(
      current.taxAndComplianceSettings,
      desired.taxAndComplianceSettings,
    )) ||
  (desired.restrictedPaymentCountries !== undefined &&
    !jsonEqual(
      current.restrictedPaymentCountries,
      desired.restrictedPaymentCountries,
    ));

const syncMask = (
  current: androidpublisher.Subscription,
  desired: androidpublisher.Subscription,
) =>
  updateMaskOf(
    !jsonEqual(current.listings, desired.listings) ? "listings" : undefined,
    desired.basePlans !== undefined &&
      !jsonEqual(
        publicBasePlans(current.basePlans),
        publicBasePlans(desired.basePlans),
      )
      ? "basePlans"
      : undefined,
    desired.taxAndComplianceSettings !== undefined &&
      !jsonEqual(
        current.taxAndComplianceSettings,
        desired.taxAndComplianceSettings,
      )
      ? "taxAndComplianceSettings"
      : undefined,
    desired.restrictedPaymentCountries !== undefined &&
      !jsonEqual(
        current.restrictedPaymentCountries,
        desired.restrictedPaymentCountries,
      )
      ? "restrictedPaymentCountries"
      : undefined,
  );

export const MonetizationSubscriptionProvider = () =>
  Provider.succeed(MonetizationSubscription, {
    stables: ["packageName", "productId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPackage = olds?.packageName ?? output?.packageName;
      if (
        previousPackage !== undefined &&
        news.packageName !== previousPackage
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.productId ?? output?.productId;
      if (
        previousId !== undefined &&
        news.productId !== undefined &&
        news.productId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const packageName = olds?.packageName ?? output?.packageName ?? "";
      const productId = yield* toProductId(
        id,
        olds?.productId,
        output?.productId,
      );
      const existing = yield* getSubscription(packageName, productId);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state the subscription may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const packageName = news.packageName;
      const productId = yield* toProductId(
        id,
        news.productId,
        output?.productId,
      );
      const title = yield* toDisplayName(
        id,
        news.listings?.[0]?.title,
        output?.listings?.[0]?.title,
      );
      const listings = defaultSubscriptionListings(news.listings, title);
      const regionsVersion = news.regionsVersion ?? DEFAULT_REGIONS_VERSION;
      const desired = desiredBody({
        packageName,
        productId,
        listings,
        news,
      });

      let current = yield* getSubscription(packageName, productId);

      if (current === undefined) {
        const created = yield* androidpublisher
          .createMonetizationSubscriptions({
            packageName,
            productId,
            "regionsVersion.version": regionsVersion,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getSubscription(packageName, productId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new MonetizationSubscriptionNotResolved({
          packageName,
          productId,
        });
      }

      if (needsSync(current, desired)) {
        const updateMask = syncMask(current, desired);
        if (updateMask.length > 0) {
          current = yield* androidpublisher.patchMonetizationSubscriptions({
            packageName,
            productId: current.productId ?? productId,
            updateMask,
            "regionsVersion.version": regionsVersion,
            latencyTolerance: news.latencyTolerance,
            body: desired,
          });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.packageName || !output.productId) return;
      yield* androidpublisher
        .deleteMonetizationSubscriptions({
          packageName: output.packageName,
          productId: output.productId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
