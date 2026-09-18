import {
  GetTaxSettings,
  CreateTaxSettings,
  type CreateTaxSettingsRequest,
  type CreateTaxSettingsRequestDefaults,
  type CreateTaxSettingsRequestHeadOfficeAddress,
  type TaxSettings as StripeTaxSettings,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { deepEqual } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/** Default [tax behavior](https://docs.stripe.com/tax/products-prices-tax-categories-tax-behavior#tax-behavior). Once set, Stripe will not unset it. */
export type TaxSettingsTaxBehavior =
  | "exclusive"
  | "inclusive"
  | "inferred_by_currency";

/** The tax calculation provider this account uses. */
export type TaxSettingsProviderKind = "anrok" | "avalara" | "sphere" | "stripe";

/** Status of the Tax Settings singleton. */
export type TaxSettingsStatus = "active" | "pending";

/** Head-office address fields Stripe Tax uses for calculations. */
export interface TaxSettingsAddress {
  /** City, district, suburb, town, or village. */
  city?: string;
  /** Two-letter ISO 3166-1 alpha-2 country code. */
  country?: string;
  /** Address line 1 (street, PO Box, or company name). */
  line1?: string;
  /** Address line 2 (apartment, suite, unit, or building). */
  line2?: string;
  /** ZIP or postal code. */
  postalCode?: string;
  /** ISO 3166-2 subdivision code without the country prefix (e.g. `"NY"`). */
  state?: string;
}

/** Place where the business is located. */
export interface TaxSettingsHeadOffice {
  /**
   * Location of the business for tax purposes. Stripe will not remove a
   * head office once set; fields can only be replaced with other values.
   */
  address: TaxSettingsAddress;
}

/** Default configuration used on Stripe Tax calculations. */
export interface TaxSettingsDefaults {
  /**
   * Default tax behavior when a price does not specify one. Once set,
   * Stripe will not unset it.
   */
  taxBehavior?: TaxSettingsTaxBehavior;
  /**
   * Default [tax code](https://docs.stripe.com/tax/tax-categories) used
   * to classify products and prices (e.g. `"txcd_99999999"`). Once set,
   * Stripe will not unset it.
   */
  taxCode?: string;
}

/**
 * Writable Tax Settings. Omitted fields keep the account's current value.
 * Stripe will not clear a field once it has been set.
 */
export interface TaxSettingsProps {
  /**
   * Default tax behavior and tax code used in calculations. Mutable —
   * posted in place. Fields Stripe has already set cannot be removed.
   */
  defaults?: TaxSettingsDefaults;
  /**
   * The place where the business is located. Mutable — posted in place.
   * Once set, Stripe will not remove the head office.
   */
  headOffice?: TaxSettingsHeadOffice;
}

/** Snapshot of restorable Tax Settings fields. */
export interface TaxSettingsSnapshot {
  /**
   * Default tax behavior, if Stripe reports one.
   */
  taxBehavior: TaxSettingsTaxBehavior | undefined;
  /**
   * Default tax code, if Stripe reports one.
   */
  taxCode: string | undefined;
  /**
   * Head-office address, if Stripe reports one.
   */
  headOffice: TaxSettingsAddress | undefined;
}

export type TaxSettings = Resource<
  "Stripe.TaxSettings",
  TaxSettingsProps,
  {
    /**
     * Stripe object type. Always `"tax.settings"` — this resource is the
     * account-level singleton.
     */
    object: "tax.settings";
    /** Default tax calculation provider for the account. */
    provider: TaxSettingsProviderKind;
    /** Default tax behavior, if set. */
    taxBehavior: TaxSettingsTaxBehavior | undefined;
    /** Default tax code, if set. */
    taxCode: string | undefined;
    /** Head-office address, if set. */
    headOffice: TaxSettingsAddress | undefined;
    /** Whether Stripe Tax is `active` or still `pending` missing fields. */
    status: TaxSettingsStatus;
    /**
     * Fields Stripe still requires before calculations can run. Present
     * while `status` is `pending`.
     */
    missingFields: string[] | undefined;
    /** Whether the settings exist in live mode. */
    livemode: boolean;
    /**
     * Snapshot of restorable fields taken before Alchemy first wrote.
     * `delete` posts these values back (Stripe will not unset a field that
     * was originally null).
     */
    initialSettings: TaxSettingsSnapshot;
  },
  never,
  Providers
>;

/**
 * Account-level Stripe Tax Settings — default tax behavior, default tax
 * code, and head-office address used by Stripe Tax calculations.
 *
 * This is an account singleton: `GET /v1/tax/settings` always returns the
 * merchant's settings, and `POST /v1/tax/settings` updates them in place.
 * There is no create or hard-delete. The first reconcile captures the
 * pre-management snapshot (`initialSettings`); destroy posts that snapshot
 * back. Stripe will not unset a field once it has been set, so a null
 * original is left as-is on restore.
 *
 * The Tax Settings object has no metadata. Alchemy does not stamp
 * ownership keys.
 *
 * @see https://docs.stripe.com/api/tax/settings
 *
 * ### Configuring defaults
 * **Example:** Exclusive default tax behavior
 * ```typescript
 * const settings = yield* Stripe.TaxSettings("tax", {
 *   defaults: { taxBehavior: "exclusive" },
 * });
 * ```
 *
 * **Example:** Default tax code
 * ```typescript
 * const settings = yield* Stripe.TaxSettings("tax", {
 *   defaults: {
 *     taxBehavior: "exclusive",
 *     taxCode: "txcd_99999999",
 *   },
 * });
 * ```
 *
 * ### Head office
 * **Example:** Set the business location
 * ```typescript
 * const settings = yield* Stripe.TaxSettings("tax", {
 *   headOffice: {
 *     address: { country: "US", state: "CA" },
 *   },
 * });
 * ```
 *
 * ### Restoring on destroy
 * **Example:** Destroy restores pre-management settings
 * ```typescript
 * // stack.destroy() posts `initialSettings` back (fields Stripe allows)
 * const settings = yield* Stripe.TaxSettings("tax", {
 *   defaults: { taxBehavior: "inclusive" },
 * });
 * ```
 *
 * @resource
 */
export const TaxSettings = Resource<TaxSettings>("Stripe.TaxSettings");

type TaxSettingsAttributes = TaxSettings["Attributes"];

const undef = <T>(value: T | null | undefined): T | undefined =>
  value == null ? undefined : value;

const toAddress = (
  address:
    | {
        city?: string | null;
        country?: string | null;
        line1?: string | null;
        line2?: string | null;
        postal_code?: string | null;
        state?: string | null;
      }
    | null
    | undefined,
): TaxSettingsAddress | undefined => {
  if (address == null) return undefined;
  const mapped: TaxSettingsAddress = {
    ...(address.city != null ? { city: address.city } : {}),
    ...(address.country != null ? { country: address.country } : {}),
    ...(address.line1 != null ? { line1: address.line1 } : {}),
    ...(address.line2 != null ? { line2: address.line2 } : {}),
    ...(address.postal_code != null ? { postalCode: address.postal_code } : {}),
    ...(address.state != null ? { state: address.state } : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
};

const toWireAddress = (
  address: TaxSettingsAddress,
): CreateTaxSettingsRequestHeadOfficeAddress => ({
  ...(address.city !== undefined ? { city: address.city } : {}),
  ...(address.country !== undefined ? { country: address.country } : {}),
  ...(address.line1 !== undefined ? { line1: address.line1 } : {}),
  ...(address.line2 !== undefined ? { line2: address.line2 } : {}),
  ...(address.postalCode !== undefined
    ? { postal_code: address.postalCode }
    : {}),
  ...(address.state !== undefined ? { state: address.state } : {}),
});

const toSnapshot = (settings: StripeTaxSettings): TaxSettingsSnapshot => ({
  taxBehavior: undef(settings.defaults.tax_behavior) as
    | TaxSettingsTaxBehavior
    | undefined,
  taxCode: undef(settings.defaults.tax_code),
  headOffice: toAddress(settings.head_office?.address),
});

const toAttrs = (
  settings: StripeTaxSettings,
  initialSettings: TaxSettingsSnapshot,
): TaxSettingsAttributes => ({
  object: "tax.settings",
  provider: settings.defaults.provider as TaxSettingsProviderKind,
  taxBehavior: undef(settings.defaults.tax_behavior) as
    | TaxSettingsTaxBehavior
    | undefined,
  taxCode: undef(settings.defaults.tax_code),
  headOffice: toAddress(settings.head_office?.address),
  status: settings.status,
  missingFields: undef(settings.status_details.pending?.missing_fields),
  livemode: settings.livemode,
  initialSettings,
});

const observe = GetTaxSettings({});

const desiredDefaults = (
  news: TaxSettingsProps,
): CreateTaxSettingsRequestDefaults | undefined => {
  if (news.defaults === undefined) return undefined;
  const defaults: CreateTaxSettingsRequestDefaults = {
    ...(news.defaults.taxBehavior !== undefined
      ? { tax_behavior: news.defaults.taxBehavior }
      : {}),
    ...(news.defaults.taxCode !== undefined
      ? { tax_code: news.defaults.taxCode }
      : {}),
  };
  return Object.keys(defaults).length > 0 ? defaults : undefined;
};

const desiredHeadOffice = (news: TaxSettingsProps) =>
  news.headOffice !== undefined
    ? { address: toWireAddress(news.headOffice.address) }
    : undefined;

const syncBody = (
  news: TaxSettingsProps,
  observed: StripeTaxSettings,
): CreateTaxSettingsRequest | undefined => {
  const body: CreateTaxSettingsRequest = {};
  const snapshot = toSnapshot(observed);
  const defaults = desiredDefaults(news);
  if (defaults !== undefined) {
    const taxBehaviorChanged =
      news.defaults?.taxBehavior !== undefined &&
      snapshot.taxBehavior !== news.defaults.taxBehavior;
    const taxCodeChanged =
      news.defaults?.taxCode !== undefined &&
      snapshot.taxCode !== news.defaults.taxCode;
    if (taxBehaviorChanged || taxCodeChanged) {
      body.defaults = defaults;
    }
  }
  const headOffice = desiredHeadOffice(news);
  if (
    headOffice !== undefined &&
    !deepEqual(snapshot.headOffice, news.headOffice?.address, {
      stripNullish: true,
    })
  ) {
    body.head_office = headOffice;
  }
  return Object.keys(body).length > 0 ? body : undefined;
};

const restoreBody = (
  initial: TaxSettingsSnapshot,
  observed: StripeTaxSettings,
): CreateTaxSettingsRequest | undefined => {
  const current = toSnapshot(observed);
  const body: CreateTaxSettingsRequest = {};
  const defaults: CreateTaxSettingsRequestDefaults = {};
  // Stripe will not unset a field that was originally null — only restore
  // values that were already set when Alchemy first captured the snapshot.
  if (
    initial.taxBehavior !== undefined &&
    current.taxBehavior !== initial.taxBehavior
  ) {
    defaults.tax_behavior = initial.taxBehavior;
  }
  if (initial.taxCode !== undefined && current.taxCode !== initial.taxCode) {
    defaults.tax_code = initial.taxCode;
  }
  if (Object.keys(defaults).length > 0) {
    body.defaults = defaults;
  }
  if (
    initial.headOffice !== undefined &&
    !deepEqual(current.headOffice, initial.headOffice, { stripNullish: true })
  ) {
    body.head_office = { address: toWireAddress(initial.headOffice) };
  }
  return Object.keys(body).length > 0 ? body : undefined;
};

export const TaxSettingsProvider = () =>
  Provider.succeed(TaxSettings, {
    // Account-global singleton: nuke must not reset merchant tax config.
    nuke: { singleton: true },
    stables: ["object", "livemode", "initialSettings"],

    diff: Effect.fn(function* () {
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const observed = yield* observe;
      // Always-present singleton — nothing to own, so a cold read adopts
      // freely (never `Unowned`). The observed snapshot at adoption time
      // becomes the baseline restored on destroy.
      return toAttrs(observed, output?.initialSettings ?? toSnapshot(observed));
    }),

    list: Effect.fn(function* () {
      // No collection API and no metadata. The singleton always exists;
      // return it as a one-element array. Cold observation uses the live
      // snapshot as `initialSettings`, so a nuke restore would be a no-op
      // (and nuke skips this type via `nuke.singleton` anyway).
      const observed = yield* observe;
      const snapshot = toSnapshot(observed);
      return [toAttrs(observed, snapshot)];
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // 1. Observe — the singleton always exists.
      let observed = yield* observe;

      // 2. Capture — the pre-management snapshot, restored on destroy.
      const initialSettings = output?.initialSettings ?? toSnapshot(observed);

      // 3. Sync — POST only the declared fields whose observed value
      //    differs. Skip the API on no delta.
      const body = syncBody(news, observed);
      if (body !== undefined) {
        observed = yield* CreateTaxSettings(body);
      }

      return toAttrs(observed, initialSettings);
    }),

    delete: Effect.fn(function* ({ output }) {
      const observed = yield* observe;
      const body = restoreBody(output.initialSettings, observed);
      if (body === undefined) return;
      yield* CreateTaxSettings(body);
    }),
  });
