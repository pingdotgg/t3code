import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetShippingRates,
  GetShippingRate,
  CreateShippingRate,
  UpdateShippingRate,
  type CreateShippingRateRequestFixedAmountCurrencyOptionsMap,
  type ShippingRate as StripeShippingRate,
  type ShippingRateFixedAmountCurrencyOptionsMap,
  type ShippingRateTaxCode,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
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

const NAME_MAX_LENGTH = 250;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** The type of calculation used on the shipping rate. */
export type ShippingRateType = "fixed_amount";

/** Whether the rate is considered inclusive or exclusive of taxes. */
export type ShippingRateTaxBehavior = "exclusive" | "inclusive" | "unspecified";

/** Unit of time for a delivery-estimate bound. */
export type ShippingRateDeliveryEstimateUnit =
  | "business_day"
  | "day"
  | "hour"
  | "month"
  | "week";

export interface ShippingRateDeliveryEstimateBound {
  /**
   * Unit of time for this bound.
   */
  unit: ShippingRateDeliveryEstimateUnit;
  /**
   * Must be greater than 0.
   */
  value: number;
}

export interface ShippingRateDeliveryEstimate {
  /**
   * Lower bound of the estimated range. Omit for no lower bound.
   * Create-only — changing it replaces the shipping rate.
   */
  minimum?: ShippingRateDeliveryEstimateBound;
  /**
   * Upper bound of the estimated range. Omit for no upper bound.
   * Create-only — changing it replaces the shipping rate.
   */
  maximum?: ShippingRateDeliveryEstimateBound;
}

export interface ShippingRateCurrencyOption {
  /**
   * Amount (in the currency's minor units) to charge for this currency.
   */
  amount: number;
  /**
   * Whether this currency option is inclusive of taxes.
   */
  taxBehavior?: ShippingRateTaxBehavior;
}

export interface ShippingRateProps {
  /**
   * Customer-facing name shown on Checkout sessions. If omitted, a unique
   * name is generated from the stack, stage, and logical id. Create-only
   * — changing it replaces the shipping rate.
   */
  displayName?: string;
  /**
   * Calculation type. Only `fixed_amount` is supported.
   * @default "fixed_amount"
   */
  type?: ShippingRateType;
  /**
   * Amount in the currency's minor units (e.g. cents). Create-only —
   * changing it replaces the shipping rate.
   */
  amount: number;
  /**
   * Three-letter ISO currency code, lowercase (e.g. `"usd"`). Create-only
   * — changing it replaces the shipping rate.
   */
  currency: string;
  /**
   * Per-currency amounts. Mutable (amounts and tax behavior per currency
   * can be updated in place).
   */
  currencyOptions?: Record<string, ShippingRateCurrencyOption>;
  /**
   * Estimated delivery range shown on Checkout sessions. Create-only —
   * changing it replaces the shipping rate.
   */
  deliveryEstimate?: ShippingRateDeliveryEstimate;
  /**
   * Whether the rate is considered inclusive of taxes.
   */
  taxBehavior?: ShippingRateTaxBehavior;
  /**
   * Tax code id (the shipping tax code is `txcd_92010001`). Create-only —
   * changing it replaces the shipping rate.
   */
  taxCode?: string;
  /**
   * Whether the shipping rate can be used for new purchases.
   * @default true
   */
  active?: boolean;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`.
   */
  metadata?: Record<string, string>;
}

export type ShippingRate = Resource<
  "Stripe.ShippingRate",
  ShippingRateProps,
  {
    /** Stripe shipping rate id (`shr_…`). */
    id: string;
    /** Customer-facing name shown on Checkout sessions. */
    displayName: string;
    /** Calculation type (`fixed_amount`). */
    type: ShippingRateType;
    /** Amount in the currency's minor units. */
    amount: number;
    /** Three-letter ISO currency code. */
    currency: string;
    /** Per-currency amounts, if set. */
    currencyOptions: Record<string, ShippingRateCurrencyOption> | undefined;
    /** Whether the shipping rate can be used for new purchases. */
    active: boolean;
    /** Estimated delivery range, if set. */
    deliveryEstimate: ShippingRateDeliveryEstimate | undefined;
    /** Whether the rate is considered inclusive of taxes. */
    taxBehavior: ShippingRateTaxBehavior | undefined;
    /** Tax code id, if set. */
    taxCode: string | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the shipping rate was created. */
    created: number;
    /** Whether the shipping rate exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Shipping Rate — the price of shipping presented to customers
 * and applied to a purchase. Amount, currency, display name, delivery
 * estimate, and tax code are immutable (changing them replaces the
 * rate). `active`, metadata, `taxBehavior`, and per-currency
 * `currencyOptions` update in place. Shipping rates cannot be deleted;
 * destroy deactivates them (`active=false`).
 *
 * @see https://docs.stripe.com/api/shipping_rates
 *
 * ### Creating a Shipping Rate
 * **Example:** Fixed-amount USD rate
 * ```typescript
 * const ground = yield* Stripe.ShippingRate("ground", {
 *   displayName: "Ground",
 *   amount: 500,
 *   currency: "usd",
 * });
 * ```
 *
 * **Example:** Rate with a delivery estimate
 * ```typescript
 * const express = yield* Stripe.ShippingRate("express", {
 *   displayName: "Express",
 *   amount: 1500,
 *   currency: "usd",
 *   deliveryEstimate: {
 *     minimum: { unit: "business_day", value: 1 },
 *     maximum: { unit: "business_day", value: 3 },
 *   },
 * });
 * ```
 *
 * ### Updating a Shipping Rate
 * **Example:** Pause the rate and retag
 * ```typescript
 * const ground = yield* Stripe.ShippingRate("ground", {
 *   displayName: "Ground",
 *   amount: 500,
 *   currency: "usd",
 *   active: false,
 *   metadata: { region: "us" },
 * });
 * ```
 *
 * ### Deactivating a Shipping Rate
 * **Example:** Destroy deactivates rather than deleting
 * ```typescript
 * // stack.destroy() / resource removal sets active: false
 * const ground = yield* Stripe.ShippingRate("ground", {
 *   displayName: "Ground",
 *   amount: 500,
 *   currency: "usd",
 * });
 * ```
 *
 * @resource
 */
export const ShippingRate = Resource<ShippingRate>("Stripe.ShippingRate");

export class ShippingRateNotResolved extends Data.TaggedError(
  "Stripe.ShippingRateNotResolved",
)<{
  displayName: string;
  currency: string;
}> {}

type ShippingRateAttributes = ShippingRate["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const taxCodeOf = (
  taxCode: ShippingRateTaxCode | null | undefined,
): string | undefined => {
  if (taxCode == null) return undefined;
  if (typeof taxCode === "string") return taxCode;
  return taxCode.id;
};

const fromWireCurrencyOptions = (
  options: ShippingRateFixedAmountCurrencyOptionsMap | undefined,
): Record<string, ShippingRateCurrencyOption> | undefined => {
  if (options === undefined) return undefined;
  const out: Record<string, ShippingRateCurrencyOption> = {};
  for (const [currency, value] of Object.entries(options)) {
    if (value === undefined) continue;
    out[currency] = {
      amount: value.amount,
      taxBehavior: value.tax_behavior,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const withoutBaseCurrency = <T>(
  options: Record<string, T> | undefined,
  currency: string,
): Record<string, T> | undefined => {
  if (options === undefined) return undefined;
  const extra = Object.fromEntries(
    Object.entries(options).filter(([key]) => key !== currency),
  );
  return Object.keys(extra).length > 0 ? extra : undefined;
};

const toWireCurrencyOptions = (
  options: Record<string, ShippingRateCurrencyOption> | undefined,
): CreateShippingRateRequestFixedAmountCurrencyOptionsMap | undefined => {
  if (options === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(options).map(([currency, value]) => [
      currency,
      {
        amount: value.amount,
        ...(value.taxBehavior !== undefined
          ? { tax_behavior: value.taxBehavior }
          : {}),
      },
    ]),
  );
};

const fromObservedEstimate = (
  estimate: StripeShippingRate["delivery_estimate"],
): ShippingRateDeliveryEstimate | undefined => {
  if (estimate == null) return undefined;
  const out: ShippingRateDeliveryEstimate = {};
  if (estimate.minimum != null) {
    out.minimum = {
      unit: estimate.minimum.unit,
      value: estimate.minimum.value,
    };
  }
  if (estimate.maximum != null) {
    out.maximum = {
      unit: estimate.maximum.unit,
      value: estimate.maximum.value,
    };
  }
  return out.minimum !== undefined || out.maximum !== undefined
    ? out
    : undefined;
};

const toAttrs = (rate: StripeShippingRate): ShippingRateAttributes => ({
  id: rate.id,
  displayName: rate.display_name ?? "",
  type: rate.type,
  amount: rate.fixed_amount?.amount ?? 0,
  currency: rate.fixed_amount?.currency ?? "",
  currencyOptions: fromWireCurrencyOptions(rate.fixed_amount?.currency_options),
  active: rate.active,
  deliveryEstimate: fromObservedEstimate(rate.delivery_estimate),
  taxBehavior: rate.tax_behavior ?? undefined,
  taxCode: taxCodeOf(rate.tax_code),
  metadata: userMetadata(rate.metadata),
  created: rate.created,
  livemode: rate.livemode,
});

const toDisplayName = (
  id: string,
  displayName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      displayName ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: NAME_MAX_LENGTH }))
    );
  });

const isMissingShippingRate = isMissingStripeResource;

const getById = (shipping_rate_token: string) =>
  GetShippingRate({ shipping_rate_token }).pipe(
    Effect.catchIf(isMissingShippingRate, () => Effect.succeed(undefined)),
  );

const listByActive = Effect.fn(function* (active: boolean) {
  const rates: StripeShippingRate[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetShippingRates({
      active,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    rates.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return rates;
});

const listAllShippingRates = Effect.fn(function* () {
  const [active, inactive] = yield* Effect.all(
    [listByActive(true), listByActive(false)],
    { concurrency: 2 },
  );
  const seen = new Set<string>();
  const rates: StripeShippingRate[] = [];
  for (const rate of [...active, ...inactive]) {
    if (seen.has(rate.id)) continue;
    seen.add(rate.id);
    rates.push(rate);
  }
  return rates;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const rates = yield* listAllShippingRates();
  const matches: StripeShippingRate[] = [];
  for (const rate of rates) {
    if (yield* hasAlchemyMetadata(id, tagRecord(rate.metadata))) {
      matches.push(rate);
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

const shouldReplace = (
  news: ShippingRateProps,
  output: ShippingRateAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.amount !== output.amount) return true;
  if (news.currency !== output.currency) return true;
  if ((news.type ?? "fixed_amount") !== output.type) return true;
  if (
    news.displayName !== undefined &&
    news.displayName !== output.displayName
  ) {
    return true;
  }
  if (
    news.taxCode !== undefined &&
    news.taxCode !== (output.taxCode ?? undefined)
  ) {
    return true;
  }
  if (
    news.deliveryEstimate !== undefined &&
    !deepEqual(news.deliveryEstimate, output.deliveryEstimate, {
      stripNullish: true,
    })
  ) {
    return true;
  }
  return false;
};

export const ShippingRateProvider = () =>
  Provider.succeed(ShippingRate, {
    stables: ["id", "type", "amount", "currency", "created", "livemode"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
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
      // Default list API can return inactive rates; deactivated rows stay
      // in Stripe but must not re-enter nuke.
      const rates = yield* listByActive(true);
      return rates
        .filter((rate) => {
          const metadata = tagRecord(rate.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredActive = news.active ?? true;
      const desiredType = news.type ?? "fixed_amount";
      const extraCurrencyOptions = withoutBaseCurrency(
        news.currencyOptions,
        news.currency,
      );
      const currencyOptions = toWireCurrencyOptions(extraCurrencyOptions);

      let current: StripeShippingRate | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      // A previous generation (same logical id, different immutable
      // fields) must not be reused — Stripe shipping rates cannot change
      // amount, currency, display name, delivery estimate, or tax code.
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateShippingRate({
          display_name: displayName,
          type: desiredType,
          fixed_amount: {
            amount: news.amount,
            currency: news.currency,
            ...(currencyOptions !== undefined
              ? { currency_options: currencyOptions }
              : {}),
          },
          metadata,
          ...(news.deliveryEstimate !== undefined
            ? {
                delivery_estimate: {
                  ...(news.deliveryEstimate.minimum !== undefined
                    ? { minimum: news.deliveryEstimate.minimum }
                    : {}),
                  ...(news.deliveryEstimate.maximum !== undefined
                    ? { maximum: news.deliveryEstimate.maximum }
                    : {}),
                },
              }
            : {}),
          ...(news.taxBehavior !== undefined
            ? { tax_behavior: news.taxBehavior }
            : {}),
          ...(news.taxCode !== undefined ? { tax_code: news.taxCode } : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-shipping-rate-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new ShippingRateNotResolved({
          displayName,
          currency: news.currency,
        });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const activeChanged = current.active !== desiredActive;
      const taxBehaviorChanged =
        news.taxBehavior !== undefined &&
        (current.tax_behavior ?? undefined) !== news.taxBehavior;
      const observedCurrencyOptions = withoutBaseCurrency(
        fromWireCurrencyOptions(current.fixed_amount?.currency_options),
        news.currency,
      );
      const currencyOptionsChanged =
        extraCurrencyOptions !== undefined &&
        !deepEqual(extraCurrencyOptions, observedCurrencyOptions, {
          stripNullish: true,
        });

      if (
        !activeChanged &&
        !taxBehaviorChanged &&
        !currencyOptionsChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdateShippingRate({
        shipping_rate_token: current.id,
        ...(activeChanged ? { active: desiredActive } : {}),
        ...(taxBehaviorChanged ? { tax_behavior: news.taxBehavior } : {}),
        ...(currencyOptionsChanged
          ? { fixed_amount: { currency_options: currencyOptions } }
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
      const existing = yield* getById(output.id);
      if (existing === undefined || !existing.active) return;
      yield* UpdateShippingRate({
        shipping_rate_token: existing.id,
        active: false,
      }).pipe(Effect.catchIf(isMissingShippingRate, () => Effect.void));
    }),
  });
