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
  defaultOfferPhases,
  defaultOfferRegionalConfigs,
  defaultOfferTargeting,
  getOffer,
  jsonEqual,
  toOfferId,
  updateMaskOf,
} from "./internal.ts";

export type MonetizationSubscriptionsBasePlansOfferProps = {
  /**
   * Play package name of the parent app. Immutable — changing it
   * replaces the offer.
   */
  packageName: string;
  /**
   * Parent subscription product id. Immutable — changing it replaces
   * the offer.
   */
  productId: string;
  /**
   * Parent auto-renewing base plan id. Immutable — changing it
   * replaces the offer.
   */
  basePlanId: string;
  /**
   * Unique offer id within the base plan. If omitted, a unique id is
   * generated. Immutable — changing it replaces the offer.
   */
  offerId?: string;
  /**
   * Offer phases (1-2). Defaults to a one-week free phase in the US.
   */
  phases?: androidpublisher.SubscriptionOfferPhase[];
  /**
   * Region-specific availability. Defaults to the US.
   */
  regionalConfigs?: androidpublisher.RegionalSubscriptionOfferConfig[];
  /**
   * Configuration for locations Play may launch in later.
   */
  otherRegionsConfig?: androidpublisher.OtherRegionsSubscriptionOfferConfig;
  /**
   * Custom billing-library tags (RFC-1034, max 20 characters each).
   */
  offerTags?: androidpublisher.OfferTag[];
  /**
   * Eligibility targeting. Defaults to new subscribers of this
   * subscription.
   */
  targeting?: androidpublisher.SubscriptionOfferTargeting;
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
    | androidpublisher.PatchMonetizationSubscriptionsBasePlansOffersLatencyToleranceEnum
    | (string & {});
};

export type MonetizationSubscriptionsBasePlansOffer = Resource<
  "GCP.AndroidPublisher.MonetizationSubscriptionsBasePlansOffer",
  MonetizationSubscriptionsBasePlansOfferProps,
  {
    /** Play package name. */
    packageName: string;
    /** Parent subscription product id. */
    productId: string;
    /** Parent base plan id. */
    basePlanId: string;
    /** Offer id. */
    offerId: string;
    /** Project id used when the offer was reconciled. */
    project: string;
    /** Offer state (`DRAFT`, `ACTIVE`, `INACTIVE`). */
    state: string | undefined;
    /** Offer phases. */
    phases: androidpublisher.SubscriptionOfferPhase[] | undefined;
    /** Regional availability. */
    regionalConfigs:
      | androidpublisher.RegionalSubscriptionOfferConfig[]
      | undefined;
    /** Configuration for future Play locations. */
    otherRegionsConfig:
      | androidpublisher.OtherRegionsSubscriptionOfferConfig
      | undefined;
    /** Custom billing-library tags. */
    offerTags: androidpublisher.OfferTag[] | undefined;
    /** Eligibility targeting. */
    targeting: androidpublisher.SubscriptionOfferTargeting | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Play subscription offer
 * (`monetization.subscriptions.basePlans.offers`).
 *
 * Offers have no labels field, so ownership rests on the deterministic
 * offer id: `read` reports an offer it finds without prior state as
 * unowned (adopt it with `--adopt`). `packageName`, `productId`,
 * `basePlanId`, and `offerId` are identity — changing any of them
 * replaces the offer. Phases, regional configs, tags, and targeting
 * update in place. Only draft offers can be deleted. The parent base
 * plan must be auto-renewing.
 *
 * ### Creating an Offer
 * **Example:** Generated offer id (one-week free trial)
 * ```typescript
 * const offer = yield* GCP.AndroidPublisher.MonetizationSubscriptionsBasePlansOffer(
 *   "Intro",
 *   {
 *     packageName: "com.example.app",
 *     productId: subscription.productId,
 *     basePlanId: "monthly",
 *   },
 * );
 * ```
 *
 * **Example:** Explicit id and discounted first month
 * ```typescript
 * const offer = yield* GCP.AndroidPublisher.MonetizationSubscriptionsBasePlansOffer(
 *   "Intro",
 *   {
 *     packageName: "com.example.app",
 *     productId: "premium",
 *     basePlanId: "monthly",
 *     offerId: "intro",
 *     phases: [
 *       {
 *         duration: "P1M",
 *         recurrenceCount: 1,
 *         regionalConfigs: [
 *           { regionCode: "US", relativeDiscount: 0.5 },
 *         ],
 *       },
 *     ],
 *   },
 * );
 * ```
 *
 * ### Updating an Offer
 * **Example:** Close the offer to new subscribers
 * ```typescript
 * // Same logical id as before; only the regional config changes.
 * const offer = yield* GCP.AndroidPublisher.MonetizationSubscriptionsBasePlansOffer(
 *   "Intro",
 *   {
 *     packageName: "com.example.app",
 *     productId: subscription.productId,
 *     basePlanId: "monthly",
 *     regionalConfigs: [
 *       { regionCode: "US", newSubscriberAvailability: false },
 *     ],
 *   },
 * );
 * ```
 *
 * @resource
 * @category AndroidPublisher
 */
export const MonetizationSubscriptionsBasePlansOffer =
  Resource<MonetizationSubscriptionsBasePlansOffer>(
    "GCP.AndroidPublisher.MonetizationSubscriptionsBasePlansOffer",
  );

export class MonetizationSubscriptionsBasePlansOfferNotResolved extends Data.TaggedError(
  "GCP.AndroidPublisher.MonetizationSubscriptionsBasePlansOfferNotResolved",
)<{
  packageName: string;
  productId: string;
  basePlanId: string;
  offerId: string;
}> {}

const toAttrs = (
  offer: androidpublisher.SubscriptionOffer,
  project: string,
) => ({
  packageName: offer.packageName ?? "",
  productId: offer.productId ?? "",
  basePlanId: offer.basePlanId ?? "",
  offerId: offer.offerId ?? "",
  project,
  state: offer.state,
  phases: offer.phases,
  regionalConfigs: offer.regionalConfigs,
  otherRegionsConfig: offer.otherRegionsConfig,
  offerTags: offer.offerTags,
  targeting: offer.targeting,
});

const desiredBody = (input: {
  packageName: string;
  productId: string;
  basePlanId: string;
  offerId: string;
  news: MonetizationSubscriptionsBasePlansOfferProps;
}): androidpublisher.SubscriptionOffer => ({
  packageName: input.packageName,
  productId: input.productId,
  basePlanId: input.basePlanId,
  offerId: input.offerId,
  phases: input.news.phases ?? defaultOfferPhases(),
  regionalConfigs: input.news.regionalConfigs ?? defaultOfferRegionalConfigs(),
  otherRegionsConfig: input.news.otherRegionsConfig,
  offerTags: input.news.offerTags,
  targeting: input.news.targeting ?? defaultOfferTargeting(),
});

const needsSync = (
  current: androidpublisher.SubscriptionOffer,
  desired: androidpublisher.SubscriptionOffer,
) =>
  !jsonEqual(current.phases, desired.phases) ||
  !jsonEqual(current.regionalConfigs, desired.regionalConfigs) ||
  (desired.otherRegionsConfig !== undefined &&
    !jsonEqual(current.otherRegionsConfig, desired.otherRegionsConfig)) ||
  (desired.offerTags !== undefined &&
    !jsonEqual(current.offerTags, desired.offerTags)) ||
  (desired.targeting !== undefined &&
    !jsonEqual(current.targeting, desired.targeting));

const syncMask = (
  current: androidpublisher.SubscriptionOffer,
  desired: androidpublisher.SubscriptionOffer,
) =>
  updateMaskOf(
    !jsonEqual(current.phases, desired.phases) ? "phases" : undefined,
    !jsonEqual(current.regionalConfigs, desired.regionalConfigs)
      ? "regionalConfigs"
      : undefined,
    desired.otherRegionsConfig !== undefined &&
      !jsonEqual(current.otherRegionsConfig, desired.otherRegionsConfig)
      ? "otherRegionsConfig"
      : undefined,
    desired.offerTags !== undefined &&
      !jsonEqual(current.offerTags, desired.offerTags)
      ? "offerTags"
      : undefined,
    desired.targeting !== undefined &&
      !jsonEqual(current.targeting, desired.targeting)
      ? "targeting"
      : undefined,
  );

export const MonetizationSubscriptionsBasePlansOfferProvider = () =>
  Provider.succeed(MonetizationSubscriptionsBasePlansOffer, {
    stables: ["packageName", "productId", "basePlanId", "offerId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPackage = olds?.packageName ?? output?.packageName;
      if (
        previousPackage !== undefined &&
        news.packageName !== previousPackage
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousProduct = olds?.productId ?? output?.productId;
      if (previousProduct !== undefined && news.productId !== previousProduct) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousPlan = olds?.basePlanId ?? output?.basePlanId;
      if (previousPlan !== undefined && news.basePlanId !== previousPlan) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousOffer = olds?.offerId ?? output?.offerId;
      if (
        previousOffer !== undefined &&
        news.offerId !== undefined &&
        news.offerId !== previousOffer
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const packageName = olds?.packageName ?? output?.packageName ?? "";
      const productId = olds?.productId ?? output?.productId ?? "";
      const basePlanId = olds?.basePlanId ?? output?.basePlanId ?? "";
      const offerId = yield* toOfferId(id, olds?.offerId, output?.offerId);
      const existing = yield* getOffer(
        packageName,
        productId,
        basePlanId,
        offerId,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state the offer may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const packageName = news.packageName;
      const productId = news.productId;
      const basePlanId = news.basePlanId;
      const offerId = yield* toOfferId(id, news.offerId, output?.offerId);
      const regionsVersion = news.regionsVersion ?? DEFAULT_REGIONS_VERSION;
      const desired = desiredBody({
        packageName,
        productId,
        basePlanId,
        offerId,
        news,
      });

      let current = yield* getOffer(
        packageName,
        productId,
        basePlanId,
        offerId,
      );

      if (current === undefined) {
        const created = yield* androidpublisher
          .createMonetizationSubscriptionsBasePlansOffers({
            packageName,
            productId,
            basePlanId,
            offerId,
            "regionsVersion.version": regionsVersion,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getOffer(packageName, productId, basePlanId, offerId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new MonetizationSubscriptionsBasePlansOfferNotResolved({
          packageName,
          productId,
          basePlanId,
          offerId,
        });
      }

      if (needsSync(current, desired)) {
        const updateMask = syncMask(current, desired);
        if (updateMask.length > 0) {
          current =
            yield* androidpublisher.patchMonetizationSubscriptionsBasePlansOffers(
              {
                packageName,
                productId,
                basePlanId,
                offerId: current.offerId ?? offerId,
                updateMask,
                "regionsVersion.version": regionsVersion,
                latencyTolerance: news.latencyTolerance,
                body: desired,
              },
            );
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (
        !output.packageName ||
        !output.productId ||
        !output.basePlanId ||
        !output.offerId
      ) {
        return;
      }
      yield* androidpublisher
        .deleteMonetizationSubscriptionsBasePlansOffers({
          packageName: output.packageName,
          productId: output.productId,
          basePlanId: output.basePlanId,
          offerId: output.offerId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
