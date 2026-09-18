import { withRequestOptions } from "@distilled.cloud/stripe";
import { isMissingStripeResource } from "./missing.ts";
import {
  GetPromotionCodes,
  GetPromotionCode,
  CreatePromotionCode,
  UpdatePromotionCode,
  type CreatePromotionCodeRequestRestrictions,
  type CreatePromotionCodeRequestRestrictionsCurrencyOptionsMap,
  type PromotionCode as StripePromotionCode,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { recordsEqual } from "../Util/equal.ts";
import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
  stripInternalMetadata,
  toMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

export interface PromotionCodeCurrencyOption {
  /**
   * Minimum amount (in the currency's minor units) required to redeem this
   * promotion code.
   */
  minimumAmount: number;
}

export interface PromotionCodeRestrictions {
  /**
   * When true, the code can only be redeemed by customers with no successful
   * payments or invoices. Create-only — changing it replaces the code.
   */
  firstTimeTransaction?: boolean;
  /**
   * Minimum amount required to redeem this code. Create-only.
   */
  minimumAmount?: number;
  /**
   * Three-letter ISO currency code for `minimumAmount`. Create-only.
   */
  minimumAmountCurrency?: string;
  /**
   * Per-currency minimum amounts. Mutable on update.
   */
  currencyOptions?: Record<string, PromotionCodeCurrencyOption>;
}

export interface PromotionCodeProps {
  /**
   * Id of the coupon this promotion code redeems. Changing it replaces
   * the promotion code.
   */
  coupon: string;
  /**
   * Customer-facing code. Unique among active promotion codes (case
   * insensitive). Valid characters: `A-Z`, `a-z`, `0-9`, `-`. If omitted,
   * a unique code is generated from the stack, stage, and logical id.
   * Changing it replaces the promotion code.
   */
  code?: string;
  /**
   * Whether the promotion code can currently be redeemed.
   * @default true
   */
  active?: boolean;
  /**
   * Restrict redemption to this customer id. Create-only.
   */
  customer?: string;
  /**
   * Restrict redemption to this customer account id. Create-only.
   */
  customerAccount?: string;
  /**
   * Unix timestamp after which the code can no longer be redeemed.
   * Create-only.
   */
  expiresAt?: number;
  /**
   * Maximum number of times this code can be redeemed. Create-only.
   */
  maxRedemptions?: number;
  /**
   * User metadata. Alchemy ownership keys (`alchemy_stack`,
   * `alchemy_stage`, `alchemy_id`) are merged in automatically. Keys
   * cannot contain `:`.
   */
  metadata?: Record<string, string>;
  /**
   * Redemption restrictions.
   */
  restrictions?: PromotionCodeRestrictions;
}

export interface PromotionCode extends Resource<
  "Stripe.PromotionCode",
  PromotionCodeProps,
  {
    /** Stripe promotion code id (`promo_…`). */
    id: string;
    /** Customer-facing code. */
    code: string;
    /** Whether the code is currently redeemable. */
    active: boolean;
    /** Coupon id this code points at. */
    couponId: string;
    /** Restricted customer id, if any. */
    customer: string | undefined;
    /** Restricted customer account id, if any. */
    customerAccount: string | undefined;
    /** Unix expiry timestamp, if any. */
    expiresAt: number | undefined;
    /** Whether this object exists in live mode. */
    livemode: boolean;
    /** Maximum redemptions, if any. */
    maxRedemptions: number | undefined;
    /** Times this code has been redeemed. */
    timesRedeemed: number;
    /** Unix creation timestamp. */
    created: number;
    /** User metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Current redemption restrictions. */
    restrictions: PromotionCodeRestrictions;
  },
  never,
  Providers
> {}

/**
 * A Stripe Promotion Code — a customer-redeemable code for an underlying
 * coupon. Stripe does not hard-delete promotion codes; destroying this
 * resource deactivates it (`active: false`).
 *
 * `code`, `coupon`, `customer`, `expiresAt`, `maxRedemptions`, and most
 * restrictions are immutable. Changing them replaces the promotion code
 * (create a new one, then deactivate the old). `active`, `metadata`, and
 * `restrictions.currencyOptions` update in place.
 *
 * @see https://docs.stripe.com/api/promotion_codes
 *
 * ### Creating a Promotion Code
 * **Example:** Code for an existing coupon
 * ```typescript
 * const welcome = yield* Stripe.PromotionCode("welcome", {
 *   coupon: "25OFF",
 *   code: "WELCOME25",
 * });
 * ```
 *
 * **Example:** Generated code with a redemption cap
 * ```typescript
 * const launch = yield* Stripe.PromotionCode("launch", {
 *   coupon: "10OFF",
 *   maxRedemptions: 100,
 *   metadata: { campaign: "launch" },
 * });
 * ```
 *
 * ### Updating a Promotion Code
 * **Example:** Pause redemptions and update metadata
 * ```typescript
 * const welcome = yield* Stripe.PromotionCode("welcome", {
 *   coupon: "25OFF",
 *   code: "WELCOME25",
 *   active: false,
 *   metadata: { campaign: "paused" },
 * });
 * ```
 *
 * ### Deactivating a Promotion Code
 * **Example:** Destroy deactivates rather than deleting
 * ```typescript
 * // stack.destroy() / resource removal sets active: false
 * const welcome = yield* Stripe.PromotionCode("welcome", {
 *   coupon: "25OFF",
 *   code: "WELCOME25",
 * });
 * ```
 *
 * @resource
 */
export const PromotionCode = Resource<PromotionCode>("Stripe.PromotionCode");

export class PromotionCodeNotResolved extends Data.TaggedError(
  "Stripe.PromotionCodeNotResolved",
)<{
  code: string;
}> {}

type PromotionCodeAttributes = PromotionCode["Attributes"];

const CODE_MAX_LENGTH = 40;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

const idOf = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return undefined;
};

const couponIdOf = (promo: StripePromotionCode): string =>
  idOf(promo.promotion?.coupon) ?? "";

const fromWireCurrencyOptions = (
  options: StripePromotionCode["restrictions"]["currency_options"] | undefined,
): Record<string, PromotionCodeCurrencyOption> | undefined => {
  if (options === undefined) return undefined;
  const out: Record<string, PromotionCodeCurrencyOption> = {};
  for (const [currency, value] of Object.entries(options)) {
    if (value === undefined) continue;
    out[currency] = { minimumAmount: value.minimum_amount };
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const toWireCurrencyOptions = (
  options: Record<string, PromotionCodeCurrencyOption> | undefined,
): CreatePromotionCodeRequestRestrictionsCurrencyOptionsMap | undefined => {
  if (options === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(options).map(([currency, value]) => [
      currency,
      { minimum_amount: value.minimumAmount },
    ]),
  );
};

const fromObservedRestrictions = (
  restrictions: StripePromotionCode["restrictions"] | undefined,
): PromotionCodeRestrictions => {
  if (restrictions === undefined) return {};
  return {
    firstTimeTransaction: restrictions.first_time_transaction,
    ...(restrictions.minimum_amount != null
      ? { minimumAmount: restrictions.minimum_amount }
      : {}),
    ...(restrictions.minimum_amount_currency != null
      ? { minimumAmountCurrency: restrictions.minimum_amount_currency }
      : {}),
    ...(fromWireCurrencyOptions(restrictions.currency_options) !== undefined
      ? {
          currencyOptions: fromWireCurrencyOptions(
            restrictions.currency_options,
          ),
        }
      : {}),
  };
};

const toCreateRestrictions = (
  restrictions: PromotionCodeRestrictions | undefined,
): CreatePromotionCodeRequestRestrictions | undefined => {
  if (restrictions === undefined) return undefined;
  const currency_options = toWireCurrencyOptions(restrictions.currencyOptions);
  const body: CreatePromotionCodeRequestRestrictions = {
    ...(restrictions.firstTimeTransaction !== undefined
      ? { first_time_transaction: restrictions.firstTimeTransaction }
      : {}),
    ...(restrictions.minimumAmount !== undefined
      ? { minimum_amount: restrictions.minimumAmount }
      : {}),
    ...(restrictions.minimumAmountCurrency !== undefined
      ? { minimum_amount_currency: restrictions.minimumAmountCurrency }
      : {}),
    ...(currency_options !== undefined ? { currency_options } : {}),
  };
  return Object.keys(body).length > 0 ? body : undefined;
};

const toAttrs = (promo: StripePromotionCode): PromotionCodeAttributes => ({
  id: promo.id,
  code: promo.code,
  active: promo.active,
  couponId: couponIdOf(promo),
  customer: idOf(promo.customer),
  customerAccount: promo.customer_account ?? undefined,
  expiresAt: promo.expires_at ?? undefined,
  livemode: promo.livemode,
  maxRedemptions: promo.max_redemptions ?? undefined,
  timesRedeemed: promo.times_redeemed,
  created: promo.created,
  metadata: stripInternalMetadata(tagRecord(promo.metadata)),
  restrictions: fromObservedRestrictions(promo.restrictions),
});

const toCode = (id: string, code: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      code ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: CODE_MAX_LENGTH }))
    );
  });

const isResourceMissing = isMissingStripeResource;

const getById = (promotionCode: string) =>
  GetPromotionCode({
    promotion_code: promotionCode,
    expand: ["promotion.coupon"],
  }).pipe(Effect.catchIf(isResourceMissing, () => Effect.succeed(undefined)));

const findByCode = (code: string) =>
  Effect.gen(function* () {
    const [active, inactive] = yield* Effect.all(
      [
        GetPromotionCodes({
          code,
          active: true,
          limit: LIST_PAGE_SIZE,
          expand: ["data.promotion.coupon"],
        }),
        GetPromotionCodes({
          code,
          active: false,
          limit: LIST_PAGE_SIZE,
          expand: ["data.promotion.coupon"],
        }),
      ],
      { concurrency: 2 },
    );
    return (
      active.data.find((item) => item.code === code) ??
      inactive.data.find((item) => item.code === code)
    );
  });

const listByActive = Effect.fn(function* (active: boolean) {
  const items: StripePromotionCode[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const result = yield* GetPromotionCodes({
      active,
      limit: LIST_PAGE_SIZE,
      expand: ["data.promotion.coupon"],
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    items.push(...result.data);
    if (!result.has_more || result.data.length === 0) break;
    startingAfter = result.data[result.data.length - 1]?.id;
    if (startingAfter === undefined) break;
  }
  return items;
});

const listAllPromotionCodes = Effect.fn(function* () {
  const [active, inactive] = yield* Effect.all(
    [listByActive(true), listByActive(false)],
    { concurrency: 2 },
  );
  const seen = new Set<string>();
  const items: StripePromotionCode[] = [];
  for (const item of [...active, ...inactive]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
});

const observe = Effect.fn(function* (input: { id?: string; code: string }) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  return yield* findByCode(input.code);
});

const desiredMetadata = Effect.fn(function* (
  id: string,
  user: Record<string, string> | undefined,
) {
  return {
    ...toMetadata(user),
    ...(yield* createInternalMetadata(id)),
  };
});

const replaceOnCreateOnlyChange = (
  olds: PromotionCodeProps | undefined,
  news: PromotionCodeProps,
  output: PromotionCodeAttributes | undefined,
): boolean => {
  const previousCoupon = output?.couponId || olds?.coupon;
  if (previousCoupon !== undefined && news.coupon !== previousCoupon) {
    return true;
  }
  if (news.code !== undefined && news.code !== (output?.code ?? olds?.code)) {
    return true;
  }
  if ((news.customer ?? undefined) !== (output?.customer ?? olds?.customer)) {
    return true;
  }
  if (
    (news.customerAccount ?? undefined) !==
    (output?.customerAccount ?? olds?.customerAccount)
  ) {
    return true;
  }
  if (
    (news.expiresAt ?? undefined) !== (output?.expiresAt ?? olds?.expiresAt)
  ) {
    return true;
  }
  if (
    (news.maxRedemptions ?? undefined) !==
    (output?.maxRedemptions ?? olds?.maxRedemptions)
  ) {
    return true;
  }
  const oldR = olds?.restrictions;
  const newR = news.restrictions;
  const outR = output?.restrictions;
  const desiredFirstTime =
    newR?.firstTimeTransaction ?? oldR?.firstTimeTransaction ?? false;
  const observedFirstTime =
    outR?.firstTimeTransaction ?? oldR?.firstTimeTransaction ?? false;
  if (desiredFirstTime !== observedFirstTime) {
    return true;
  }
  if (
    (newR?.minimumAmount ?? oldR?.minimumAmount) !==
    (outR?.minimumAmount ?? oldR?.minimumAmount)
  ) {
    return true;
  }
  if (
    (newR?.minimumAmountCurrency ?? oldR?.minimumAmountCurrency) !==
    (outR?.minimumAmountCurrency ?? oldR?.minimumAmountCurrency)
  ) {
    return true;
  }
  return false;
};

export const PromotionCodeProvider = () =>
  Provider.succeed(PromotionCode, {
    stables: ["id", "code", "couponId", "created", "livemode"],

    list: Effect.fn(function* () {
      const items = yield* listAllPromotionCodes();
      return items
        .filter(
          (item) =>
            tagRecord(item.metadata)[alchemyMetadataKeys.stack] !== undefined,
        )
        .map(toAttrs);
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (replaceOnCreateOnlyChange(olds, news, output)) {
        const previousCode = output?.code ?? olds?.code;
        const nextCode = news.code ?? previousCode;
        return {
          action: "replace" as const,
          deleteFirst: nextCode !== undefined && nextCode === previousCode,
        };
      }
      if ((news.active ?? true) !== (output?.active ?? olds?.active ?? true)) {
        return { action: "update" } as const;
      }
      if (!recordsEqual(news.metadata ?? {}, olds?.metadata ?? {})) {
        return { action: "update" } as const;
      }
      if (
        !deepEqual(
          news.restrictions?.currencyOptions,
          olds?.restrictions?.currencyOptions ??
            output?.restrictions.currencyOptions,
          { stripNullish: true },
        )
      ) {
        return { action: "update" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const code = yield* toCode(id, olds?.code, output?.code);
      const existing = yield* observe({ id: output?.id, code });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const code = yield* toCode(id, news.code, output?.code);
      const metadata = yield* desiredMetadata(id, news.metadata);
      const active = news.active ?? true;
      const createRestrictions = toCreateRestrictions(news.restrictions);

      let current = yield* observe({ id: output?.id, code });
      // A leftover inactive code with this customer-facing `code` may point
      // at a deleted coupon. Stripe forbids reactivating it — treat it as
      // missing and create a new promotion code instead.
      if (current !== undefined) {
        const observedCoupon = couponIdOf(current);
        if (observedCoupon !== "" && observedCoupon !== news.coupon) {
          current = undefined;
        }
      }

      if (current === undefined) {
        current = yield* CreatePromotionCode({
          promotion: { type: "coupon", coupon: news.coupon },
          expand: ["promotion.coupon"],
          code,
          active,
          ...(news.customer !== undefined ? { customer: news.customer } : {}),
          ...(news.customerAccount !== undefined
            ? { customer_account: news.customerAccount }
            : {}),
          ...(news.expiresAt !== undefined
            ? { expires_at: news.expiresAt }
            : {}),
          ...(news.maxRedemptions !== undefined
            ? { max_redemptions: news.maxRedemptions }
            : {}),
          metadata,
          ...(createRestrictions !== undefined
            ? { restrictions: createRestrictions }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-promotion-code-${instanceId}`,
          }),
          Effect.catchTag("InvalidRequestError", (error) =>
            observe({ id: output?.id, code }).pipe(
              Effect.flatMap((found) =>
                found !== undefined && couponIdOf(found) === news.coupon
                  ? Effect.succeed(found)
                  : Effect.fail(error),
              ),
            ),
          ),
        );
      }

      if (current === undefined) {
        return yield* new PromotionCodeNotResolved({ code });
      }

      if (current.active !== active) {
        current = yield* UpdatePromotionCode({
          promotion_code: current.id,
          active,
        });
      }

      const observedMeta = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMeta, metadata);
      if (upsert.length > 0 || removed.length > 0) {
        current = yield* UpdatePromotionCode({
          promotion_code: current.id,
          metadata: {
            ...Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value])),
            ...Object.fromEntries(removed.map((key) => [key, ""])),
          },
        });
      }

      const desiredCurrency = news.restrictions?.currencyOptions;
      const observedCurrency = fromWireCurrencyOptions(
        current.restrictions.currency_options,
      );
      if (
        desiredCurrency !== undefined &&
        !deepEqual(desiredCurrency, observedCurrency, { stripNullish: true })
      ) {
        current = yield* UpdatePromotionCode({
          promotion_code: current.id,
          restrictions: {
            currency_options: toWireCurrencyOptions(desiredCurrency),
          },
        });
      }

      const attrs = toAttrs(current);
      return {
        ...attrs,
        couponId: attrs.couponId || news.coupon,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* observe({ id: output.id, code: output.code });
      if (existing === undefined || !existing.active) return;
      yield* UpdatePromotionCode({
        promotion_code: existing.id,
        active: false,
      }).pipe(Effect.catchIf(isResourceMissing, () => Effect.void));
    }),
  });
