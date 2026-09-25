import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetPrices,
  GetPrice,
  CreatePrice,
  UpdatePrice,
  type Price as StripePrice,
  type PriceProduct,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
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
import type { Product } from "./Product.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

export type PriceInterval = "day" | "month" | "week" | "year";
export type PriceUsageType = "licensed" | "metered";
export type PriceType = "one_time" | "recurring";

export interface PriceRecurring {
  /**
   * Billing frequency. Create-only — changing it replaces the price.
   */
  interval: PriceInterval;
  /**
   * Number of intervals between billings. Maximum of three years
   * (`3` years, `36` months, or `156` weeks).
   * @default 1
   */
  intervalCount?: number;
  /**
   * How quantity per period is determined. `licensed` bills the
   * subscription quantity; `metered` aggregates usage records.
   * @default "licensed"
   */
  usageType?: PriceUsageType;
  /**
   * Meter that tracks usage for a metered price. Create-only.
   */
  meter?: string;
  /**
   * Default trial length (days) when subscribing with
   * `trial_from_plan=true`. Create-only.
   */
  trialPeriodDays?: number;
}

export interface PriceProps {
  /**
   * Stripe Product this price belongs to — the resource, or a `prod_…`
   * id. Create-only — changing it replaces the price.
   */
  product: string | Product;
  /**
   * Three-letter ISO currency code, lowercase (e.g. `"usd"`). Create-only
   * — changing it replaces the price.
   */
  currency: string;
  /**
   * Amount in the currency's minor units (e.g. cents). Required unless
   * `unitAmountDecimal` is set or the price is tiered. Create-only —
   * changing it replaces the price.
   */
  unitAmount?: number;
  /**
   * Decimal amount in the currency's minor units, at most 12 decimal
   * places. Mutually exclusive with `unitAmount`. Create-only.
   */
  unitAmountDecimal?: string;
  /**
   * Recurring billing configuration. Omit for a one-time price.
   * Create-only — changing it replaces the price.
   */
  recurring?: PriceRecurring;
  /**
   * Brief description of the price, hidden from customers.
   */
  nickname?: string;
  /**
   * Whether the price can be used for new purchases.
   * @default true
   */
  active?: boolean;
  /**
   * Lookup key used to retrieve this price from a static string (max 200
   * characters).
   */
  lookupKey?: string;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`.
   */
  metadata?: Record<string, string>;
}

export type Price = Resource<
  "Stripe.Price",
  PriceProps,
  {
    /** Stripe price id (`price_…`). */
    id: string;
    /** Id of the product this price belongs to. */
    product: string;
    /** Three-letter ISO currency code. */
    currency: string;
    /** Amount in the currency's minor units, or `undefined` when unset. */
    unitAmount: number | undefined;
    /** Decimal amount in the currency's minor units, or `undefined`. */
    unitAmountDecimal: string | undefined;
    /** Whether the price can be used for new purchases. */
    active: boolean;
    /** Brief description of the price, hidden from customers. */
    nickname: string | undefined;
    /** Lookup key, if set. */
    lookupKey: string | undefined;
    /** `one_time` or `recurring`. */
    type: PriceType;
    /** Recurring billing configuration, if this is a recurring price. */
    recurring: PriceRecurring | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the price was created. */
    created: number;
    /** Whether the price exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Price — the unit cost attached to a Product. Currency, amount,
 * product, and recurring interval are immutable (changing them replaces
 * the price). Nickname, metadata, lookup key, and `active` update in
 * place. Prices cannot be deleted; destroy deactivates them
 * (`active=false`).
 *
 * @see https://docs.stripe.com/api/prices
 *
 * ### Creating a Price
 * **Example:** One-time price
 * ```typescript
 * const product = yield* Stripe.Product("pro-plan", { name: "Pro Plan" });
 * const price = yield* Stripe.Price("pro-once", {
 *   product,
 *   currency: "usd",
 *   unitAmount: 2000,
 * });
 * ```
 *
 * **Example:** Recurring monthly price
 * ```typescript
 * const price = yield* Stripe.Price("pro-monthly", {
 *   product,
 *   currency: "usd",
 *   unitAmount: 1500,
 *   recurring: { interval: "month" },
 *   nickname: "Pro monthly",
 * });
 * ```
 *
 * ### Updating a Price
 * **Example:** Nickname, metadata, and deactivate
 * ```typescript
 * const price = yield* Stripe.Price("pro-monthly", {
 *   product,
 *   currency: "usd",
 *   unitAmount: 1500,
 *   recurring: { interval: "month" },
 *   nickname: "Pro monthly (paused)",
 *   active: false,
 *   metadata: { tier: "pro" },
 * });
 * ```
 *
 * ### Destroying a Price
 * **Example:** Deactivate instead of delete
 * ```typescript
 * // Stripe cannot delete a used price. `alchemy destroy` sets
 * // `active: false`.
 * ```
 *
 * @resource
 */
export const Price = Resource<Price>("Stripe.Price");

export class PriceNotResolved extends Data.TaggedError(
  "Stripe.PriceNotResolved",
)<{
  product: string;
  currency: string;
}> {}

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const productIdOf = (product: PriceProduct): string => {
  if (typeof product === "string") return product;
  return product.id;
};

const alchemyProductId = (product: string | Product): string => {
  if (typeof product === "string") return product;
  const id = product.id as unknown;
  if (typeof id === "string") return id;
  return String(id);
};

const toRecurring = (
  recurring: StripePrice["recurring"],
): PriceRecurring | undefined => {
  if (recurring == null) return undefined;
  return {
    interval: recurring.interval as PriceInterval,
    intervalCount: recurring.interval_count,
    usageType: recurring.usage_type as PriceUsageType,
    ...(recurring.meter != null ? { meter: recurring.meter } : {}),
    ...(recurring.trial_period_days != null
      ? { trialPeriodDays: recurring.trial_period_days }
      : {}),
  };
};

const toAttrs = (price: StripePrice) => ({
  id: price.id,
  product: productIdOf(price.product),
  currency: price.currency,
  unitAmount: price.unit_amount ?? undefined,
  unitAmountDecimal: price.unit_amount_decimal ?? undefined,
  active: price.active,
  nickname: price.nickname ?? undefined,
  lookupKey: price.lookup_key ?? undefined,
  type: price.type as PriceType,
  recurring: toRecurring(price.recurring),
  metadata: userMetadata(price.metadata),
  created: price.created,
  livemode: price.livemode,
});

const isMissingPrice = isMissingStripeResource;

const getById = (price: string) =>
  GetPrice({ price }).pipe(
    Effect.catchIf(isMissingPrice, () => Effect.succeed(undefined)),
  );

const listByActive = Effect.fn(function* (active: boolean) {
  const prices: StripePrice[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetPrices({
      active,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    prices.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return prices;
});

const listAllPrices = Effect.fn(function* () {
  const [active, inactive] = yield* Effect.all(
    [listByActive(true), listByActive(false)],
    { concurrency: 2 },
  );
  const seen = new Set<string>();
  const prices: StripePrice[] = [];
  for (const price of [...active, ...inactive]) {
    if (seen.has(price.id)) continue;
    seen.add(price.id);
    prices.push(price);
  }
  return prices;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const prices = yield* listAllPrices();
  const matches: StripePrice[] = [];
  for (const price of prices) {
    if (yield* hasAlchemyMetadata(id, tagRecord(price.metadata))) {
      matches.push(price);
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

const recurringEqual = (
  news: PriceRecurring | undefined,
  observed: PriceRecurring | undefined,
): boolean => {
  if (news === undefined) return true;
  if (observed === undefined) return false;
  if (news.interval !== observed.interval) return false;
  if ((news.intervalCount ?? 1) !== (observed.intervalCount ?? 1)) return false;
  if ((news.usageType ?? "licensed") !== (observed.usageType ?? "licensed")) {
    return false;
  }
  if ((news.meter ?? undefined) !== (observed.meter ?? undefined)) return false;
  if (
    (news.trialPeriodDays ?? undefined) !==
    (observed.trialPeriodDays ?? undefined)
  ) {
    return false;
  }
  return true;
};

const shouldReplace = (
  news: PriceProps,
  output: Price["Attributes"] | undefined,
) => {
  if (output === undefined) return false;
  if (alchemyProductId(news.product) !== output.product) return true;
  if (news.currency !== output.currency) return true;
  if (news.unitAmount !== undefined && news.unitAmount !== output.unitAmount) {
    return true;
  }
  if (
    news.unitAmountDecimal !== undefined &&
    news.unitAmountDecimal !== output.unitAmountDecimal
  ) {
    return true;
  }
  if (!recurringEqual(news.recurring, output.recurring)) return true;
  return false;
};

export const PriceProvider = () =>
  Provider.succeed(Price, {
    stables: ["id", "product", "currency", "type", "created", "livemode"],

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
      // Default list API is active prices; inactive (deactivated) rows
      // stay in Stripe but must not re-enter nuke. Filter to alchemy_stack
      // so account-wide teardown only touches our rows.
      const prices = yield* listByActive(true);
      return prices
        .filter((price) => {
          const metadata = tagRecord(price.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredActive = news.active ?? true;
      const desiredNickname = news.nickname ?? "";
      const desiredLookupKey = news.lookupKey ?? "";

      let current: StripePrice | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      // A previous generation (same logical id, different immutable
      // fields) must not be reused — Stripe prices cannot change amount,
      // currency, product, or recurring interval.
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreatePrice({
          product: alchemyProductId(news.product),
          currency: news.currency,
          active: desiredActive,
          metadata,
          ...(news.unitAmount !== undefined
            ? { unit_amount: news.unitAmount }
            : {}),
          ...(news.unitAmountDecimal !== undefined
            ? { unit_amount_decimal: news.unitAmountDecimal }
            : {}),
          ...(news.recurring !== undefined
            ? {
                recurring: {
                  interval: news.recurring.interval,
                  ...(news.recurring.intervalCount !== undefined
                    ? { interval_count: news.recurring.intervalCount }
                    : {}),
                  ...(news.recurring.usageType !== undefined
                    ? { usage_type: news.recurring.usageType }
                    : {}),
                  ...(news.recurring.meter !== undefined
                    ? { meter: news.recurring.meter }
                    : {}),
                  ...(news.recurring.trialPeriodDays !== undefined
                    ? { trial_period_days: news.recurring.trialPeriodDays }
                    : {}),
                },
              }
            : {}),
          ...(desiredNickname.length > 0 ? { nickname: desiredNickname } : {}),
          ...(desiredLookupKey.length > 0
            ? { lookup_key: desiredLookupKey, transfer_lookup_key: true }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-price-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new PriceNotResolved({
          product: alchemyProductId(news.product),
          currency: news.currency,
        });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const activeChanged = current.active !== desiredActive;
      const nicknameChanged = (current.nickname ?? "") !== desiredNickname;
      const lookupKeyChanged = (current.lookup_key ?? "") !== desiredLookupKey;

      if (
        !activeChanged &&
        !nicknameChanged &&
        !lookupKeyChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdatePrice({
        price: current.id,
        ...(activeChanged ? { active: desiredActive } : {}),
        ...(nicknameChanged ? { nickname: desiredNickname } : {}),
        ...(lookupKeyChanged
          ? { lookup_key: desiredLookupKey, transfer_lookup_key: true }
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
      yield* UpdatePrice({
        price: existing.id,
        active: false,
      }).pipe(Effect.catchIf(isMissingPrice, () => Effect.void));
    }),
  });
