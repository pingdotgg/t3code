import * as androidpublisher from "@distilled.cloud/gcp/androidpublisher_v3";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";

export const DEFAULT_LANGUAGE = "en-US";
export const DEFAULT_REGION = "US";
export const DEFAULT_CURRENCY = "USD";
export const DEFAULT_REGIONS_VERSION = "2025/01";
export const DEFAULT_PRICE_MICROS = "990000";
export const DEFAULT_SUBSCRIPTION_PRICE_UNITS = "5";
export const DEFAULT_BILLING_PERIOD = "P1M";
export const DEFAULT_OFFER_DURATION = "P1W";
export const MAX_PRODUCT_ID_LENGTH = 40;
export const MAX_BASE_PLAN_ID_LENGTH = 63;
export const MAX_OFFER_ID_LENGTH = 63;
export const MAX_SKU_LENGTH = 40;
export const MAX_LISTING_TITLE_LENGTH = 50;

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  jsonEqual(
    [...(left ?? [])].slice().sort(),
    [...(right ?? [])].slice().sort(),
  );

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

const isMissing = <E extends { readonly _tag: string }>(
  error: E,
): error is Extract<E, { readonly _tag: "NotFound" }> =>
  error._tag === "NotFound";

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.catchIf(isMissing, () => Effect.succeed(undefined)));

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) => effect.pipe(Effect.catchIf(isMissing, () => Effect.void));

const toGenerated = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  options: {
    maxLength: number;
    delimiter: string;
    prefixIfNeeded: string;
  },
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: options.maxLength,
      lowercase: true,
      delimiter: options.delimiter,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `${options.prefixIfNeeded}${generated}`.slice(0, options.maxLength);
    const trimmed = next
      .replace(new RegExp(`${options.delimiter}+`, "g"), options.delimiter)
      .replace(
        new RegExp(`^${options.delimiter}|${options.delimiter}$`, "g"),
        "",
      );
    return trimmed.length >= 1
      ? trimmed
      : `${options.prefixIfNeeded}1`.slice(0, options.maxLength);
  });

export const toProductId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  toGenerated(id, requested, existing, {
    maxLength: MAX_PRODUCT_ID_LENGTH,
    delimiter: "_",
    prefixIfNeeded: "a",
  });

export const toSku = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  toGenerated(id, requested, existing, {
    maxLength: MAX_SKU_LENGTH,
    delimiter: "_",
    prefixIfNeeded: "a",
  });

export const toBasePlanId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  toGenerated(id, requested, existing, {
    maxLength: MAX_BASE_PLAN_ID_LENGTH,
    delimiter: "-",
    prefixIfNeeded: "b",
  });

export const toOfferId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  toGenerated(id, requested, existing, {
    maxLength: MAX_OFFER_ID_LENGTH,
    delimiter: "-",
    prefixIfNeeded: "o",
  });

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_LISTING_TITLE_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    return (yield* toProductId(id, undefined, undefined)).slice(0, maxLength);
  });

export const defaultSubscriptionListings = (
  listings: readonly androidpublisher.SubscriptionListing[] | undefined,
  title: string,
): androidpublisher.SubscriptionListing[] =>
  listings && listings.length > 0
    ? listings.map((listing) => ({
        ...listing,
        languageCode: listing.languageCode ?? DEFAULT_LANGUAGE,
      }))
    : [{ languageCode: DEFAULT_LANGUAGE, title }];

export const defaultInappListings = (
  listings: androidpublisher.InAppProductListingMap | undefined,
  title: string,
  defaultLanguage: string,
): androidpublisher.InAppProductListingMap => {
  const next = { ...(listings ?? {}) };
  const current = next[defaultLanguage] ?? { title };
  next[defaultLanguage] = { ...current, title: current.title ?? title };
  return next;
};

export const publicBasePlans = (
  plans: readonly androidpublisher.BasePlan[] | undefined,
) =>
  plans?.map((plan) => ({
    regionalConfigs: plan.regionalConfigs,
    otherRegionsConfig: plan.otherRegionsConfig,
    offerTags: plan.offerTags,
    installmentsBasePlanType: plan.installmentsBasePlanType,
    autoRenewingBasePlanType: plan.autoRenewingBasePlanType,
    basePlanId: plan.basePlanId,
    prepaidBasePlanType: plan.prepaidBasePlanType,
  }));

export const defaultOfferPhases =
  (): androidpublisher.SubscriptionOfferPhase[] => [
    {
      duration: DEFAULT_OFFER_DURATION,
      recurrenceCount: 1,
      regionalConfigs: [{ regionCode: DEFAULT_REGION, free: {} }],
    },
  ];

export const defaultOfferRegionalConfigs =
  (): androidpublisher.RegionalSubscriptionOfferConfig[] => [
    { regionCode: DEFAULT_REGION, newSubscriberAvailability: true },
  ];

export const defaultOfferTargeting =
  (): androidpublisher.SubscriptionOfferTargeting => ({
    acquisitionRule: { scope: { thisSubscription: {} } },
  });

export const defaultInappPrice = (): androidpublisher.Price => ({
  currency: DEFAULT_CURRENCY,
  priceMicros: DEFAULT_PRICE_MICROS,
});

export const getSubscription = (packageName: string, productId: string) =>
  packageName.length === 0 || productId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        androidpublisher.getMonetizationSubscriptions({
          packageName,
          productId,
        }),
      );

export const getOffer = (
  packageName: string,
  productId: string,
  basePlanId: string,
  offerId: string,
) =>
  packageName.length === 0 ||
  productId.length === 0 ||
  basePlanId.length === 0 ||
  offerId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        androidpublisher.getMonetizationSubscriptionsBasePlansOffers({
          packageName,
          productId,
          basePlanId,
          offerId,
        }),
      );

export const getInappproduct = (packageName: string, sku: string) =>
  packageName.length === 0 || sku.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(androidpublisher.getInappproducts({ packageName, sku }));

export const getEdit = (packageName: string, editId: string) =>
  packageName.length === 0 || editId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(androidpublisher.getEdits({ packageName, editId }));
