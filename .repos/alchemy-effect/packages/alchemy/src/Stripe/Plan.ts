import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeletePlan,
  GetPlans,
  GetPlan,
  CreatePlan,
  UpdatePlan,
  type Plan as StripePlan,
  type PlanProduct,
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
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** Billing frequency for a legacy Stripe Plan. */
export type PlanInterval = "day" | "month" | "week" | "year";
/** How quantity per period is determined. */
export type PlanUsageType = "licensed" | "metered";
/** How the price per period is computed. */
export type PlanBillingScheme = "per_unit" | "tiered";

export interface PlanProps {
  /**
   * Id of the Stripe Product this plan belongs to (`prod_…`). Mutable
   * until the plan has been used on a subscription.
   */
  product: string;
  /**
   * Three-letter ISO currency code, lowercase (e.g. `"usd"`). Create-only
   * — changing it replaces the plan.
   */
  currency: string;
  /**
   * Billing frequency. Create-only — changing it replaces the plan.
   */
  interval: PlanInterval;
  /**
   * Number of intervals between billings. Maximum of three years
   * (`3` years, `36` months, or `156` weeks). Create-only.
   * @default 1
   */
  intervalCount?: number;
  /**
   * Amount in the currency's minor units (e.g. cents). `0` is a free
   * plan. Required unless `amountDecimal` is set or the plan is tiered.
   * Create-only — changing it replaces the plan.
   */
  amount?: number;
  /**
   * Decimal amount in the currency's minor units, at most 12 decimal
   * places. Mutually exclusive with `amount`. Create-only.
   */
  amountDecimal?: string;
  /**
   * Brief description of the plan, hidden from customers.
   */
  nickname?: string;
  /**
   * Whether the plan can be used for new subscriptions.
   * @default true
   */
  active?: boolean;
  /**
   * Default trial length (days) when subscribing with
   * `trial_from_plan=true`. Mutable.
   */
  trialPeriodDays?: number;
  /**
   * How quantity per period is determined. `licensed` bills the
   * subscription quantity; `metered` aggregates usage records. Create-only.
   * @default "licensed"
   */
  usageType?: PlanUsageType;
  /**
   * How the price per period is computed. Create-only.
   * @default "per_unit"
   */
  billingScheme?: PlanBillingScheme;
  /**
   * Meter that tracks usage for a metered plan. Create-only.
   */
  meter?: string;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`.
   */
  metadata?: Record<string, string>;
}

export type Plan = Resource<
  "Stripe.Plan",
  PlanProps,
  {
    /** Stripe plan id. */
    id: string;
    /** Id of the product this plan belongs to. */
    product: string;
    /** Three-letter ISO currency code. */
    currency: string;
    /** Billing frequency. */
    interval: PlanInterval;
    /** Number of intervals between billings. */
    intervalCount: number;
    /** Amount in the currency's minor units, or `undefined` when unset. */
    amount: number | undefined;
    /** Decimal amount in the currency's minor units, or `undefined`. */
    amountDecimal: string | undefined;
    /** Whether the plan can be used for new subscriptions. */
    active: boolean;
    /** Brief description of the plan, hidden from customers. */
    nickname: string | undefined;
    /** Default trial length in days, if set. */
    trialPeriodDays: number | undefined;
    /** How quantity per period is determined. */
    usageType: PlanUsageType;
    /** How the price per period is computed. */
    billingScheme: PlanBillingScheme;
    /** Meter id for a metered plan, if set. */
    meter: string | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the plan was created. */
    created: number;
    /** Whether the plan exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Plan — the legacy (pre-Price) catalog object that defines
 * currency, amount, and billing interval for a Product. Prefer
 * {@link Price} for new catalogs; Plan exists for the Plans API.
 *
 * Currency, amount, interval, usage type, and billing scheme are
 * immutable (changing them replaces the plan). Nickname, metadata,
 * `active`, `trialPeriodDays`, and `product` update in place. Destroy
 * hard-deletes the plan; existing subscribers are not affected.
 *
 * @see https://docs.stripe.com/api/plans
 *
 * ### Creating a Plan
 * **Example:** Monthly plan
 * ```typescript
 * const product = yield* Stripe.Product("pro-plan", { name: "Pro Plan" });
 * const plan = yield* Stripe.Plan("pro-monthly", {
 *   product: product.id,
 *   currency: "usd",
 *   interval: "month",
 *   amount: 1500,
 *   nickname: "Pro monthly",
 * });
 * ```
 *
 * **Example:** Yearly plan
 * ```typescript
 * const plan = yield* Stripe.Plan("pro-yearly", {
 *   product: product.id,
 *   currency: "usd",
 *   interval: "year",
 *   amount: 15000,
 *   nickname: "Pro yearly",
 * });
 * ```
 *
 * ### Updating a Plan
 * **Example:** Nickname, metadata, and trial
 * ```typescript
 * const plan = yield* Stripe.Plan("pro-monthly", {
 *   product: product.id,
 *   currency: "usd",
 *   interval: "month",
 *   amount: 1500,
 *   nickname: "Pro monthly (paused)",
 *   trialPeriodDays: 14,
 *   metadata: { tier: "pro" },
 * });
 * ```
 *
 * @resource
 */
export const Plan = Resource<Plan>("Stripe.Plan");

export class PlanNotResolved extends Data.TaggedError(
  "Stripe.PlanNotResolved",
)<{
  product: string;
  currency: string;
}> {}

type PlanAttributes = Plan["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const productIdOf = (product: PlanProduct | null): string => {
  if (product == null) return "";
  if (typeof product === "string") return product;
  return product.id;
};

const toAttrs = (plan: StripePlan): PlanAttributes => ({
  id: plan.id,
  product: productIdOf(plan.product),
  currency: plan.currency,
  interval: plan.interval as PlanInterval,
  intervalCount: plan.interval_count,
  amount: plan.amount ?? undefined,
  amountDecimal: plan.amount_decimal ?? undefined,
  active: plan.active,
  nickname: plan.nickname ?? undefined,
  trialPeriodDays: plan.trial_period_days ?? undefined,
  usageType: plan.usage_type as PlanUsageType,
  billingScheme: plan.billing_scheme as PlanBillingScheme,
  meter: plan.meter ?? undefined,
  metadata: userMetadata(plan.metadata),
  created: plan.created,
  livemode: plan.livemode,
});

const isMissingPlan = isMissingStripeResource;

const getById = (plan: string) =>
  GetPlan({ plan }).pipe(
    Effect.catchIf(isMissingPlan, () => Effect.succeed(undefined)),
  );

const listByActive = Effect.fn(function* (active: boolean) {
  const plans: StripePlan[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetPlans({
      active,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    plans.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return plans;
});

const listAllPlans = Effect.fn(function* () {
  const [active, inactive] = yield* Effect.all(
    [listByActive(true), listByActive(false)],
    { concurrency: 2 },
  );
  const seen = new Set<string>();
  const plans: StripePlan[] = [];
  for (const plan of [...active, ...inactive]) {
    if (seen.has(plan.id)) continue;
    seen.add(plan.id);
    plans.push(plan);
  }
  return plans;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const plans = yield* listAllPlans();
  const matches: StripePlan[] = [];
  for (const plan of plans) {
    if (yield* hasAlchemyMetadata(id, tagRecord(plan.metadata))) {
      matches.push(plan);
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

const shouldReplace = (news: PlanProps, output: PlanAttributes | undefined) => {
  if (output === undefined) return false;
  if (news.currency !== output.currency) return true;
  if (news.interval !== output.interval) return true;
  if ((news.intervalCount ?? 1) !== output.intervalCount) return true;
  if (news.amount !== undefined && news.amount !== output.amount) {
    return true;
  }
  if (
    news.amountDecimal !== undefined &&
    news.amountDecimal !== output.amountDecimal
  ) {
    return true;
  }
  if ((news.usageType ?? "licensed") !== output.usageType) return true;
  if ((news.billingScheme ?? "per_unit") !== output.billingScheme) return true;
  if ((news.meter ?? undefined) !== output.meter) return true;
  return false;
};

export const PlanProvider = () =>
  Provider.succeed(Plan, {
    stables: [
      "id",
      "currency",
      "interval",
      "intervalCount",
      "amount",
      "billingScheme",
      "usageType",
      "created",
      "livemode",
    ],

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
      const plans = yield* listAllPlans();
      return plans
        .filter((plan) => {
          const metadata = tagRecord(plan.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredActive = news.active ?? true;
      const desiredNickname = news.nickname ?? "";
      const desiredTrialPeriodDays = news.trialPeriodDays;

      let current: StripePlan | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      // A previous generation (same logical id, different immutable
      // fields) must not be reused — Stripe plans cannot change amount,
      // currency, or billing interval.
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreatePlan({
          product: news.product,
          currency: news.currency,
          interval: news.interval,
          active: desiredActive,
          metadata,
          ...(news.intervalCount !== undefined
            ? { interval_count: news.intervalCount }
            : {}),
          ...(news.amount !== undefined ? { amount: news.amount } : {}),
          ...(news.amountDecimal !== undefined
            ? { amount_decimal: news.amountDecimal }
            : {}),
          ...(news.usageType !== undefined
            ? { usage_type: news.usageType }
            : {}),
          ...(news.billingScheme !== undefined
            ? { billing_scheme: news.billingScheme }
            : {}),
          ...(news.meter !== undefined ? { meter: news.meter } : {}),
          ...(desiredNickname.length > 0 ? { nickname: desiredNickname } : {}),
          ...(desiredTrialPeriodDays !== undefined
            ? { trial_period_days: desiredTrialPeriodDays }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-plan-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new PlanNotResolved({
          product: news.product,
          currency: news.currency,
        });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const activeChanged = current.active !== desiredActive;
      const nicknameChanged = (current.nickname ?? "") !== desiredNickname;
      const productChanged = productIdOf(current.product) !== news.product;
      const trialChanged =
        desiredTrialPeriodDays !== undefined &&
        (current.trial_period_days ?? undefined) !== desiredTrialPeriodDays;

      if (
        !activeChanged &&
        !nicknameChanged &&
        !productChanged &&
        !trialChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdatePlan({
        plan: current.id,
        ...(activeChanged ? { active: desiredActive } : {}),
        ...(nicknameChanged ? { nickname: desiredNickname } : {}),
        ...(productChanged ? { product: news.product } : {}),
        ...(trialChanged ? { trial_period_days: desiredTrialPeriodDays } : {}),
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
      yield* DeletePlan({ plan: output.id }).pipe(
        Effect.catchIf(isMissingPlan, () => Effect.void),
      );
    }),
  });
