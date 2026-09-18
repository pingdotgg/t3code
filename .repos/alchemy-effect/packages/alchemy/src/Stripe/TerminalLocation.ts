import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteTerminalLocation,
  GetTerminalLocations,
  GetTerminalLocation,
  CreateTerminalLocation,
  UpdateTerminalLocation,
  type Address,
  type DeletedTerminalLocation,
  type LegalEntityJapanAddress,
  type CreateAccountRequestCompanyAddressKana,
  type CreateTerminalLocationRequestAddress,
  type TerminalLocation as StripeTerminalLocation,
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

const NAME_MAX_LENGTH = 1000;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

export interface TerminalLocationAddress {
  /**
   * City, district, suburb, town, or village. Required in most countries.
   */
  city?: string;
  /**
   * Two-letter ISO 3166-1 alpha-2 country code. Create-only — changing
   * it replaces the location.
   */
  country: string;
  /**
   * Address line 1 (street, PO Box, or company name).
   */
  line1?: string;
  /**
   * Address line 2 (apartment, suite, unit, or building).
   */
  line2?: string;
  /**
   * ZIP or postal code. Required in most countries.
   */
  postalCode?: string;
  /**
   * State, county, province, or region (ISO 3166-2). Required in the US
   * and Canada.
   */
  state?: string;
}

export interface TerminalLocationJapanAddress {
  /**
   * City or ward.
   */
  city?: string;
  /**
   * Two-letter ISO 3166-1 alpha-2 country code.
   */
  country?: string;
  /**
   * Block or building number.
   */
  line1?: string;
  /**
   * Building details.
   */
  line2?: string;
  /**
   * Postal code.
   */
  postalCode?: string;
  /**
   * Prefecture.
   */
  state?: string;
  /**
   * Town or cho-me.
   */
  town?: string;
}

export interface TerminalLocationProps {
  /**
   * Display name of the location. If omitted, a unique name is generated
   * from the stack, stage, and logical id. Maximum length is 1000
   * characters. Mutable.
   */
  displayName?: string;
  /**
   * Full address of the location. `country` is required and create-only —
   * changing it replaces the location. Other fields update in place;
   * required fields vary by country.
   */
  address: TerminalLocationAddress;
  /**
   * Kana variation of the full address (Japan only). Mutable.
   */
  addressKana?: TerminalLocationJapanAddress;
  /**
   * Kanji variation of the full address (Japan only). Mutable.
   */
  addressKanji?: TerminalLocationJapanAddress;
  /**
   * Id of a Terminal Configuration applied to every reader at this
   * location. Empty string unsets. Mutable.
   */
  configurationOverrides?: string;
  /**
   * Kana variation of the display name (Japan only). Mutable.
   */
  displayNameKana?: string;
  /**
   * Kanji variation of the display name (Japan only). Mutable.
   */
  displayNameKanji?: string;
  /**
   * Phone number for the location. Empty string unsets. Mutable.
   */
  phone?: string;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`. Mutable.
   */
  metadata?: Record<string, string>;
}

export type TerminalLocation = Resource<
  "Stripe.TerminalLocation",
  TerminalLocationProps,
  {
    /** Stripe Terminal Location id (`tml_…`). */
    id: string;
    /** Display name of the location. */
    displayName: string;
    /** Full address of the location. */
    address: TerminalLocationAddress;
    /** Kana variation of the full address, if set. */
    addressKana: TerminalLocationJapanAddress | undefined;
    /** Kanji variation of the full address, if set. */
    addressKanji: TerminalLocationJapanAddress | undefined;
    /** Terminal Configuration id applied to readers at this location. */
    configurationOverrides: string | undefined;
    /** Kana variation of the display name, if set. */
    displayNameKana: string | undefined;
    /** Kanji variation of the display name, if set. */
    displayNameKanji: string | undefined;
    /** Phone number for the location, if set. */
    phone: string | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Whether the location exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Terminal Location — a grouping of Terminal readers at a
 * physical site. Display name, phone, metadata, configuration overrides,
 * and address fields other than `country` update in place. Changing
 * `address.country` replaces the location; re-register readers on the
 * new one.
 *
 * Destroy hard-deletes the location.
 *
 * @see https://docs.stripe.com/api/terminal/locations
 *
 * ### Creating a Location
 * **Example:** US storefront
 * ```typescript
 * const store = yield* Stripe.TerminalLocation("storefront", {
 *   displayName: "Market Street",
 *   address: {
 *     line1: "123 Market Street",
 *     city: "San Francisco",
 *     state: "CA",
 *     postalCode: "94105",
 *     country: "US",
 *   },
 * });
 * ```
 *
 * **Example:** Generated name with phone and metadata
 * ```typescript
 * const kiosk = yield* Stripe.TerminalLocation("kiosk", {
 *   address: {
 *     line1: "1 Infinite Loop",
 *     city: "Cupertino",
 *     state: "CA",
 *     postalCode: "95014",
 *     country: "US",
 *   },
 *   phone: "+14085551234",
 *   metadata: { region: "west" },
 * });
 * ```
 *
 * ### Updating a Location
 * **Example:** Rename and retag
 * ```typescript
 * const store = yield* Stripe.TerminalLocation("storefront", {
 *   displayName: "Market Street Annex",
 *   address: {
 *     line1: "125 Market Street",
 *     city: "San Francisco",
 *     state: "CA",
 *     postalCode: "94105",
 *     country: "US",
 *   },
 *   metadata: { region: "west" },
 * });
 * ```
 *
 * ### Deleting a Location
 * **Example:** Destroy deletes the location
 * ```typescript
 * // stack.destroy() / resource removal calls DELETE
 * const store = yield* Stripe.TerminalLocation("storefront", {
 *   address: {
 *     line1: "123 Market Street",
 *     city: "San Francisco",
 *     state: "CA",
 *     postalCode: "94105",
 *     country: "US",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const TerminalLocation = Resource<TerminalLocation>(
  "Stripe.TerminalLocation",
);

export class TerminalLocationNotResolved extends Data.TaggedError(
  "Stripe.TerminalLocationNotResolved",
)<{
  displayName: string;
}> {}

type TerminalLocationAttributes = TerminalLocation["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const optionalString = (
  value: string | null | undefined,
): string | undefined => (value == null || value === "" ? undefined : value);

const fromObservedAddress = (address: Address): TerminalLocationAddress => ({
  country: address.country ?? "",
  ...(optionalString(address.city) !== undefined
    ? { city: optionalString(address.city) }
    : {}),
  ...(optionalString(address.line1) !== undefined
    ? { line1: optionalString(address.line1) }
    : {}),
  ...(optionalString(address.line2) !== undefined
    ? { line2: optionalString(address.line2) }
    : {}),
  ...(optionalString(address.postal_code) !== undefined
    ? { postalCode: optionalString(address.postal_code) }
    : {}),
  ...(optionalString(address.state) !== undefined
    ? { state: optionalString(address.state) }
    : {}),
});

const fromObservedJapanAddress = (
  address: LegalEntityJapanAddress | undefined,
): TerminalLocationJapanAddress | undefined => {
  if (address === undefined) return undefined;
  const mapped: TerminalLocationJapanAddress = {
    ...(optionalString(address.city) !== undefined
      ? { city: optionalString(address.city) }
      : {}),
    ...(optionalString(address.country) !== undefined
      ? { country: optionalString(address.country) }
      : {}),
    ...(optionalString(address.line1) !== undefined
      ? { line1: optionalString(address.line1) }
      : {}),
    ...(optionalString(address.line2) !== undefined
      ? { line2: optionalString(address.line2) }
      : {}),
    ...(optionalString(address.postal_code) !== undefined
      ? { postalCode: optionalString(address.postal_code) }
      : {}),
    ...(optionalString(address.state) !== undefined
      ? { state: optionalString(address.state) }
      : {}),
    ...(optionalString(address.town) !== undefined
      ? { town: optionalString(address.town) }
      : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
};

const toWireAddress = (
  address: TerminalLocationAddress,
): CreateTerminalLocationRequestAddress => ({
  country: address.country,
  ...(address.city !== undefined ? { city: address.city } : {}),
  ...(address.line1 !== undefined ? { line1: address.line1 } : {}),
  ...(address.line2 !== undefined ? { line2: address.line2 } : {}),
  ...(address.postalCode !== undefined
    ? { postal_code: address.postalCode }
    : {}),
  ...(address.state !== undefined ? { state: address.state } : {}),
});

const toWireJapanAddress = (
  address: TerminalLocationJapanAddress,
): CreateAccountRequestCompanyAddressKana => ({
  ...(address.city !== undefined ? { city: address.city } : {}),
  ...(address.country !== undefined ? { country: address.country } : {}),
  ...(address.line1 !== undefined ? { line1: address.line1 } : {}),
  ...(address.line2 !== undefined ? { line2: address.line2 } : {}),
  ...(address.postalCode !== undefined
    ? { postal_code: address.postalCode }
    : {}),
  ...(address.state !== undefined ? { state: address.state } : {}),
  ...(address.town !== undefined ? { town: address.town } : {}),
});

const isDeletedLocation = (
  value: StripeTerminalLocation | DeletedTerminalLocation,
): value is DeletedTerminalLocation =>
  "deleted" in value && value.deleted === true;

const asLocation = (
  value: StripeTerminalLocation | DeletedTerminalLocation | undefined,
): StripeTerminalLocation | undefined => {
  if (value === undefined || isDeletedLocation(value)) return undefined;
  return value;
};

const toAttrs = (
  location: StripeTerminalLocation,
): TerminalLocationAttributes => ({
  id: location.id,
  displayName: location.display_name,
  address: fromObservedAddress(location.address),
  addressKana: fromObservedJapanAddress(location.address_kana),
  addressKanji: fromObservedJapanAddress(location.address_kanji),
  configurationOverrides: optionalString(location.configuration_overrides),
  displayNameKana: optionalString(location.display_name_kana),
  displayNameKanji: optionalString(location.display_name_kanji),
  phone: optionalString(location.phone),
  metadata: userMetadata(location.metadata),
  livemode: location.livemode,
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

const isMissingLocation = isMissingStripeResource;

const getById = (location: string) =>
  GetTerminalLocation({ location }).pipe(
    Effect.map(asLocation),
    Effect.catchIf(isMissingLocation, () => Effect.succeed(undefined)),
  );

const listAllLocations = Effect.fn(function* () {
  const locations: StripeTerminalLocation[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetTerminalLocations({
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    locations.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return locations;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const locations = yield* listAllLocations();
  const matches: StripeTerminalLocation[] = [];
  for (const location of locations) {
    if (yield* hasAlchemyMetadata(id, tagRecord(location.metadata))) {
      matches.push(location);
    }
  }
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
  news: TerminalLocationProps,
  output: TerminalLocationAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  return news.address.country !== output.address.country;
};

export const TerminalLocationProvider = () =>
  Provider.succeed(TerminalLocation, {
    stables: ["id", "livemode"],

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
      const locations = yield* listAllLocations();
      return locations
        .filter((location) => {
          const metadata = tagRecord(location.metadata);
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
      const desiredPhone = news.phone ?? "";
      const desiredConfig = news.configurationOverrides ?? "";
      const desiredDisplayNameKana = news.displayNameKana ?? "";
      const desiredDisplayNameKanji = news.displayNameKanji ?? "";
      const address = toWireAddress(news.address);

      let current: StripeTerminalLocation | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateTerminalLocation({
          display_name: displayName,
          address,
          metadata,
          ...(news.addressKana !== undefined
            ? { address_kana: toWireJapanAddress(news.addressKana) }
            : {}),
          ...(news.addressKanji !== undefined
            ? { address_kanji: toWireJapanAddress(news.addressKanji) }
            : {}),
          ...(desiredConfig.length > 0
            ? { configuration_overrides: desiredConfig }
            : {}),
          ...(desiredDisplayNameKana.length > 0
            ? { display_name_kana: desiredDisplayNameKana }
            : {}),
          ...(desiredDisplayNameKanji.length > 0
            ? { display_name_kanji: desiredDisplayNameKanji }
            : {}),
          ...(desiredPhone.length > 0 ? { phone: desiredPhone } : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-terminal-location-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new TerminalLocationNotResolved({ displayName });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = current.display_name !== displayName;
      const addressChanged = !deepEqual(
        fromObservedAddress(current.address),
        news.address,
        { stripNullish: true },
      );
      const addressKanaChanged =
        news.addressKana !== undefined &&
        !deepEqual(
          fromObservedJapanAddress(current.address_kana),
          news.addressKana,
          { stripNullish: true },
        );
      const addressKanjiChanged =
        news.addressKanji !== undefined &&
        !deepEqual(
          fromObservedJapanAddress(current.address_kanji),
          news.addressKanji,
          { stripNullish: true },
        );
      const phoneChanged = (current.phone ?? "") !== desiredPhone;
      const configChanged =
        (current.configuration_overrides ?? "") !== desiredConfig;
      const displayNameKanaChanged =
        (current.display_name_kana ?? "") !== desiredDisplayNameKana;
      const displayNameKanjiChanged =
        (current.display_name_kanji ?? "") !== desiredDisplayNameKanji;

      if (
        !displayNameChanged &&
        !addressChanged &&
        !addressKanaChanged &&
        !addressKanjiChanged &&
        !phoneChanged &&
        !configChanged &&
        !displayNameKanaChanged &&
        !displayNameKanjiChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdateTerminalLocation({
        location: current.id,
        ...(displayNameChanged ? { display_name: displayName } : {}),
        ...(addressChanged ? { address } : {}),
        ...(addressKanaChanged && news.addressKana !== undefined
          ? { address_kana: toWireJapanAddress(news.addressKana) }
          : {}),
        ...(addressKanjiChanged && news.addressKanji !== undefined
          ? { address_kanji: toWireJapanAddress(news.addressKanji) }
          : {}),
        ...(configChanged ? { configuration_overrides: desiredConfig } : {}),
        ...(displayNameKanaChanged
          ? { display_name_kana: desiredDisplayNameKana }
          : {}),
        ...(displayNameKanjiChanged
          ? { display_name_kanji: desiredDisplayNameKanji }
          : {}),
        ...(phoneChanged ? { phone: desiredPhone } : {}),
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
      const location = asLocation(updated);
      if (location === undefined) {
        return yield* new TerminalLocationNotResolved({ displayName });
      }
      return toAttrs(location);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteTerminalLocation({ location: output.id }).pipe(
        Effect.catchIf(isMissingLocation, () => Effect.void),
      );
    }),
  });
