import { withRequestOptions } from "@distilled.cloud/stripe";
import type { StripeOpError } from "@distilled.cloud/stripe";
import {
  GetIssuingCards,
  GetIssuingCard,
  CreateIssuingCard,
  UpdateIssuingCard,
  type IssuingCard as StripeIssuingCard,
  type CreateIssuingCardRequestSpendingControls,
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

/** Whether authorizations can be approved on this card. */
export type IssuingCardStatus = "active" | "canceled" | "inactive";

/** The type of Issuing card. Create-only — changing it replaces the card. */
export type IssuingCardType = "physical" | "virtual";

/** Why a previous card is being replaced. Create-only. */
export type IssuingCardReplacementReason =
  | "damaged"
  | "expired"
  | "lost"
  | "stolen";

/** Card-present vs card-not-present authorization presence. */
export type IssuingCardPresence = "not_present" | "present";

/** Interval (or event) a spending limit applies to. */
export type IssuingCardSpendingLimitInterval =
  | "all_time"
  | "daily"
  | "monthly"
  | "per_authorization"
  | "weekly"
  | "yearly";

export interface IssuingCardSpendingLimit {
  /**
   * Maximum amount allowed to spend per interval, in the card's currency
   * minor units.
   */
  amount: number;
  /**
   * Interval (or event) to which the amount applies.
   */
  interval: IssuingCardSpendingLimitInterval;
  /**
   * Merchant categories this limit applies to. Omit to apply to all
   * categories.
   */
  categories?: string[];
}

export interface IssuingCardSpendingControls {
  /**
   * Card-presence statuses from which authorizations are allowed. Cannot
   * be set with `blockedCardPresences`.
   */
  allowedCardPresences?: IssuingCardPresence[];
  /**
   * Merchant categories to allow. All other categories are blocked.
   * Cannot be set with `blockedCategories`.
   */
  allowedCategories?: string[];
  /**
   * ISO 3166 alpha-2 countries from which authorizations are allowed.
   * Cannot be set with `blockedMerchantCountries`.
   */
  allowedMerchantCountries?: string[];
  /**
   * Card-presence statuses from which authorizations are declined. Cannot
   * be set with `allowedCardPresences`.
   */
  blockedCardPresences?: IssuingCardPresence[];
  /**
   * Merchant categories to decline. All other categories are allowed.
   * Cannot be set with `allowedCategories`.
   */
  blockedCategories?: string[];
  /**
   * ISO 3166 alpha-2 countries from which authorizations are declined.
   * Cannot be set with `allowedMerchantCountries`.
   */
  blockedMerchantCountries?: string[];
  /**
   * Amount-based spending limits that apply across this card and any
   * cards it replaced.
   */
  spendingLimits?: IssuingCardSpendingLimit[];
}

export interface IssuingCardProps {
  /**
   * Id of the Issuing Cardholder this card is issued to (`ich_…`).
   * Create-only — changing it replaces the card.
   */
  cardholder: string;
  /**
   * Three-letter ISO currency code, lowercase. Supported currencies are
   * `usd` (US), `eur` (EU), and `gbp` (UK). Create-only — changing it
   * replaces the card.
   */
  currency: string;
  /**
   * The type of card to issue.
   * @default "virtual"
   */
  type?: IssuingCardType;
  /**
   * Whether authorizations can be approved on this card. Stripe defaults
   * new cards to `inactive`. Destroying this resource cancels the card
   * (`canceled`); canceled cards cannot be reactivated.
   * @default "inactive"
   */
  status?: "active" | "inactive";
  /**
   * Second line printed on the card (max 24 characters). Create-only —
   * changing it replaces the card.
   */
  secondLine?: string;
  /**
   * Desired expiration month (1–12) when specifying a custom expiration
   * date. Create-only.
   */
  expMonth?: number;
  /**
   * Desired 4-digit expiration year when specifying a custom expiration
   * date. Create-only.
   */
  expYear?: number;
  /**
   * Financial account id this card is attached to. Create-only —
   * changing it replaces the card.
   */
  financialAccount?: string;
  /**
   * Personalization design id belonging to this card. Mutable.
   */
  personalizationDesign?: string;
  /**
   * Card this one replaces, if any. Create-only.
   */
  replacementFor?: string;
  /**
   * Why `replacementFor` is being replaced. Create-only.
   */
  replacementReason?: IssuingCardReplacementReason;
  /**
   * Rules that control spending for this card. Mutable.
   */
  spendingControls?: IssuingCardSpendingControls;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`. Mutable.
   */
  metadata?: Record<string, string>;
}

export type IssuingCard = Resource<
  "Stripe.IssuingCard",
  IssuingCardProps,
  {
    /** Stripe Issuing card id (`ic_…`). */
    id: string;
    /** Id of the cardholder this card belongs to (`ich_…`). */
    cardholder: string;
    /** Three-letter ISO currency code. */
    currency: string;
    /** `virtual` or `physical`. */
    type: IssuingCardType;
    /** Whether authorizations can be approved on this card. */
    status: IssuingCardStatus;
    /** Card brand (e.g. `Visa`). */
    brand: string;
    /** Last 4 digits of the card number. */
    last4: string;
    /** Expiration month. */
    expMonth: number;
    /** Expiration year. */
    expYear: number;
    /** Second line printed on the card, if set. */
    secondLine: string | undefined;
    /** Financial account id, if attached. */
    financialAccount: string | undefined;
    /** Personalization design id, if set. */
    personalizationDesign: string | undefined;
    /** Card this one replaces, if any. */
    replacementFor: string | undefined;
    /** Why the previous card was replaced, if this is a replacement. */
    replacementReason: IssuingCardReplacementReason | undefined;
    /** Why the card was canceled, if canceled. */
    cancellationReason: string | undefined;
    /** Spending controls currently applied to this card. */
    spendingControls: IssuingCardSpendingControls | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the card was created. */
    created: number;
    /** Whether the card exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Issuing Card — a virtual or physical card issued to a
 * Cardholder. `cardholder`, `currency`, `type`, `secondLine`, and
 * custom expiration are immutable (changing them replaces the card).
 * Status, spending controls, personalization design, and metadata
 * update in place.
 *
 * Cards cannot be hard-deleted; destroying this resource cancels the
 * card (`status: canceled`). Canceled cards cannot be reactivated — a
 * later create with the same logical id provisions a new card.
 *
 * Issuing must be enabled on the Stripe account.
 *
 * @see https://docs.stripe.com/api/issuing/cards
 *
 * ### Creating a Card
 * **Example:** Virtual card
 * ```typescript
 * const card = yield* Stripe.IssuingCard("expense-card", {
 *   cardholder: cardholder.id,
 *   currency: "usd",
 *   type: "virtual",
 *   status: "inactive",
 * });
 * ```
 *
 * **Example:** Spending limits and metadata
 * ```typescript
 * const card = yield* Stripe.IssuingCard("expense-card", {
 *   cardholder: cardholder.id,
 *   currency: "usd",
 *   type: "virtual",
 *   status: "active",
 *   spendingControls: {
 *     spendingLimits: [{ amount: 50_000, interval: "monthly" }],
 *   },
 *   metadata: { team: "ops" },
 * });
 * ```
 *
 * ### Updating a Card
 * **Example:** Freeze and retag
 * ```typescript
 * const card = yield* Stripe.IssuingCard("expense-card", {
 *   cardholder: cardholder.id,
 *   currency: "usd",
 *   type: "virtual",
 *   status: "inactive",
 *   metadata: { team: "ops", frozen: "true" },
 * });
 * ```
 *
 * ### Replacing a Card
 * **Example:** Changing type replaces the card
 * ```typescript
 * const card = yield* Stripe.IssuingCard("expense-card", {
 *   cardholder: cardholder.id,
 *   currency: "usd",
 *   type: "physical",
 * });
 * ```
 *
 * @resource
 */
export const IssuingCard = Resource<IssuingCard>("Stripe.IssuingCard");

export class IssuingCardNotResolved extends Data.TaggedError(
  "Stripe.IssuingCardNotResolved",
)<{
  cardholder: string;
  currency: string;
}> {}

type IssuingCardAttributes = IssuingCard["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const expandedId = (
  value: string | { readonly id: string } | null | undefined,
): string | undefined => {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  return value.id;
};

const toSpendingControls = (
  controls: StripeIssuingCard["spending_controls"] | null | undefined,
): IssuingCardSpendingControls | undefined => {
  if (controls == null) return undefined;
  const spendingLimits = (controls.spending_limits ?? []).map((limit) => ({
    amount: limit.amount,
    interval: limit.interval as IssuingCardSpendingLimitInterval,
    ...(limit.categories != null && limit.categories.length > 0
      ? { categories: [...limit.categories] }
      : {}),
  }));
  const result: IssuingCardSpendingControls = {
    ...(controls.allowed_card_presences != null
      ? {
          allowedCardPresences: [
            ...controls.allowed_card_presences,
          ] as IssuingCardPresence[],
        }
      : {}),
    ...(controls.allowed_categories != null
      ? { allowedCategories: [...controls.allowed_categories] }
      : {}),
    ...(controls.allowed_merchant_countries != null
      ? { allowedMerchantCountries: [...controls.allowed_merchant_countries] }
      : {}),
    ...(controls.blocked_card_presences != null
      ? {
          blockedCardPresences: [
            ...controls.blocked_card_presences,
          ] as IssuingCardPresence[],
        }
      : {}),
    ...(controls.blocked_categories != null
      ? { blockedCategories: [...controls.blocked_categories] }
      : {}),
    ...(controls.blocked_merchant_countries != null
      ? { blockedMerchantCountries: [...controls.blocked_merchant_countries] }
      : {}),
    ...(spendingLimits.length > 0 ? { spendingLimits } : {}),
  };
  if (
    result.allowedCardPresences === undefined &&
    result.allowedCategories === undefined &&
    result.allowedMerchantCountries === undefined &&
    result.blockedCardPresences === undefined &&
    result.blockedCategories === undefined &&
    result.blockedMerchantCountries === undefined &&
    result.spendingLimits === undefined
  ) {
    return undefined;
  }
  return result;
};

const toWireSpendingControls = (
  controls: IssuingCardSpendingControls,
): CreateIssuingCardRequestSpendingControls => ({
  ...(controls.allowedCardPresences !== undefined
    ? { allowed_card_presences: controls.allowedCardPresences }
    : {}),
  ...(controls.allowedCategories !== undefined
    ? { allowed_categories: controls.allowedCategories }
    : {}),
  ...(controls.allowedMerchantCountries !== undefined
    ? { allowed_merchant_countries: controls.allowedMerchantCountries }
    : {}),
  ...(controls.blockedCardPresences !== undefined
    ? { blocked_card_presences: controls.blockedCardPresences }
    : {}),
  ...(controls.blockedCategories !== undefined
    ? { blocked_categories: controls.blockedCategories }
    : {}),
  ...(controls.blockedMerchantCountries !== undefined
    ? { blocked_merchant_countries: controls.blockedMerchantCountries }
    : {}),
  ...(controls.spendingLimits !== undefined
    ? {
        spending_limits: controls.spendingLimits.map((limit) => ({
          amount: limit.amount,
          interval: limit.interval,
          ...(limit.categories !== undefined
            ? { categories: limit.categories }
            : {}),
        })),
      }
    : {}),
});

const toAttrs = (card: StripeIssuingCard): IssuingCardAttributes => ({
  id: card.id,
  cardholder: card.cardholder.id,
  currency: card.currency,
  type: card.type,
  status: card.status,
  brand: card.brand,
  last4: card.last4,
  expMonth: card.exp_month,
  expYear: card.exp_year,
  secondLine: card.second_line ?? undefined,
  financialAccount: card.financial_account ?? undefined,
  personalizationDesign: expandedId(card.personalization_design),
  replacementFor: expandedId(card.replacement_for),
  replacementReason:
    (card.replacement_reason as IssuingCardReplacementReason | null) ??
    undefined,
  cancellationReason: card.cancellation_reason ?? undefined,
  spendingControls: toSpendingControls(card.spending_controls),
  metadata: userMetadata(card.metadata),
  created: card.created,
  livemode: card.livemode,
});

const isMissingCard = isMissingStripeResource;

const isIssuingUnavailable = (error: StripeOpError): boolean =>
  error._tag === "InvalidRequestError" || error._tag === "Forbidden";

const getById = (card: string) =>
  GetIssuingCard({ card }).pipe(
    Effect.map((live) => (live.status === "canceled" ? undefined : live)),
    Effect.catchIf(isMissingCard, () => Effect.succeed(undefined)),
  );

const getByIdAny = (card: string) =>
  GetIssuingCard({ card }).pipe(
    Effect.catchIf(isMissingCard, () => Effect.succeed(undefined)),
  );

const listByStatus = Effect.fn(function* (status: "active" | "inactive") {
  const cards: StripeIssuingCard[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetIssuingCards({
      status,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    cards.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return cards;
});

const listLiveCards = Effect.fn(function* () {
  const listed = yield* Effect.all(
    [listByStatus("active"), listByStatus("inactive")],
    { concurrency: 2 },
  ).pipe(
    Effect.catchIf(isIssuingUnavailable, () =>
      Effect.succeed([[], []] as [StripeIssuingCard[], StripeIssuingCard[]]),
    ),
  );
  const seen = new Set<string>();
  const cards: StripeIssuingCard[] = [];
  for (const card of [...listed[0], ...listed[1]]) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    cards.push(card);
  }
  return cards;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const cards = yield* listLiveCards();
  const matches: StripeIssuingCard[] = [];
  for (const card of cards) {
    if (yield* hasAlchemyMetadata(id, tagRecord(card.metadata))) {
      matches.push(card);
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
  news: IssuingCardProps,
  output: IssuingCardAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.cardholder !== output.cardholder) return true;
  if (news.currency !== output.currency) return true;
  if ((news.type ?? "virtual") !== output.type) return true;
  if (
    news.secondLine !== undefined &&
    news.secondLine !== (output.secondLine ?? undefined)
  ) {
    return true;
  }
  if (news.expMonth !== undefined && news.expMonth !== output.expMonth) {
    return true;
  }
  if (news.expYear !== undefined && news.expYear !== output.expYear) {
    return true;
  }
  if (
    news.financialAccount !== undefined &&
    news.financialAccount !== (output.financialAccount ?? undefined)
  ) {
    return true;
  }
  if (
    news.replacementFor !== undefined &&
    news.replacementFor !== (output.replacementFor ?? undefined)
  ) {
    return true;
  }
  return false;
};

export const IssuingCardProvider = () =>
  Provider.succeed(IssuingCard, {
    stables: [
      "id",
      "cardholder",
      "currency",
      "type",
      "brand",
      "last4",
      "expMonth",
      "expYear",
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
      // Canceled cards stay in Stripe but must not re-enter nuke. Filter
      // to alchemy_stack so account-wide teardown only touches our rows.
      const cards = yield* listLiveCards();
      return cards
        .filter((card) => {
          const metadata = tagRecord(card.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredType = news.type ?? "virtual";
      const desiredStatus = news.status ?? "inactive";
      const spendingControls =
        news.spendingControls !== undefined
          ? toWireSpendingControls(news.spendingControls)
          : undefined;

      let current: StripeIssuingCard | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      // A previous generation (same logical id, different immutable
      // fields) must not be reused — Stripe cards cannot change
      // cardholder, currency, type, or printed second line.
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateIssuingCard({
          cardholder: news.cardholder,
          currency: news.currency,
          type: desiredType,
          status: desiredStatus,
          metadata,
          ...(news.secondLine !== undefined
            ? { second_line: news.secondLine }
            : {}),
          ...(news.expMonth !== undefined ? { exp_month: news.expMonth } : {}),
          ...(news.expYear !== undefined ? { exp_year: news.expYear } : {}),
          ...(news.financialAccount !== undefined
            ? { financial_account: news.financialAccount }
            : {}),
          ...(news.personalizationDesign !== undefined
            ? { personalization_design: news.personalizationDesign }
            : {}),
          ...(news.replacementFor !== undefined
            ? { replacement_for: news.replacementFor }
            : {}),
          ...(news.replacementReason !== undefined
            ? { replacement_reason: news.replacementReason }
            : {}),
          ...(spendingControls !== undefined
            ? { spending_controls: spendingControls }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-issuing-card-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new IssuingCardNotResolved({
          cardholder: news.cardholder,
          currency: news.currency,
        });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const statusChanged = current.status !== desiredStatus;
      const personalizationChanged =
        news.personalizationDesign !== undefined &&
        expandedId(current.personalization_design) !==
          news.personalizationDesign;
      const spendingChanged =
        news.spendingControls !== undefined &&
        !deepEqual(
          news.spendingControls,
          toSpendingControls(current.spending_controls),
          { stripNullish: true },
        );

      if (
        !statusChanged &&
        !personalizationChanged &&
        !spendingChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdateIssuingCard({
        card: current.id,
        ...(statusChanged ? { status: desiredStatus } : {}),
        ...(personalizationChanged
          ? { personalization_design: news.personalizationDesign }
          : {}),
        ...(spendingChanged ? { spending_controls: spendingControls } : {}),
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
      const existing = yield* getByIdAny(output.id);
      if (existing === undefined || existing.status === "canceled") return;
      yield* UpdateIssuingCard({
        card: existing.id,
        status: "canceled",
      }).pipe(Effect.catchIf(isMissingCard, () => Effect.void));
    }),
  });
