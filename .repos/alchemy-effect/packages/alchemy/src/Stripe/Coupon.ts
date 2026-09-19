import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteCoupon,
  GetCoupons,
  GetCoupon,
  CreateCoupon,
  UpdateCoupon,
  type Coupon as StripeCoupon,
  type CreateCouponRequestCurrencyOptionsMap,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
  stripInternalMetadata,
  toMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** How long a customer who applies this coupon keeps the discount. */
export type CouponDuration = "forever" | "once" | "repeating";

export interface CouponAppliesTo {
  /**
   * Product ids this coupon applies to. Create-only — changing it
   * replaces the coupon.
   */
  products?: string[];
}

export interface CouponCurrencyOption {
  /**
   * Amount (in the currency's minor units) taken off the invoice subtotal.
   */
  amountOff: number;
}

export interface CouponProps {
  /**
   * Unique coupon id (the code used when applying the coupon). If omitted,
   * Stripe generates one. Changing it replaces the coupon.
   */
  couponId?: string;
  /**
   * Name displayed to customers on invoices and receipts. Defaults to the
   * coupon id if omitted. Mutable.
   */
  name?: string;
  /**
   * Percent taken off the invoice subtotal (0–100). Required unless
   * `amountOff` is set. Create-only — changing it replaces the coupon.
   */
  percentOff?: number;
  /**
   * Amount (in `currency` minor units) taken off the invoice subtotal.
   * Required unless `percentOff` is set. Create-only — changing it
   * replaces the coupon.
   */
  amountOff?: number;
  /**
   * Three-letter ISO currency code for `amountOff`. Required when
   * `amountOff` is set. Create-only — changing it replaces the coupon.
   */
  currency?: string;
  /**
   * Per-currency `amountOff` values (amount-based coupons only). Mutable.
   */
  currencyOptions?: Record<string, CouponCurrencyOption>;
  /**
   * How long the discount lasts when applied to a subscription.
   * @default "once"
   */
  duration?: CouponDuration;
  /**
   * Months the discount lasts when `duration` is `repeating`. Create-only.
   */
  durationInMonths?: number;
  /**
   * Maximum redemptions across all customers. Create-only.
   */
  maxRedemptions?: number;
  /**
   * Unix timestamp after which the coupon can no longer be redeemed.
   * Create-only.
   */
  redeemBy?: number;
  /**
   * Restrict the coupon to specific products. Create-only.
   */
  appliesTo?: CouponAppliesTo;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`. Mutable.
   */
  metadata?: Record<string, string>;
}

export type Coupon = Resource<
  "Stripe.Coupon",
  CouponProps,
  {
    /** Stripe coupon id (the redeemable code). */
    id: string;
    /** Name displayed to customers, if set. */
    name: string | undefined;
    /** Percent-off discount, if this is a percent coupon. */
    percentOff: number | undefined;
    /** Amount-off discount (minor units), if this is an amount coupon. */
    amountOff: number | undefined;
    /** Currency of `amountOff`, if this is an amount coupon. */
    currency: string | undefined;
    /** Per-currency amount-off values, if set. */
    currencyOptions: Record<string, CouponCurrencyOption> | undefined;
    /** How long the discount lasts. */
    duration: CouponDuration;
    /** Months the discount lasts when `duration` is `repeating`. */
    durationInMonths: number | undefined;
    /** Maximum redemptions, if set. */
    maxRedemptions: number | undefined;
    /** Unix timestamp after which the coupon cannot be redeemed. */
    redeemBy: number | undefined;
    /** Products this coupon applies to, if restricted. */
    appliesTo: CouponAppliesTo | undefined;
    /** Whether the coupon can still be applied. */
    valid: boolean;
    /** Times this coupon has been redeemed. */
    timesRedeemed: number;
    /** Unix timestamp when the coupon was created. */
    created: number;
    /** Whether the coupon exists in live mode. */
    livemode: boolean;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Stripe Coupon — a percent-off or amount-off discount applied to
 * subscriptions, invoices, Checkout sessions, and quotes. Coupons do not
 * apply to one-off charges or PaymentIntents.
 *
 * Create with either `percentOff` or `amountOff` + `currency`. `duration`
 * is `forever`, `once` (the default), or `repeating` (requires
 * `durationInMonths`). Name, metadata, and `currencyOptions` update in
 * place; the discount shape is immutable and changing it replaces the
 * coupon.
 *
 * @see https://docs.stripe.com/api/coupons
 *
 * ### Creating a Coupon
 * **Example:** Percent-off forever
 * ```typescript
 * const welcome = yield* Stripe.Coupon("welcome", {
 *   percentOff: 20,
 *   duration: "forever",
 *   name: "Welcome 20%",
 * });
 * ```
 *
 * **Example:** Amount-off once
 * ```typescript
 * const fiveOff = yield* Stripe.Coupon("five-off", {
 *   amountOff: 500,
 *   currency: "usd",
 *   duration: "once",
 *   name: "$5 off",
 * });
 * ```
 *
 * ### Repeating duration
 * **Example:** 10% off for three months
 * ```typescript
 * const quarterly = yield* Stripe.Coupon("quarterly", {
 *   percentOff: 10,
 *   duration: "repeating",
 *   durationInMonths: 3,
 * });
 * ```
 *
 * ### Updating a Coupon
 * **Example:** Rename and retag
 * ```typescript
 * const welcome = yield* Stripe.Coupon("welcome", {
 *   percentOff: 20,
 *   duration: "forever",
 *   name: "Welcome 20% (updated)",
 *   metadata: { campaign: "spring" },
 * });
 * ```
 *
 * @resource
 */
export const Coupon = Resource<Coupon>("Stripe.Coupon");

export class CouponNotResolved extends Data.TaggedError(
  "Stripe.CouponNotResolved",
)<{
  couponId: string | undefined;
}> {}

type CouponAttributes = Coupon["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const fromWireCurrencyOptions = (
  options: StripeCoupon["currency_options"] | undefined,
): Record<string, CouponCurrencyOption> | undefined => {
  if (options === undefined) return undefined;
  const out: Record<string, CouponCurrencyOption> = {};
  for (const [currency, value] of Object.entries(options)) {
    if (value === undefined) continue;
    out[currency] = { amountOff: value.amount_off };
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const toWireCurrencyOptions = (
  options: Record<string, CouponCurrencyOption> | undefined,
): CreateCouponRequestCurrencyOptionsMap | undefined => {
  if (options === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(options).map(([currency, value]) => [
      currency,
      { amount_off: value.amountOff },
    ]),
  );
};

const fromObservedAppliesTo = (
  appliesTo: StripeCoupon["applies_to"] | undefined,
): CouponAppliesTo | undefined => {
  if (appliesTo === undefined) return undefined;
  return { products: appliesTo.products };
};

const toAttrs = (coupon: StripeCoupon): CouponAttributes => ({
  id: coupon.id,
  name: coupon.name ?? undefined,
  percentOff: coupon.percent_off ?? undefined,
  amountOff: coupon.amount_off ?? undefined,
  currency: coupon.currency ?? undefined,
  currencyOptions: fromWireCurrencyOptions(coupon.currency_options),
  duration: coupon.duration,
  durationInMonths: coupon.duration_in_months ?? undefined,
  maxRedemptions: coupon.max_redemptions ?? undefined,
  redeemBy: coupon.redeem_by ?? undefined,
  appliesTo: fromObservedAppliesTo(coupon.applies_to),
  valid: coupon.valid,
  timesRedeemed: coupon.times_redeemed,
  created: coupon.created,
  livemode: coupon.livemode,
  metadata: userMetadata(coupon.metadata),
});

const isMissingCoupon = isMissingStripeResource;

const getById = (coupon: string) =>
  GetCoupon({ coupon }).pipe(
    Effect.catchIf(isMissingCoupon, () => Effect.succeed(undefined)),
  );

const listAllCoupons = Effect.fn(function* () {
  const coupons: StripeCoupon[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetCoupons({
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    coupons.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return coupons;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const coupons = yield* listAllCoupons();
  const matches: StripeCoupon[] = [];
  for (const coupon of coupons) {
    if (yield* hasAlchemyMetadata(id, tagRecord(coupon.metadata))) {
      matches.push(coupon);
    }
  }
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const observe = Effect.fn(function* (input: {
  id?: string;
  logicalId: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  return yield* findByAlchemyId(input.logicalId);
});

const desiredMetadata = Effect.fn(function* (
  id: string,
  metadata: Record<string, string> | undefined,
) {
  return {
    ...toMetadata(metadata),
    ...(yield* createInternalMetadata(id)),
  };
});

const replaceOnCreateOnlyChange = (
  olds: CouponProps | undefined,
  news: CouponProps,
  output: CouponAttributes | undefined,
): boolean => {
  if (
    news.couponId !== undefined &&
    news.couponId !== (output?.id ?? olds?.couponId)
  ) {
    return true;
  }
  if (
    (news.percentOff ?? output?.percentOff ?? olds?.percentOff) !==
    (output?.percentOff ?? olds?.percentOff)
  ) {
    return true;
  }
  if (
    (news.amountOff ?? output?.amountOff ?? olds?.amountOff) !==
    (output?.amountOff ?? olds?.amountOff)
  ) {
    return true;
  }
  if (
    (news.currency ?? output?.currency ?? olds?.currency) !==
    (output?.currency ?? olds?.currency)
  ) {
    return true;
  }
  if (
    (news.duration ?? output?.duration ?? olds?.duration ?? "once") !==
    (output?.duration ?? olds?.duration ?? "once")
  ) {
    return true;
  }
  if (
    (news.durationInMonths ??
      output?.durationInMonths ??
      olds?.durationInMonths) !==
    (output?.durationInMonths ?? olds?.durationInMonths)
  ) {
    return true;
  }
  if (
    (news.maxRedemptions ?? output?.maxRedemptions ?? olds?.maxRedemptions) !==
    (output?.maxRedemptions ?? olds?.maxRedemptions)
  ) {
    return true;
  }
  if (
    (news.redeemBy ?? output?.redeemBy ?? olds?.redeemBy) !==
    (output?.redeemBy ?? olds?.redeemBy)
  ) {
    return true;
  }
  if (
    news.appliesTo !== undefined &&
    !deepEqual(news.appliesTo, output?.appliesTo ?? olds?.appliesTo, {
      stripNullish: true,
    })
  ) {
    return true;
  }
  return false;
};

export const CouponProvider = () =>
  Provider.succeed(Coupon, {
    stables: [
      "id",
      "percentOff",
      "amountOff",
      "currency",
      "duration",
      "durationInMonths",
      "created",
      "livemode",
    ],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (replaceOnCreateOnlyChange(olds, news, output)) {
        const previousId = output?.id ?? olds?.couponId;
        const nextId = news.couponId ?? previousId;
        return {
          action: "replace" as const,
          deleteFirst: nextId !== undefined && nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      const existing = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const coupons = yield* listAllCoupons();
      return coupons
        .filter((coupon) => {
          const metadata = tagRecord(coupon.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const currencyOptions = toWireCurrencyOptions(news.currencyOptions);

      let current = yield* observe({
        id: news.couponId ?? output?.id,
        logicalId: id,
      });

      if (current === undefined) {
        current = yield* CreateCoupon({
          ...(news.couponId !== undefined ? { id: news.couponId } : {}),
          ...(news.name !== undefined ? { name: news.name } : {}),
          ...(news.percentOff !== undefined
            ? { percent_off: news.percentOff }
            : {}),
          ...(news.amountOff !== undefined
            ? { amount_off: news.amountOff }
            : {}),
          ...(news.currency !== undefined ? { currency: news.currency } : {}),
          ...(currencyOptions !== undefined
            ? { currency_options: currencyOptions }
            : {}),
          ...(news.duration !== undefined ? { duration: news.duration } : {}),
          ...(news.durationInMonths !== undefined
            ? { duration_in_months: news.durationInMonths }
            : {}),
          ...(news.maxRedemptions !== undefined
            ? { max_redemptions: news.maxRedemptions }
            : {}),
          ...(news.redeemBy !== undefined ? { redeem_by: news.redeemBy } : {}),
          ...(news.appliesTo?.products !== undefined
            ? { applies_to: { products: news.appliesTo.products } }
            : {}),
          metadata,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-coupon-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new CouponNotResolved({ couponId: news.couponId });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const nameChanged =
        news.name !== undefined && (current.name ?? undefined) !== news.name;
      const observedCurrencyOptions = fromWireCurrencyOptions(
        current.currency_options,
      );
      const currencyOptionsChanged =
        news.currencyOptions !== undefined &&
        !deepEqual(news.currencyOptions, observedCurrencyOptions, {
          stripNullish: true,
        });

      if (!nameChanged && !metadataChanged && !currencyOptionsChanged) {
        return toAttrs(current);
      }

      const updated = yield* UpdateCoupon({
        coupon: current.id,
        ...(nameChanged ? { name: news.name } : {}),
        ...(currencyOptionsChanged
          ? { currency_options: currencyOptions }
          : {}),
        ...(metadataChanged
          ? {
              metadata: {
                ...Object.fromEntries(
                  upsert.map((tag) => [tag.Key, tag.Value]),
                ),
                ...Object.fromEntries(removed.map((key) => [key, ""])),
              },
            }
          : {}),
      });
      return toAttrs(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteCoupon({ coupon: output.id }).pipe(
        Effect.catchIf(isMissingCoupon, () => Effect.void),
      );
    }),
  });
