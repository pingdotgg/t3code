import {
  withRequestOptions,
  type StripeOpError,
} from "@distilled.cloud/stripe";
import {
  GetBillingCreditGrants,
  GetBillingCreditGrant,
  CreateBillingCreditGrant,
  UpdateBillingCreditGrant,
  CreateBillingCreditGrantVoid,
  type BillingCreditGrant as StripeCreditGrant,
  type CreateBillingCreditGrantRequestAmount,
  type CreateBillingCreditGrantRequestApplicabilityConfig,
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

/** The type of this amount. Stripe currently only supports monetary credits. */
export type CreditGrantAmountType = "monetary";

/** The category of this credit grant. Tracking only — not shown to customers. */
export type CreditGrantCategory = "paid" | "promotional";

/**
 * The price type that credit grants can apply to. Stripe currently only
 * supports metered prices (prices with a Billing Meter).
 */
export type CreditGrantPriceType = "metered";

export interface CreditGrantMonetaryAmount {
  /**
   * Three-letter ISO currency code, lowercase (e.g. `"usd"`).
   */
  currency: string;
  /**
   * Positive integer amount in the currency's minor units.
   */
  value: number;
}

export interface CreditGrantAmount {
  /**
   * Amount type. Stripe currently only supports `"monetary"`.
   */
  type: CreditGrantAmountType;
  /**
   * Monetary amount. Required when `type` is `"monetary"`. Create-only —
   * changing it replaces the grant.
   */
  monetary?: CreditGrantMonetaryAmount;
}

export interface CreditGrantApplicablePrice {
  /**
   * Stripe Price id (`price_…`) this grant can apply to. Metered prices
   * only. Cannot be combined with `priceType`.
   */
  id: string;
}

export interface CreditGrantScope {
  /**
   * Price type this grant applies to. Cannot be combined with `prices`.
   * @default "metered"
   */
  priceType?: CreditGrantPriceType;
  /**
   * Specific metered prices this grant applies to (max 20). Cannot be
   * combined with `priceType`.
   */
  prices?: CreditGrantApplicablePrice[];
}

export interface CreditGrantApplicabilityConfig {
  /**
   * Scope of prices this credit grant can apply to.
   */
  scope: CreditGrantScope;
}

export interface CreditGrantProps {
  /**
   * Id of the customer receiving the billing credits (`cus_…`). Required
   * unless `customerAccount` is set. Create-only — changing it replaces
   * the grant.
   */
  customer?: string;
  /**
   * Id of the account representing the customer receiving the billing
   * credits. Required unless `customer` is set. Create-only.
   */
  customerAccount?: string;
  /**
   * Amount of this credit grant. Create-only — changing it replaces the
   * grant.
   */
  amount: CreditGrantAmount;
  /**
   * What this credit grant applies to. Stripe currently only supports
   * metered prices that have a Billing Meter. Create-only.
   * @default { scope: { priceType: "metered" } }
   */
  applicabilityConfig?: CreditGrantApplicabilityConfig;
  /**
   * Category of this credit grant. Tracking only — not shown to the
   * customer. Create-only.
   * @default "paid"
   */
  category?: CreditGrantCategory;
  /**
   * Descriptive name shown in the Stripe Dashboard. If omitted, a unique
   * name is generated from the stack, stage, and logical id. Create-only
   * (the update API does not accept `name`).
   */
  name?: string;
  /**
   * Unix timestamp when the credits become eligible for use. Defaults to
   * the current time. Create-only.
   */
  effectiveAt?: number;
  /**
   * Unix timestamp when the credits expire. If omitted, they never expire.
   * Mutable — pass a new timestamp to update.
   */
  expiresAt?: number;
  /**
   * Priority for applying this grant (0 highest, 100 lowest).
   * @default 50
   */
  priority?: number;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`. Mutable.
   */
  metadata?: Record<string, string>;
}

export type CreditGrant = Resource<
  "Stripe.CreditGrant",
  CreditGrantProps,
  {
    /** Stripe credit grant id (`credgr_…`). */
    id: string;
    /** Dashboard name, if set. */
    name: string | undefined;
    /** Customer id receiving the credits (`cus_…`). */
    customer: string | undefined;
    /** Customer-account id receiving the credits, if set. */
    customerAccount: string | undefined;
    /** Amount of this credit grant. */
    amount: CreditGrantAmount;
    /** What this credit grant applies to. */
    applicabilityConfig: CreditGrantApplicabilityConfig;
    /** Category of this credit grant. */
    category: CreditGrantCategory;
    /** Unix timestamp when the credits become eligible for use. */
    effectiveAt: number | undefined;
    /** Unix timestamp when the credits expire, if they expire. */
    expiresAt: number | undefined;
    /** Priority for applying this grant (0 highest, 100 lowest). */
    priority: number | undefined;
    /** Unix timestamp when this grant was voided, if voided. */
    voidedAt: number | undefined;
    /** Unix timestamp when the grant was created. */
    created: number;
    /** Unix timestamp when the grant was last updated. */
    updated: number;
    /** Whether the grant exists in live mode. */
    livemode: boolean;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Stripe Credit Grant — prepaid or promotional billing credits allocated
 * to a customer and applied against metered prices. Amount, customer,
 * applicability, category, effective time, and priority are immutable;
 * changing them replaces the grant. `expiresAt` and `metadata` update in
 * place. Credit grants cannot be hard-deleted: destroying this resource
 * voids the grant (`voided_at` is set). Already-voided grants are treated
 * as success.
 *
 * @see https://docs.stripe.com/api/billing/credit-grant
 *
 * ### Creating a Credit Grant
 * **Example:** Promotional credits for metered prices
 * ```typescript
 * const customer = yield* Stripe.Customer("alice", {
 *   email: "alice@example.com",
 * });
 * const grant = yield* Stripe.CreditGrant("welcome-credits", {
 *   customer: customer.id,
 *   amount: { type: "monetary", monetary: { currency: "usd", value: 1000 } },
 *   applicabilityConfig: { scope: { priceType: "metered" } },
 *   category: "promotional",
 *   name: "Welcome credits",
 * });
 * ```
 *
 * **Example:** Paid credits scoped to specific prices
 * ```typescript
 * const grant = yield* Stripe.CreditGrant("prepaid", {
 *   customer: customer.id,
 *   amount: { type: "monetary", monetary: { currency: "usd", value: 5000 } },
 *   applicabilityConfig: {
 *     scope: { prices: [{ id: price.id }] },
 *   },
 *   category: "paid",
 * });
 * ```
 *
 * ### Updating a Credit Grant
 * **Example:** Extend expiry and retag
 * ```typescript
 * const grant = yield* Stripe.CreditGrant("welcome-credits", {
 *   customer: customer.id,
 *   amount: { type: "monetary", monetary: { currency: "usd", value: 1000 } },
 *   expiresAt: 4102444800,
 *   metadata: { campaign: "spring" },
 * });
 * ```
 *
 * ### Voiding a Credit Grant
 * **Example:** Destroy voids rather than deleting
 * ```typescript
 * // stack.destroy() / resource removal calls void
 * const grant = yield* Stripe.CreditGrant("welcome-credits", {
 *   customer: customer.id,
 *   amount: { type: "monetary", monetary: { currency: "usd", value: 1000 } },
 * });
 * ```
 *
 * @resource
 */
export const CreditGrant = Resource<CreditGrant>("Stripe.CreditGrant");

export class CreditGrantNotResolved extends Data.TaggedError(
  "Stripe.CreditGrantNotResolved",
)<{
  customer: string | undefined;
}> {}

type CreditGrantAttributes = CreditGrant["Attributes"];

const DEFAULT_APPLICABILITY: CreditGrantApplicabilityConfig = {
  scope: { priceType: "metered" },
};

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const idOf = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return undefined;
};

const isVoided = (grant: StripeCreditGrant): boolean => grant.voided_at != null;

const fromWireAmount = (
  amount: StripeCreditGrant["amount"],
): CreditGrantAmount => ({
  type: amount.type,
  ...(amount.monetary != null
    ? {
        monetary: {
          currency: amount.monetary.currency,
          value: amount.monetary.value,
        },
      }
    : {}),
});

const toWireAmount = (
  amount: CreditGrantAmount,
): CreateBillingCreditGrantRequestAmount => ({
  type: amount.type,
  ...(amount.monetary !== undefined
    ? {
        monetary: {
          currency: amount.monetary.currency,
          value: amount.monetary.value,
        },
      }
    : {}),
});

const fromWireApplicability = (
  config: StripeCreditGrant["applicability_config"],
): CreditGrantApplicabilityConfig => {
  const prices = config.scope.prices
    ?.map((price) => (price.id != null ? { id: price.id } : undefined))
    .filter(
      (price): price is CreditGrantApplicablePrice => price !== undefined,
    );
  return {
    scope: {
      ...(config.scope.price_type !== undefined
        ? { priceType: config.scope.price_type }
        : {}),
      ...(prices !== undefined && prices.length > 0 ? { prices } : {}),
    },
  };
};

const toWireApplicability = (
  config: CreditGrantApplicabilityConfig,
): CreateBillingCreditGrantRequestApplicabilityConfig => ({
  scope: {
    ...(config.scope.priceType !== undefined
      ? { price_type: config.scope.priceType }
      : {}),
    ...(config.scope.prices !== undefined
      ? { prices: config.scope.prices.map((price) => ({ id: price.id })) }
      : {}),
  },
});

const toAttrs = (grant: StripeCreditGrant): CreditGrantAttributes => ({
  id: grant.id,
  name: grant.name ?? undefined,
  customer: idOf(grant.customer),
  customerAccount: grant.customer_account ?? undefined,
  amount: fromWireAmount(grant.amount),
  applicabilityConfig: fromWireApplicability(grant.applicability_config),
  category: grant.category,
  effectiveAt: grant.effective_at ?? undefined,
  expiresAt: grant.expires_at ?? undefined,
  priority: grant.priority ?? undefined,
  voidedAt: grant.voided_at ?? undefined,
  created: grant.created,
  updated: grant.updated,
  livemode: grant.livemode,
  metadata: userMetadata(grant.metadata),
});

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: NAME_MAX_LENGTH }))
    );
  });

const isMissingGrant = isMissingStripeResource;

const alreadyVoided = (error: StripeOpError): boolean =>
  error._tag === "InvalidRequestError" &&
  (error.message?.toLowerCase().includes("void") ?? false);

const getById = (id: string) =>
  GetBillingCreditGrant({ id }).pipe(
    Effect.catchIf(isMissingGrant, () => Effect.succeed(undefined)),
  );

const listAllCreditGrants = Effect.fn(function* () {
  const grants: StripeCreditGrant[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetBillingCreditGrants({
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    grants.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return grants;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const grants = yield* listAllCreditGrants();
  const matches: StripeCreditGrant[] = [];
  for (const grant of grants) {
    if (isVoided(grant)) continue;
    if (yield* hasAlchemyMetadata(id, tagRecord(grant.metadata))) {
      matches.push(grant);
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
    if (byId !== undefined && !isVoided(byId)) return byId;
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
  olds: CreditGrantProps | undefined,
  news: CreditGrantProps,
  output: CreditGrantAttributes | undefined,
): boolean => {
  if (output === undefined && olds === undefined) return false;
  if (
    !deepEqual(news.amount, output?.amount ?? olds?.amount, {
      stripNullish: true,
    })
  ) {
    return true;
  }
  const desiredApplicability =
    news.applicabilityConfig ?? DEFAULT_APPLICABILITY;
  const previousApplicability =
    output?.applicabilityConfig ?? olds?.applicabilityConfig;
  if (
    previousApplicability !== undefined &&
    !deepEqual(desiredApplicability, previousApplicability, {
      stripNullish: true,
    })
  ) {
    return true;
  }
  const previousCategory = output?.category ?? olds?.category ?? "paid";
  if ((news.category ?? previousCategory) !== previousCategory) {
    return true;
  }
  const previousCustomer = output?.customer ?? olds?.customer;
  if (
    news.customer !== undefined &&
    previousCustomer !== undefined &&
    news.customer !== previousCustomer
  ) {
    return true;
  }
  const previousAccount = output?.customerAccount ?? olds?.customerAccount;
  if (
    news.customerAccount !== undefined &&
    previousAccount !== undefined &&
    news.customerAccount !== previousAccount
  ) {
    return true;
  }
  if (
    news.effectiveAt !== undefined &&
    news.effectiveAt !== (output?.effectiveAt ?? olds?.effectiveAt)
  ) {
    return true;
  }
  if (
    news.priority !== undefined &&
    news.priority !== (output?.priority ?? olds?.priority)
  ) {
    return true;
  }
  return false;
};

export const CreditGrantProvider = () =>
  Provider.succeed(CreditGrant, {
    stables: [
      "id",
      "customer",
      "customerAccount",
      "amount",
      "applicabilityConfig",
      "category",
      "effectiveAt",
      "priority",
      "created",
      "livemode",
    ],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (replaceOnCreateOnlyChange(olds, news, output)) {
        return { action: "replace" as const };
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
      const grants = yield* listAllCreditGrants();
      return grants
        .filter((grant) => {
          if (isVoided(grant)) return false;
          const metadata = tagRecord(grant.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const name = yield* toName(id, news.name, output?.name);
      const applicabilityConfig =
        news.applicabilityConfig ?? DEFAULT_APPLICABILITY;

      let current: StripeCreditGrant | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      if (
        current !== undefined &&
        replaceOnCreateOnlyChange(undefined, news, toAttrs(current))
      ) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateBillingCreditGrant({
          amount: toWireAmount(news.amount),
          applicability_config: toWireApplicability(applicabilityConfig),
          name,
          metadata,
          ...(news.customer !== undefined ? { customer: news.customer } : {}),
          ...(news.customerAccount !== undefined
            ? { customer_account: news.customerAccount }
            : {}),
          ...(news.category !== undefined ? { category: news.category } : {}),
          ...(news.effectiveAt !== undefined
            ? { effective_at: news.effectiveAt }
            : {}),
          ...(news.expiresAt !== undefined
            ? { expires_at: news.expiresAt }
            : {}),
          ...(news.priority !== undefined ? { priority: news.priority } : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-credit-grant-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new CreditGrantNotResolved({ customer: news.customer });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const expiresAtChanged =
        news.expiresAt !== undefined &&
        (current.expires_at ?? undefined) !== news.expiresAt;

      if (!metadataChanged && !expiresAtChanged) {
        return toAttrs(current);
      }

      const updated = yield* UpdateBillingCreditGrant({
        id: current.id,
        ...(expiresAtChanged ? { expires_at: news.expiresAt } : {}),
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
      if (existing === undefined || isVoided(existing)) return;
      yield* CreateBillingCreditGrantVoid({ id: existing.id }).pipe(
        Effect.catchIf(isMissingGrant, () => Effect.void),
        Effect.catchIf(alreadyVoided, () => Effect.void),
      );
    }),
  });
