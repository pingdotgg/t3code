import {
  withRequestOptions,
  type StripeOpError,
} from "@distilled.cloud/stripe";
import {
  GetIssuingCardholders,
  GetIssuingCardholder,
  CreateIssuingCardholder,
  UpdateIssuingCardholder,
  type IssuingCardholder as StripeIssuingCardholder,
  type CreateIssuingCardholderRequestBilling,
  type CreateIssuingCardholderRequestCompany,
  type CreateIssuingCardholderRequestIndividual,
  type CreateIssuingCardholderRequestSpendingControls,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { arrayEquals } from "../Util/equal.ts";
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

/** Specifies whether to permit authorizations on this cardholder's cards. */
export type IssuingCardholderStatus = "active" | "blocked" | "inactive";

/** One of `individual` or `company`. */
export type IssuingCardholderType = "company" | "individual";

/** Preferred locale for 3D Secure and one-time password messages. */
export type IssuingCardholderPreferredLocale = "de" | "en" | "es" | "fr" | "it";

/** Interval (or event) a spending limit applies to. */
export type IssuingCardholderSpendingLimitInterval =
  | "all_time"
  | "daily"
  | "monthly"
  | "per_authorization"
  | "weekly"
  | "yearly";

/** Card-present vs card-not-present authorization presence. */
export type IssuingCardholderCardPresence = "not_present" | "present";

export interface IssuingCardholderBillingAddress {
  /**
   * City, district, suburb, town, or village.
   */
  city: string;
  /**
   * Two-letter ISO 3166-1 alpha-2 country code.
   */
  country: string;
  /**
   * Address line 1 (street, PO Box, or company name).
   */
  line1: string;
  /**
   * Address line 2 (apartment, suite, unit, or building).
   */
  line2?: string;
  /**
   * ZIP or postal code.
   */
  postalCode: string;
  /**
   * State, county, province, or region (ISO 3166-2).
   */
  state?: string;
}

export interface IssuingCardholderBilling {
  /**
   * The cardholder's billing address. Required on create.
   */
  address: IssuingCardholderBillingAddress;
}

export interface IssuingCardholderCompany {
  /**
   * The entity's business ID number (tax id). Stripe does not return the
   * value; only whether it was provided.
   */
  taxId?: string;
}

export interface IssuingCardholderDob {
  /**
   * Day of birth, 1–31. Cardholders must be older than 13.
   */
  day: number;
  /**
   * Month of birth, 1–12.
   */
  month: number;
  /**
   * Four-digit year of birth.
   */
  year: number;
}

export interface IssuingCardholderIndividual {
  /**
   * First name. Required before activating cards. Letters, spaces,
   * periods, commas, hyphens, and apostrophes only.
   */
  firstName?: string;
  /**
   * Last name. Required before activating cards. Letters, spaces,
   * periods, commas, hyphens, and apostrophes only.
   */
  lastName?: string;
  /**
   * Date of birth. Cardholders must be older than 13.
   */
  dob?: IssuingCardholderDob;
}

export interface IssuingCardholderSpendingLimit {
  /**
   * Maximum amount allowed to spend per interval, in the smallest
   * currency unit.
   */
  amount: number;
  /**
   * Merchant categories this limit applies to. Omit to apply to all.
   */
  categories?: string[];
  /**
   * Interval (or event) to which the amount applies.
   */
  interval: IssuingCardholderSpendingLimitInterval;
}

export interface IssuingCardholderSpendingControls {
  /**
   * Card-presence statuses to allow. Cannot be set with
   * `blockedCardPresences`. Empty unsets.
   */
  allowedCardPresences?: IssuingCardholderCardPresence[];
  /**
   * Merchant categories to allow. Cannot be set with `blockedCategories`.
   */
  allowedCategories?: string[];
  /**
   * ISO 3166 alpha-2 countries to allow. Cannot be set with
   * `blockedMerchantCountries`. Empty unsets.
   */
  allowedMerchantCountries?: string[];
  /**
   * Card-presence statuses to decline. Cannot be set with
   * `allowedCardPresences`. Empty unsets.
   */
  blockedCardPresences?: IssuingCardholderCardPresence[];
  /**
   * Merchant categories to decline. Cannot be set with
   * `allowedCategories`.
   */
  blockedCategories?: string[];
  /**
   * ISO 3166 alpha-2 countries to decline. Cannot be set with
   * `allowedMerchantCountries`. Empty unsets.
   */
  blockedMerchantCountries?: string[];
  /**
   * Amount-based spending limits across this cardholder's cards.
   */
  spendingLimits?: IssuingCardholderSpendingLimit[];
  /**
   * Currency of amounts within `spendingLimits`. Defaults to the
   * merchant country's currency.
   */
  spendingLimitsCurrency?: string;
}

export interface IssuingCardholderProps {
  /**
   * The cardholder's name, printed on cards issued to them. Max 24
   * characters; letters and spaces only (no numbers or special
   * characters). Create-only — changing it replaces the cardholder.
   */
  name: string;
  /**
   * The cardholder's billing address. Mutable.
   */
  billing: IssuingCardholderBilling;
  /**
   * `individual` or `company`. Create-only — changing it replaces the
   * cardholder.
   * @default "individual"
   */
  type?: IssuingCardholderType;
  /**
   * The cardholder's email address.
   */
  email?: string;
  /**
   * The cardholder's phone number (E.164). Required for EU cardholders
   * who will create cards (3D Secure).
   */
  phoneNumber?: string;
  /**
   * Preferred locales for 3D Secure and OTP messages, ordered by
   * preference.
   */
  preferredLocales?: IssuingCardholderPreferredLocale[];
  /**
   * Whether to permit authorizations on this cardholder's cards.
   * `blocked` is Stripe-imposed and cannot be set. Destroy sets
   * `inactive`.
   * @default "active"
   */
  status?: "active" | "inactive";
  /**
   * Additional information about a `company` cardholder.
   */
  company?: IssuingCardholderCompany;
  /**
   * Additional information about an `individual` cardholder.
   */
  individual?: IssuingCardholderIndividual;
  /**
   * Spending controls applied across this cardholder's cards.
   */
  spendingControls?: IssuingCardholderSpendingControls;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`. Mutable.
   */
  metadata?: Record<string, string>;
}

export interface IssuingCardholderRequirements {
  /**
   * If set, cards decline authorizations with
   * `cardholder_verification_required`.
   */
  disabledReason: string | undefined;
  /**
   * Fields that need to be collected to verify and re-enable the
   * cardholder.
   */
  pastDue: string[] | undefined;
}

export type IssuingCardholder = Resource<
  "Stripe.IssuingCardholder",
  IssuingCardholderProps,
  {
    /** Stripe issuing cardholder id (`ich_…`). */
    id: string;
    /** The cardholder's name, printed on cards. */
    name: string;
    /** `individual` or `company`. */
    type: IssuingCardholderType;
    /** The cardholder's billing address. */
    billing: IssuingCardholderBilling;
    /** The cardholder's email address, if set. */
    email: string | undefined;
    /** The cardholder's phone number, if set. */
    phoneNumber: string | undefined;
    /** Preferred locales, if set. */
    preferredLocales: IssuingCardholderPreferredLocale[] | undefined;
    /** Whether authorizations are permitted. */
    status: IssuingCardholderStatus;
    /** Whether a company tax id was provided. */
    taxIdProvided: boolean | undefined;
    /** Individual first name, if set. */
    firstName: string | undefined;
    /** Individual last name, if set. */
    lastName: string | undefined;
    /** Individual date of birth, if set. */
    dob: IssuingCardholderDob | undefined;
    /** Spending controls, if set. */
    spendingControls: IssuingCardholderSpendingControls | undefined;
    /** Verification requirements Stripe reports on this cardholder. */
    requirements: IssuingCardholderRequirements;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the cardholder was created. */
    created: number;
    /** Whether the cardholder exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Issuing Cardholder — an individual or company who can be
 * issued cards. Billing address, email, phone, preferred locales,
 * spending controls, status, and metadata update in place. Name and
 * type are immutable; changing them replaces the cardholder.
 *
 * Stripe does not hard-delete cardholders; destroying this resource
 * sets `status` to `inactive`. Inactive cardholders can be reactivated
 * by a later reconcile.
 *
 * Requires the Stripe Issuing entitlement.
 *
 * @see https://docs.stripe.com/api/issuing/cardholders
 *
 * ### Creating a Cardholder
 * **Example:** Individual with billing address
 * ```typescript
 * const alice = yield* Stripe.IssuingCardholder("alice", {
 *   name: "Alice Example",
 *   type: "individual",
 *   email: "alice@example.com",
 *   billing: {
 *     address: {
 *       line1: "123 Main Street",
 *       city: "San Francisco",
 *       state: "CA",
 *       postalCode: "94111",
 *       country: "US",
 *     },
 *   },
 *   individual: { firstName: "Alice", lastName: "Example" },
 * });
 * ```
 *
 * **Example:** Company cardholder
 * ```typescript
 * const acme = yield* Stripe.IssuingCardholder("acme", {
 *   name: "Acme Corp",
 *   type: "company",
 *   billing: {
 *     address: {
 *       line1: "1 Market Street",
 *       city: "San Francisco",
 *       state: "CA",
 *       postalCode: "94105",
 *       country: "US",
 *     },
 *   },
 *   company: { taxId: "12-3456789" },
 * });
 * ```
 *
 * ### Spending controls
 * **Example:** Monthly spending limit
 * ```typescript
 * const alice = yield* Stripe.IssuingCardholder("alice", {
 *   name: "Alice Example",
 *   billing: {
 *     address: {
 *       line1: "123 Main Street",
 *       city: "San Francisco",
 *       state: "CA",
 *       postalCode: "94111",
 *       country: "US",
 *     },
 *   },
 *   spendingControls: {
 *     spendingLimits: [{ amount: 10000, interval: "monthly" }],
 *     spendingLimitsCurrency: "usd",
 *   },
 * });
 * ```
 *
 * ### Updating a Cardholder
 * **Example:** Email, phone, and metadata
 * ```typescript
 * const alice = yield* Stripe.IssuingCardholder("alice", {
 *   name: "Alice Example",
 *   email: "alice+updated@example.com",
 *   phoneNumber: "+15555550100",
 *   billing: {
 *     address: {
 *       line1: "123 Main Street",
 *       city: "San Francisco",
 *       state: "CA",
 *       postalCode: "94111",
 *       country: "US",
 *     },
 *   },
 *   metadata: { team: "ops" },
 * });
 * ```
 *
 * ### Deactivating a Cardholder
 * **Example:** Destroy deactivates rather than deleting
 * ```typescript
 * // stack.destroy() / resource removal sets status to inactive
 * const alice = yield* Stripe.IssuingCardholder("alice", {
 *   name: "Alice Example",
 *   billing: {
 *     address: {
 *       line1: "123 Main Street",
 *       city: "San Francisco",
 *       state: "CA",
 *       postalCode: "94111",
 *       country: "US",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const IssuingCardholder = Resource<IssuingCardholder>(
  "Stripe.IssuingCardholder",
);

export class IssuingCardholderNotResolved extends Data.TaggedError(
  "Stripe.IssuingCardholderNotResolved",
)<{
  name: string;
}> {}

type IssuingCardholderAttributes = IssuingCardholder["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const fromObservedBilling = (
  billing: StripeIssuingCardholder["billing"],
): IssuingCardholderBilling => ({
  address: {
    city: billing.address.city ?? "",
    country: billing.address.country ?? "",
    line1: billing.address.line1 ?? "",
    ...(billing.address.line2 ? { line2: billing.address.line2 } : {}),
    postalCode: billing.address.postal_code ?? "",
    ...(billing.address.state ? { state: billing.address.state } : {}),
  },
});

const toWireBilling = (
  billing: IssuingCardholderBilling,
): CreateIssuingCardholderRequestBilling => ({
  address: {
    city: billing.address.city,
    country: billing.address.country,
    line1: billing.address.line1,
    ...(billing.address.line2 !== undefined
      ? { line2: billing.address.line2 }
      : {}),
    postal_code: billing.address.postalCode,
    ...(billing.address.state !== undefined
      ? { state: billing.address.state }
      : {}),
  },
});

const fromObservedDob = (
  dob: NonNullable<StripeIssuingCardholder["individual"]>["dob"] | undefined,
): IssuingCardholderDob | undefined => {
  if (dob === null || dob === undefined) return undefined;
  if (dob.day === null || dob.month === null || dob.year === null) {
    return undefined;
  }
  return { day: dob.day, month: dob.month, year: dob.year };
};

const fromObservedSpendingControls = (
  controls: StripeIssuingCardholder["spending_controls"],
): IssuingCardholderSpendingControls | undefined => {
  if (controls === null || controls === undefined) return undefined;
  const spendingLimits = controls.spending_limits?.map((limit) => ({
    amount: limit.amount,
    ...(limit.categories !== null && limit.categories !== undefined
      ? { categories: [...limit.categories] }
      : {}),
    interval: limit.interval,
  }));
  const mapped: IssuingCardholderSpendingControls = {
    ...(controls.allowed_card_presences !== null &&
    controls.allowed_card_presences !== undefined
      ? { allowedCardPresences: [...controls.allowed_card_presences] }
      : {}),
    ...(controls.allowed_categories !== null &&
    controls.allowed_categories !== undefined
      ? { allowedCategories: [...controls.allowed_categories] }
      : {}),
    ...(controls.allowed_merchant_countries !== null &&
    controls.allowed_merchant_countries !== undefined
      ? { allowedMerchantCountries: [...controls.allowed_merchant_countries] }
      : {}),
    ...(controls.blocked_card_presences !== null &&
    controls.blocked_card_presences !== undefined
      ? { blockedCardPresences: [...controls.blocked_card_presences] }
      : {}),
    ...(controls.blocked_categories !== null &&
    controls.blocked_categories !== undefined
      ? { blockedCategories: [...controls.blocked_categories] }
      : {}),
    ...(controls.blocked_merchant_countries !== null &&
    controls.blocked_merchant_countries !== undefined
      ? { blockedMerchantCountries: [...controls.blocked_merchant_countries] }
      : {}),
    ...(spendingLimits !== undefined && spendingLimits !== null
      ? { spendingLimits }
      : {}),
    ...(controls.spending_limits_currency
      ? { spendingLimitsCurrency: controls.spending_limits_currency }
      : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
};

const toWireSpendingControls = (
  controls: IssuingCardholderSpendingControls,
): CreateIssuingCardholderRequestSpendingControls => ({
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
          ...(limit.categories !== undefined
            ? { categories: limit.categories }
            : {}),
          interval: limit.interval,
        })),
      }
    : {}),
  ...(controls.spendingLimitsCurrency !== undefined
    ? { spending_limits_currency: controls.spendingLimitsCurrency }
    : {}),
});

const toWireCompany = (
  company: IssuingCardholderCompany,
): CreateIssuingCardholderRequestCompany => ({
  ...(company.taxId !== undefined ? { tax_id: company.taxId } : {}),
});

const toWireIndividual = (
  individual: IssuingCardholderIndividual,
): CreateIssuingCardholderRequestIndividual => ({
  ...(individual.firstName !== undefined
    ? { first_name: individual.firstName }
    : {}),
  ...(individual.lastName !== undefined
    ? { last_name: individual.lastName }
    : {}),
  ...(individual.dob !== undefined
    ? {
        dob: {
          day: individual.dob.day,
          month: individual.dob.month,
          year: individual.dob.year,
        },
      }
    : {}),
});

const toAttrs = (
  cardholder: StripeIssuingCardholder,
): IssuingCardholderAttributes => ({
  id: cardholder.id,
  name: cardholder.name,
  type: cardholder.type,
  billing: fromObservedBilling(cardholder.billing),
  email: cardholder.email ?? undefined,
  phoneNumber: cardholder.phone_number ?? undefined,
  preferredLocales:
    cardholder.preferred_locales === null ||
    cardholder.preferred_locales === undefined
      ? undefined
      : [...cardholder.preferred_locales],
  status: cardholder.status,
  taxIdProvided: cardholder.company?.tax_id_provided,
  firstName: cardholder.individual?.first_name ?? undefined,
  lastName: cardholder.individual?.last_name ?? undefined,
  dob: fromObservedDob(cardholder.individual?.dob),
  spendingControls: fromObservedSpendingControls(cardholder.spending_controls),
  requirements: {
    disabledReason: cardholder.requirements.disabled_reason ?? undefined,
    pastDue:
      cardholder.requirements.past_due === null ||
      cardholder.requirements.past_due === undefined
        ? undefined
        : [...cardholder.requirements.past_due],
  },
  metadata: userMetadata(cardholder.metadata),
  created: cardholder.created,
  livemode: cardholder.livemode,
});

const isMissingCardholder = isMissingStripeResource;

const isIssuingNotEnabled = (error: StripeOpError): boolean =>
  error._tag === "InvalidRequestError" &&
  typeof error.message === "string" &&
  error.message.includes("not set up to use Issuing");

const getById = (cardholder: string) =>
  GetIssuingCardholder({ cardholder }).pipe(
    Effect.catchIf(isMissingCardholder, () => Effect.succeed(undefined)),
    Effect.catchIf(isIssuingNotEnabled, () => Effect.succeed(undefined)),
  );

const listByStatus = Effect.fn(function* (status: IssuingCardholderStatus) {
  const cardholders: StripeIssuingCardholder[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetIssuingCardholders({
      status,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    }).pipe(
      Effect.catchIf(isIssuingNotEnabled, () =>
        Effect.succeed({
          data: [] as StripeIssuingCardholder[],
          has_more: false,
          object: "list" as const,
          url: "/v1/issuing/cardholders",
        }),
      ),
    );
    cardholders.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return cardholders;
});

const listAllCardholders = Effect.fn(function* () {
  const [active, inactive, blocked] = yield* Effect.all(
    [listByStatus("active"), listByStatus("inactive"), listByStatus("blocked")],
    { concurrency: 3 },
  );
  const seen = new Set<string>();
  const cardholders: StripeIssuingCardholder[] = [];
  for (const cardholder of [...active, ...inactive, ...blocked]) {
    if (seen.has(cardholder.id)) continue;
    seen.add(cardholder.id);
    cardholders.push(cardholder);
  }
  return cardholders;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const cardholders = yield* listAllCardholders();
  const matches: StripeIssuingCardholder[] = [];
  for (const cardholder of cardholders) {
    if (yield* hasAlchemyMetadata(id, tagRecord(cardholder.metadata))) {
      matches.push(cardholder);
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
  news: IssuingCardholderProps,
  output: IssuingCardholderAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.name !== output.name) return true;
  if ((news.type ?? "individual") !== output.type && news.type !== undefined) {
    return true;
  }
  return false;
};

export const IssuingCardholderProvider = () =>
  Provider.succeed(IssuingCardholder, {
    stables: ["id", "name", "type", "created", "livemode"],

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
      // Inactive (deactivated) rows stay in Stripe but must not re-enter
      // nuke. Filter to alchemy_stack so account-wide teardown only
      // touches our rows.
      const [active, blocked] = yield* Effect.all(
        [listByStatus("active"), listByStatus("blocked")],
        { concurrency: 2 },
      );
      const seen = new Set<string>();
      const cardholders: StripeIssuingCardholder[] = [];
      for (const cardholder of [...active, ...blocked]) {
        if (seen.has(cardholder.id)) continue;
        seen.add(cardholder.id);
        cardholders.push(cardholder);
      }
      return cardholders
        .filter((cardholder) => {
          const metadata = tagRecord(cardholder.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredEmail = news.email ?? "";
      const desiredPhone = news.phoneNumber ?? "";
      const desiredStatus = news.status ?? "active";
      const desiredType = news.type ?? "individual";
      const desiredLocales = news.preferredLocales ?? [];
      const billing = toWireBilling(news.billing);

      let current: StripeIssuingCardholder | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateIssuingCardholder({
          name: news.name,
          billing,
          type: desiredType,
          status: desiredStatus,
          metadata,
          ...(desiredEmail.length > 0 ? { email: desiredEmail } : {}),
          ...(desiredPhone.length > 0 ? { phone_number: desiredPhone } : {}),
          ...(desiredLocales.length > 0
            ? { preferred_locales: desiredLocales }
            : {}),
          ...(news.company !== undefined
            ? { company: toWireCompany(news.company) }
            : {}),
          ...(news.individual !== undefined
            ? { individual: toWireIndividual(news.individual) }
            : {}),
          ...(news.spendingControls !== undefined
            ? {
                spending_controls: toWireSpendingControls(
                  news.spendingControls,
                ),
              }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-issuing-cardholder-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new IssuingCardholderNotResolved({ name: news.name });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const billingChanged = !deepEqual(
        fromObservedBilling(current.billing),
        news.billing,
        { stripNullish: true },
      );
      const emailChanged = (current.email ?? "") !== desiredEmail;
      const phoneChanged = (current.phone_number ?? "") !== desiredPhone;
      const statusChanged = current.status !== desiredStatus;
      const localesChanged = !arrayEquals(
        current.preferred_locales ?? [],
        desiredLocales,
      );
      const individualChanged =
        news.individual !== undefined &&
        !deepEqual(
          {
            firstName: current.individual?.first_name ?? undefined,
            lastName: current.individual?.last_name ?? undefined,
            dob: fromObservedDob(current.individual?.dob),
          },
          news.individual,
          { stripNullish: true },
        );
      const companyChanged =
        news.company?.taxId !== undefined &&
        current.company?.tax_id_provided !== true;
      const spendingControlsChanged =
        news.spendingControls !== undefined &&
        !deepEqual(
          fromObservedSpendingControls(current.spending_controls),
          news.spendingControls,
          { stripNullish: true },
        );

      if (
        !billingChanged &&
        !emailChanged &&
        !phoneChanged &&
        !statusChanged &&
        !localesChanged &&
        !individualChanged &&
        !companyChanged &&
        !spendingControlsChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdateIssuingCardholder({
        cardholder: current.id,
        ...(billingChanged ? { billing } : {}),
        ...(emailChanged ? { email: desiredEmail } : {}),
        ...(phoneChanged ? { phone_number: desiredPhone } : {}),
        ...(statusChanged ? { status: desiredStatus } : {}),
        ...(localesChanged ? { preferred_locales: desiredLocales } : {}),
        ...(individualChanged && news.individual !== undefined
          ? { individual: toWireIndividual(news.individual) }
          : {}),
        ...(companyChanged && news.company !== undefined
          ? { company: toWireCompany(news.company) }
          : {}),
        ...(spendingControlsChanged && news.spendingControls !== undefined
          ? { spending_controls: toWireSpendingControls(news.spendingControls) }
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
      if (existing === undefined || existing.status === "inactive") return;
      yield* UpdateIssuingCardholder({
        cardholder: existing.id,
        status: "inactive",
      }).pipe(Effect.catchIf(isMissingCardholder, () => Effect.void));
    }),
  });
