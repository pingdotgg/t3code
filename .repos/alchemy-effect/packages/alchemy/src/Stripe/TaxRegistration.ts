import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetTaxRegistrations,
  GetTaxRegistration,
  CreateTaxRegistration,
  UpdateTaxRegistration,
  type CreateTaxRegistrationRequestCountryOptions,
  type TaxProductRegistrationsResourceCountryOptions,
  type TaxRegistration as StripeTaxRegistration,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** The status of the registration, derived from `activeFrom` and `expiresAt`. */
export type TaxRegistrationStatus = "active" | "expired" | "scheduled";

/** When the registration becomes active. `"now"` means the current time. */
export type TaxRegistrationActiveFrom = "now" | number;

/**
 * When the registration stops being active. `"now"` expires immediately.
 * `null` clears a previously scheduled expiry.
 */
export type TaxRegistrationExpiresAt = "now" | number | null;

/** Place of supply scheme used in a standard registration. */
export type TaxRegistrationPlaceOfSupplyScheme = "inbound_goods" | "standard";

/** Place of supply scheme used in an EU standard registration. */
export type TaxRegistrationEuPlaceOfSupplyScheme =
  | "inbound_goods"
  | "small_seller"
  | "standard";

/** Type of registration in an EU country. */
export type TaxRegistrationEuropeType =
  | "ioss"
  | "oss_non_union"
  | "oss_union"
  | "standard";

/** Type of registration in Canada. */
export type TaxRegistrationCanadaType =
  | "province_standard"
  | "simplified"
  | "standard";

/** Type of registration in the US. */
export type TaxRegistrationUnitedStatesType =
  | "local_amusement_tax"
  | "local_lease_tax"
  | "state_communications_tax"
  | "state_retail_delivery_fee"
  | "state_sales_tax";

/** Election type for a US state sales tax registration. */
export type TaxRegistrationUsStateSalesTaxElectionType =
  | "local_use_tax"
  | "simplified_sellers_use_tax"
  | "single_local_use_tax";

/** ISO country codes that use a standard (optionally inbound-goods) registration. */
export type TaxRegistrationStandardCountryCode =
  | "ae"
  | "al"
  | "ao"
  | "au"
  | "aw"
  | "ba"
  | "bb"
  | "bd"
  | "bf"
  | "bh"
  | "bs"
  | "cd"
  | "ch"
  | "et"
  | "gb"
  | "gn"
  | "is"
  | "jp"
  | "me"
  | "mk"
  | "mr"
  | "no"
  | "nz"
  | "om"
  | "rs"
  | "sg"
  | "sr"
  | "uy"
  | "za"
  | "zw";

/** ISO country codes that use a simplified registration. */
export type TaxRegistrationSimplifiedCountryCode =
  | "am"
  | "az"
  | "bj"
  | "by"
  | "cl"
  | "cm"
  | "co"
  | "cr"
  | "cv"
  | "ec"
  | "eg"
  | "ge"
  | "id"
  | "in"
  | "ke"
  | "kg"
  | "kh"
  | "kr"
  | "kz"
  | "la"
  | "lk"
  | "ma"
  | "md"
  | "mx"
  | "my"
  | "ng"
  | "np"
  | "pe"
  | "ph"
  | "ru"
  | "sa"
  | "sn"
  | "th"
  | "tj"
  | "tr"
  | "tw"
  | "tz"
  | "ua"
  | "ug"
  | "uz"
  | "vn"
  | "zm";

/** ISO country codes that use an EU registration (standard / OSS / IOSS). */
export type TaxRegistrationEuropeCountryCode =
  | "at"
  | "be"
  | "bg"
  | "cy"
  | "cz"
  | "de"
  | "dk"
  | "ee"
  | "es"
  | "fi"
  | "fr"
  | "gr"
  | "hr"
  | "hu"
  | "ie"
  | "it"
  | "lt"
  | "lu"
  | "lv"
  | "mt"
  | "nl"
  | "pl"
  | "pt"
  | "ro"
  | "se"
  | "si"
  | "sk";

export interface TaxRegistrationStandardOption {
  /**
   * A standard Tax Registration in the specified country.
   */
  type: "standard";
  /**
   * Options for the standard registration.
   */
  standard?: {
    /**
     * Place of supply scheme. `inbound_goods` collects tax at destination
     * for inbound physical goods; `standard` applies tax to sales in this
     * country only.
     */
    placeOfSupplyScheme?: TaxRegistrationPlaceOfSupplyScheme;
  };
}

export interface TaxRegistrationSimplifiedOption {
  /**
   * A simplified Tax Registration in the specified country.
   */
  type: "simplified";
}

export interface TaxRegistrationEuropeOption {
  /**
   * Type of registration in an EU country.
   */
  type: TaxRegistrationEuropeType;
  /**
   * Options for an EU standard registration. Required when `type` is
   * `"standard"`.
   */
  standard?: {
    /**
     * Place of supply scheme used in an EU standard registration.
     */
    placeOfSupplyScheme?: TaxRegistrationEuPlaceOfSupplyScheme;
  };
}

export interface TaxRegistrationCanadaOption {
  /**
   * Type of registration in Canada.
   */
  type: TaxRegistrationCanadaType;
  /**
   * Province-standard options. Required when `type` is
   * `"province_standard"`.
   */
  provinceStandard?: {
    /**
     * Two-letter CA province code (ISO 3166-2, without country prefix).
     */
    province: string;
  };
}

export interface TaxRegistrationUsStateSalesTaxElection {
  /**
   * The type of the election for the state sales tax registration.
   */
  type: TaxRegistrationUsStateSalesTaxElectionType;
  /**
   * A FIPS code representing the local jurisdiction, when required.
   */
  jurisdiction?: string;
}

export interface TaxRegistrationUnitedStatesOption {
  /**
   * Type of registration in the US.
   */
  type: TaxRegistrationUnitedStatesType;
  /**
   * Two-letter US state code (ISO 3166-2, without country prefix).
   */
  state: string;
  /**
   * Options for a local amusement tax registration.
   */
  localAmusementTax?: {
    /**
     * A FIPS code representing the local jurisdiction.
     */
    jurisdiction: string;
  };
  /**
   * Options for a local lease tax registration.
   */
  localLeaseTax?: {
    /**
     * A FIPS code representing the local jurisdiction.
     */
    jurisdiction: string;
  };
  /**
   * Options for a state sales tax registration.
   */
  stateSalesTax?: {
    /**
     * Elections for the state sales tax registration.
     */
    elections?: TaxRegistrationUsStateSalesTaxElection[];
  };
}

/**
 * Country-specific registration options. Set exactly the key matching
 * `country` (lowercase ISO 3166-1 alpha-2).
 */
export type TaxRegistrationCountryOptions = {
  [K in TaxRegistrationStandardCountryCode]?: TaxRegistrationStandardOption;
} & {
  [K in TaxRegistrationSimplifiedCountryCode]?: TaxRegistrationSimplifiedOption;
} & {
  [K in TaxRegistrationEuropeCountryCode]?: TaxRegistrationEuropeOption;
} & {
  ca?: TaxRegistrationCanadaOption;
  us?: TaxRegistrationUnitedStatesOption;
};

export interface TaxRegistrationProps {
  /**
   * Two-letter country code (ISO 3166-1 alpha-2). Create-only — changing
   * it replaces the registration.
   */
  country: string;
  /**
   * Specific options for a registration in `country`. Create-only —
   * changing them replaces the registration.
   */
  countryOptions: TaxRegistrationCountryOptions;
  /**
   * Time at which the registration becomes active. `"now"` or a Unix
   * timestamp in seconds. Mutable.
   * @default "now"
   */
  activeFrom?: TaxRegistrationActiveFrom;
  /**
   * Time at which the registration stops being active. `"now"`, a Unix
   * timestamp in seconds, or `null` to clear a scheduled expiry. Omit for
   * no expiry. Destroying this resource sets `expiresAt` to `"now"`.
   * Mutable.
   */
  expiresAt?: TaxRegistrationExpiresAt;
}

export type TaxRegistration = Resource<
  "Stripe.TaxRegistration",
  TaxRegistrationProps,
  {
    /** Stripe tax registration id (`taxreg_…`). */
    id: string;
    /** Two-letter country code (ISO 3166-1 alpha-2). */
    country: string;
    /** Country-specific registration options. */
    countryOptions: TaxRegistrationCountryOptions;
    /** Unix timestamp when the registration becomes active. */
    activeFrom: number;
    /** Unix timestamp when the registration stops being active, if set. */
    expiresAt: number | undefined;
    /** Status derived from `activeFrom` and `expiresAt`. */
    status: TaxRegistrationStatus;
    /** Unix timestamp when the registration was created. */
    created: number;
    /** Whether the registration exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Tax Registration — records that your business is registered to
 * collect tax in a region so Stripe Tax can calculate and collect it.
 * Stripe does not register with tax authorities on your behalf.
 *
 * `country` and `countryOptions` are immutable and changing them replaces
 * the registration. `activeFrom` and `expiresAt` update in place.
 *
 * A registration cannot be hard-deleted. Destroying this resource expires
 * it (`expiresAt: "now"`). Expiration is permanent; to collect tax in
 * that location again, create a new registration.
 *
 * Tax registrations have no metadata field. Identity is the Stripe id
 * (and, when the id is missing, a matching non-expired country + options
 * pair). `list()` returns every non-expired registration on the account.
 *
 * A head office address must be configured on Tax Settings before a
 * registration can be created.
 *
 * @see https://docs.stripe.com/api/tax/registrations
 *
 * ### Creating a Tax Registration
 * **Example:** US state sales tax
 * ```typescript
 * const california = yield* Stripe.TaxRegistration("ca-sales-tax", {
 *   country: "US",
 *   countryOptions: {
 *     us: { type: "state_sales_tax", state: "CA" },
 *   },
 * });
 * ```
 *
 * **Example:** Simplified registration
 * ```typescript
 * const tajikistan = yield* Stripe.TaxRegistration("tj", {
 *   country: "TJ",
 *   countryOptions: { tj: { type: "simplified" } },
 * });
 * ```
 *
 * **Example:** EU OSS Union
 * ```typescript
 * const irelandOss = yield* Stripe.TaxRegistration("ie-oss", {
 *   country: "IE",
 *   countryOptions: { ie: { type: "oss_union" } },
 *   activeFrom: "now",
 * });
 * ```
 *
 * ### Updating a Tax Registration
 * **Example:** Schedule an expiry
 * ```typescript
 * const california = yield* Stripe.TaxRegistration("ca-sales-tax", {
 *   country: "US",
 *   countryOptions: {
 *     us: { type: "state_sales_tax", state: "CA" },
 *   },
 *   expiresAt: 1893456000,
 * });
 * ```
 *
 * ### Expiring a Tax Registration
 * **Example:** Destroy expires rather than deleting
 * ```typescript
 * // stack.destroy() / resource removal sets expiresAt to "now"
 * const california = yield* Stripe.TaxRegistration("ca-sales-tax", {
 *   country: "US",
 *   countryOptions: {
 *     us: { type: "state_sales_tax", state: "CA" },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const TaxRegistration = Resource<TaxRegistration>(
  "Stripe.TaxRegistration",
);

export class TaxRegistrationNotResolved extends Data.TaggedError(
  "Stripe.TaxRegistrationNotResolved",
)<{
  country: string;
}> {}

type TaxRegistrationAttributes = TaxRegistration["Attributes"];

const CAMEL_TO_SNAKE: Record<string, string> = {
  placeOfSupplyScheme: "place_of_supply_scheme",
  provinceStandard: "province_standard",
  localAmusementTax: "local_amusement_tax",
  localLeaseTax: "local_lease_tax",
  stateSalesTax: "state_sales_tax",
};

const SNAKE_TO_CAMEL: Record<string, string> = Object.fromEntries(
  Object.entries(CAMEL_TO_SNAKE).map(([camel, snake]) => [snake, camel]),
);

const renameDeep = (value: unknown, map: Record<string, string>): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => renameDeep(item, map));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        map[key] ?? key,
        renameDeep(nested, map),
      ]),
    );
  }
  return value;
};

const toWireCountryOptions = (
  options: TaxRegistrationCountryOptions,
): CreateTaxRegistrationRequestCountryOptions =>
  renameDeep(
    options,
    CAMEL_TO_SNAKE,
  ) as CreateTaxRegistrationRequestCountryOptions;

const fromWireCountryOptions = (
  options: TaxProductRegistrationsResourceCountryOptions,
): TaxRegistrationCountryOptions =>
  renameDeep(options, SNAKE_TO_CAMEL) as TaxRegistrationCountryOptions;

const identityKey = (
  country: string,
  options: TaxRegistrationCountryOptions,
): string => {
  const parts: string[] = [];
  for (const [code, option] of Object.entries(options)) {
    if (option == null || typeof option !== "object") continue;
    const record = option as unknown as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const state = typeof record.state === "string" ? record.state : "";
    const provinceStandard = record.provinceStandard as
      | { province?: string }
      | undefined;
    const province = provinceStandard?.province ?? "";
    parts.push(`${code}:${type}:${state}:${province}`);
  }
  parts.sort();
  return `${country.toUpperCase()}|${parts.join(",")}`;
};

const toAttrs = (
  registration: StripeTaxRegistration,
): TaxRegistrationAttributes => ({
  id: registration.id,
  country: registration.country,
  countryOptions: fromWireCountryOptions(registration.country_options),
  activeFrom: registration.active_from,
  expiresAt: registration.expires_at ?? undefined,
  status: registration.status,
  created: registration.created,
  livemode: registration.livemode,
});

const isMissingRegistration = isMissingStripeResource;

const getById = (id: string) =>
  GetTaxRegistration({ id }).pipe(
    Effect.catchIf(isMissingRegistration, () => Effect.succeed(undefined)),
  );

const listByStatus = Effect.fn(function* (
  status: "active" | "all" | "expired" | "scheduled",
) {
  const registrations: StripeTaxRegistration[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetTaxRegistrations({
      status,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    registrations.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return registrations;
});

const findByIdentity = Effect.fn(function* (
  country: string,
  options: TaxRegistrationCountryOptions,
) {
  const desired = identityKey(country, options);
  const registrations = yield* listByStatus("all");
  const matches = registrations.filter(
    (registration) =>
      registration.status !== "expired" &&
      identityKey(
        registration.country,
        fromWireCountryOptions(registration.country_options),
      ) === desired,
  );
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const observe = Effect.fn(function* (input: {
  id?: string;
  country?: string;
  countryOptions?: TaxRegistrationCountryOptions;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  if (input.country !== undefined && input.countryOptions !== undefined) {
    return yield* findByIdentity(input.country, input.countryOptions);
  }
  return undefined;
});

const shouldReplace = (
  news: TaxRegistrationProps,
  output: TaxRegistrationAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.country.toUpperCase() !== output.country.toUpperCase()) {
    return true;
  }
  return (
    identityKey(news.country, news.countryOptions) !==
    identityKey(output.country, output.countryOptions)
  );
};

const desiredExpiresAt = (
  expiresAt: TaxRegistrationExpiresAt | undefined,
): number | null | undefined => {
  if (expiresAt === undefined) return null;
  if (expiresAt === "now") return undefined;
  return expiresAt;
};

export const TaxRegistrationProvider = () =>
  Provider.succeed(TaxRegistration, {
    stables: ["id", "country", "countryOptions", "created", "livemode"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const existing = yield* observe({
        id: output?.id,
        country: output?.country,
        countryOptions: output?.countryOptions,
      });
      if (existing === undefined) return undefined;
      // Tax registrations have no metadata. Identity is the Stripe id and
      // the non-expired country + options pair; a match is treated as owned.
      return toAttrs(existing);
    }),

    list: Effect.fn(function* () {
      // No metadata on this resource. Default list is non-expired
      // registrations; expired rows stay in Stripe but must not re-enter
      // nuke.
      const [active, scheduled] = yield* Effect.all(
        [listByStatus("active"), listByStatus("scheduled")],
        { concurrency: 2 },
      );
      const seen = new Set<string>();
      const registrations: StripeTaxRegistration[] = [];
      for (const registration of [...active, ...scheduled]) {
        if (seen.has(registration.id)) continue;
        seen.add(registration.id);
        registrations.push(registration);
      }
      return registrations.map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ news, output, instanceId }) {
      const desiredActiveFrom = news.activeFrom ?? "now";
      const countryOptions = toWireCountryOptions(news.countryOptions);

      let current = yield* observe({
        id: output?.id,
        country: news.country,
        countryOptions: news.countryOptions,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateTaxRegistration({
          country: news.country,
          country_options: countryOptions,
          active_from: desiredActiveFrom,
          ...(typeof news.expiresAt === "number"
            ? { expires_at: news.expiresAt }
            : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-tax-registration-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new TaxRegistrationNotResolved({ country: news.country });
      }

      const activeFromChanged =
        typeof desiredActiveFrom === "number" &&
        current.active_from !== desiredActiveFrom;
      const activateNow =
        desiredActiveFrom === "now" && current.status === "scheduled";

      const expiresDesired = desiredExpiresAt(news.expiresAt);
      const expiresObserved = current.expires_at;
      const expireNow =
        news.expiresAt === "now" && current.status !== "expired";
      const expiresChanged =
        expiresDesired !== undefined &&
        !deepEqual(expiresDesired, expiresObserved, { stripNullish: true });

      if (!activeFromChanged && !activateNow && !expireNow && !expiresChanged) {
        return toAttrs(current);
      }

      const updated = yield* UpdateTaxRegistration({
        id: current.id,
        ...(activeFromChanged || activateNow
          ? { active_from: desiredActiveFrom }
          : {}),
        ...(expireNow
          ? { expires_at: "now" }
          : expiresChanged
            ? {
                expires_at:
                  expiresDesired === null
                    ? ("" as const)
                    : (expiresDesired as number),
              }
            : {}),
      });
      return toAttrs(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || existing.status === "expired") return;
      // Stripe requires expires_at > active_from and strictly in the
      // future. `expires_at: "now"` fails when the registration was
      // created in the same unix second; `expires_at: nowSec` fails
      // when the clock ticks between compute and the request.
      const nowSec = yield* Effect.sync(() => Math.floor(Date.now() / 1000));
      const expiresAt = Math.max(nowSec + 1, existing.active_from + 1);
      yield* UpdateTaxRegistration({
        id: existing.id,
        expires_at: expiresAt,
      }).pipe(Effect.catchIf(isMissingRegistration, () => Effect.void));
    }),
  });
