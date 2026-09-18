import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetIssuingPersonalizationDesigns,
  GetIssuingPersonalizationDesign,
  CreateIssuingPersonalizationDesign,
  UpdateIssuingPersonalizationDesign,
  type IssuingPersonalizationDesign as StripeIssuingPersonalizationDesign,
  type CreateIssuingPersonalizationDesignRequestCarrierText,
} from "@distilled.cloud/stripe/stripe";
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
const LOOKUP_KEY_MAX_LENGTH = 200;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** Whether this personalization design can be used to create cards. */
export type IssuingPersonalizationDesignStatus =
  | "active"
  | "inactive"
  | "rejected"
  | "review";

/** Reason a card logo was rejected. */
export type IssuingPersonalizationDesignCardLogoRejection =
  | "geographic_location"
  | "inappropriate"
  | "network_name"
  | "non_binary_image"
  | "non_fiat_currency"
  | "other"
  | "other_entity"
  | "promotional_material";

/** Reason carrier text was rejected. */
export type IssuingPersonalizationDesignCarrierTextRejection =
  | "geographic_location"
  | "inappropriate"
  | "network_name"
  | "non_fiat_currency"
  | "other"
  | "other_entity"
  | "promotional_material";

/**
 * Carrier-letter copy for physical bundles that support carrier text.
 */
export interface IssuingPersonalizationDesignCarrierText {
  /**
   * Footer body text of the carrier letter.
   */
  footerBody?: string;
  /**
   * Footer title text of the carrier letter.
   */
  footerTitle?: string;
  /**
   * Header body text of the carrier letter.
   */
  headerBody?: string;
  /**
   * Header title text of the carrier letter.
   */
  headerTitle?: string;
}

/**
 * Whether this design is used when a card is created without a
 * personalization design.
 */
export interface IssuingPersonalizationDesignPreferences {
  /**
   * When true, Stripe uses this design to create cards when one isn't
   * specified. Connected accounts fall back to the platform default if
   * none is set.
   * @default false
   */
  isDefault?: boolean;
}

export interface IssuingPersonalizationDesignProps {
  /**
   * Id of the physical bundle (`ics_…`) this design ships with. Required.
   * Mutable — changing it updates the design in place.
   */
  physicalBundle: string;
  /**
   * Friendly display name. If omitted, a unique name is generated from
   * the stack, stage, and logical id. Mutable.
   */
  name?: string;
  /**
   * Lookup key used to retrieve this design from a static string. Unique
   * per account, max 200 characters. If omitted, a unique key is
   * generated. Mutable — a change transfers the key onto this design.
   */
  lookupKey?: string;
  /**
   * File id (`file_…`) of the card logo. Must have purpose
   * `issuing_logo` (PNG, 1000×200, black on white). Mutable.
   */
  cardLogo?: string;
  /**
   * Carrier-letter copy. Omit or leave empty to clear. Mutable.
   */
  carrierText?: IssuingPersonalizationDesignCarrierText;
  /**
   * Default-design preference. Mutable.
   */
  preferences?: IssuingPersonalizationDesignPreferences;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`. Mutable.
   */
  metadata?: Record<string, string>;
}

export type IssuingPersonalizationDesign = Resource<
  "Stripe.IssuingPersonalizationDesign",
  IssuingPersonalizationDesignProps,
  {
    /** Stripe personalization design id (`ipcd_…`). */
    id: string;
    /** Friendly display name. */
    name: string;
    /** Lookup key used to retrieve this design dynamically. */
    lookupKey: string | undefined;
    /** Physical bundle id (`ics_…`). */
    physicalBundle: string;
    /** Card logo file id, if set. */
    cardLogo: string | undefined;
    /** Carrier-letter copy, if set. */
    carrierText: IssuingPersonalizationDesignCarrierText | undefined;
    /** Whether this design is the account default. */
    isDefault: boolean;
    /**
     * Whether this design is the Connect platform default. Null on
     * non-connected accounts.
     */
    isPlatformDefault: boolean | undefined;
    /** Whether this design can be used to create cards. */
    status: IssuingPersonalizationDesignStatus;
    /** Reasons the card logo was rejected, if any. */
    cardLogoRejectionReasons:
      | IssuingPersonalizationDesignCardLogoRejection[]
      | undefined;
    /** Reasons the carrier text was rejected, if any. */
    carrierTextRejectionReasons:
      | IssuingPersonalizationDesignCarrierTextRejection[]
      | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the design was created. */
    created: number;
    /** Whether the design exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Issuing Personalization Design — a physical bundle, optional
 * card logo, and optional carrier text that represent a card product
 * line. Name, lookup key, logo, carrier text, physical bundle,
 * preferences, and metadata update in place.
 *
 * Stripe has no delete, archive, or deactivate API for personalization
 * designs. Destroy is a no-op; the design remains as residue on the
 * account (still listed by `list()` via Alchemy metadata). Account-wide
 * nuke skips this type.
 *
 * Creating designs requires the Stripe Issuing entitlement.
 *
 * @see https://docs.stripe.com/api/issuing/personalization-designs
 *
 * ### Creating a Personalization Design
 * **Example:** Named design on a physical bundle
 * ```typescript
 * const design = yield* Stripe.IssuingPersonalizationDesign("metal-card", {
 *   physicalBundle: "ics_Fiiwz3T83opOUd",
 *   name: "Metal Card",
 * });
 * ```
 *
 * **Example:** Lookup key, carrier text, and metadata
 * ```typescript
 * const design = yield* Stripe.IssuingPersonalizationDesign("metal-card", {
 *   physicalBundle: "ics_Fiiwz3T83opOUd",
 *   name: "Metal Card",
 *   lookupKey: "metal_card_v1",
 *   carrierText: {
 *     headerTitle: "Welcome",
 *     headerBody: "Your card is on its way.",
 *   },
 *   metadata: { line: "metal" },
 * });
 * ```
 *
 * ### Updating a Personalization Design
 * **Example:** Rename and retag
 * ```typescript
 * const design = yield* Stripe.IssuingPersonalizationDesign("metal-card", {
 *   physicalBundle: "ics_Fiiwz3T83opOUd",
 *   name: "Metal Card v2",
 *   lookupKey: "metal_card_v1",
 *   metadata: { line: "metal", version: "2" },
 * });
 * ```
 *
 * ### Retrieving a Personalization Design
 * **Example:** Bind and retrieve
 * ```typescript
 * const retrieve = yield* Stripe.RetrieveIssuingPersonalizationDesign(design);
 * const live = yield* retrieve();
 * ```
 *
 * ### Destroying a Personalization Design
 * **Example:** Destroy is a no-op
 * ```typescript
 * // stack.destroy() leaves the Stripe object in place — there is no
 * // delete/archive API. Residue stays tagged with alchemy_stack.
 * const design = yield* Stripe.IssuingPersonalizationDesign("metal-card", {
 *   physicalBundle: "ics_Fiiwz3T83opOUd",
 *   name: "Metal Card",
 * });
 * ```
 *
 * @resource
 */
export const IssuingPersonalizationDesign =
  Resource<IssuingPersonalizationDesign>("Stripe.IssuingPersonalizationDesign");

type IssuingPersonalizationDesignAttributes =
  IssuingPersonalizationDesign["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: NAME_MAX_LENGTH }))
    );
  });

const toLookupKey = (
  id: string,
  lookupKey: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (lookupKey !== undefined && lookupKey.length > 0) return lookupKey;
    if (existing !== undefined && existing.length > 0) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: LOOKUP_KEY_MAX_LENGTH,
      lowercase: true,
    });
  });

const idOf = (
  value: string | { readonly id: string } | null | undefined,
): string | undefined => {
  if (value == null) return undefined;
  return typeof value === "string" ? value : value.id;
};

const compactCarrierText = (
  input:
    | {
        footerBody?: string | null;
        footerTitle?: string | null;
        headerBody?: string | null;
        headerTitle?: string | null;
      }
    | null
    | undefined,
): IssuingPersonalizationDesignCarrierText | undefined => {
  if (input == null) return undefined;
  const out: IssuingPersonalizationDesignCarrierText = {};
  if (input.footerBody) out.footerBody = input.footerBody;
  if (input.footerTitle) out.footerTitle = input.footerTitle;
  if (input.headerBody) out.headerBody = input.headerBody;
  if (input.headerTitle) out.headerTitle = input.headerTitle;
  return Object.keys(out).length > 0 ? out : undefined;
};

const fromObservedCarrierText = (
  value: StripeIssuingPersonalizationDesign["carrier_text"],
): IssuingPersonalizationDesignCarrierText | undefined =>
  compactCarrierText(
    value == null
      ? undefined
      : {
          footerBody: value.footer_body,
          footerTitle: value.footer_title,
          headerBody: value.header_body,
          headerTitle: value.header_title,
        },
  );

const toWireCarrierText = (
  input: IssuingPersonalizationDesignCarrierText,
): CreateIssuingPersonalizationDesignRequestCarrierText => ({
  ...(input.footerBody !== undefined ? { footer_body: input.footerBody } : {}),
  ...(input.footerTitle !== undefined
    ? { footer_title: input.footerTitle }
    : {}),
  ...(input.headerBody !== undefined ? { header_body: input.headerBody } : {}),
  ...(input.headerTitle !== undefined
    ? { header_title: input.headerTitle }
    : {}),
});

const toAttrs = (
  design: StripeIssuingPersonalizationDesign,
): IssuingPersonalizationDesignAttributes => ({
  id: design.id,
  name: design.name ?? "",
  lookupKey: design.lookup_key ?? undefined,
  physicalBundle: idOf(design.physical_bundle) ?? "",
  cardLogo: idOf(design.card_logo),
  carrierText: fromObservedCarrierText(design.carrier_text),
  isDefault: design.preferences.is_default,
  isPlatformDefault: design.preferences.is_platform_default ?? undefined,
  status: design.status,
  cardLogoRejectionReasons: design.rejection_reasons.card_logo ?? undefined,
  carrierTextRejectionReasons:
    design.rejection_reasons.carrier_text ?? undefined,
  metadata: userMetadata(design.metadata),
  created: design.created,
  livemode: design.livemode,
});

const isMissingDesign = isMissingStripeResource;

const getById = (personalizationDesign: string) =>
  GetIssuingPersonalizationDesign({
    personalization_design: personalizationDesign,
  }).pipe(Effect.catchIf(isMissingDesign, () => Effect.succeed(undefined)));

const findByLookupKey = Effect.fn(function* (lookupKey: string) {
  const response = yield* GetIssuingPersonalizationDesigns({
    lookup_keys: [lookupKey],
    limit: 1,
  });
  return response.data[0];
});

const listAllDesigns = Effect.fn(function* () {
  const designs: StripeIssuingPersonalizationDesign[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetIssuingPersonalizationDesigns({
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    designs.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return designs;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const designs = yield* listAllDesigns();
  const matches: StripeIssuingPersonalizationDesign[] = [];
  for (const design of designs) {
    if (yield* hasAlchemyMetadata(id, tagRecord(design.metadata))) {
      matches.push(design);
    }
  }
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const observe = Effect.fn(function* (input: {
  id?: string;
  logicalId: string;
  lookupKey?: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  if (input.lookupKey !== undefined) {
    const byKey = yield* findByLookupKey(input.lookupKey);
    if (
      byKey !== undefined &&
      (yield* hasAlchemyMetadata(input.logicalId, tagRecord(byKey.metadata)))
    ) {
      return byKey;
    }
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

export const IssuingPersonalizationDesignProvider = () =>
  Provider.succeed(IssuingPersonalizationDesign, {
    stables: ["id", "created", "livemode"],
    // Stripe has no delete/archive API; residue would reappear every nuke.
    nuke: { skip: true },

    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      const existing = yield* observe({
        id: output?.id,
        logicalId: id,
        lookupKey: output?.lookupKey,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const designs = yield* listAllDesigns();
      return designs
        .filter((design) => {
          const metadata = tagRecord(design.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const name = yield* toName(id, news.name, output?.name);
      const lookupKey = yield* toLookupKey(
        id,
        news.lookupKey,
        output?.lookupKey,
      );
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredCardLogo = news.cardLogo;
      const desiredCarrierText = compactCarrierText(news.carrierText);
      const desiredIsDefault = news.preferences?.isDefault ?? false;
      const desiredPhysicalBundle = news.physicalBundle;

      let current = yield* observe({
        id: output?.id,
        logicalId: id,
        lookupKey,
      });

      if (current === undefined) {
        current = yield* CreateIssuingPersonalizationDesign({
          physical_bundle: desiredPhysicalBundle,
          name,
          lookup_key: lookupKey,
          transfer_lookup_key: true,
          metadata,
          ...(desiredCardLogo !== undefined
            ? { card_logo: desiredCardLogo }
            : {}),
          ...(desiredCarrierText !== undefined
            ? { carrier_text: toWireCarrierText(desiredCarrierText) }
            : {}),
          ...(desiredIsDefault ? { preferences: { is_default: true } } : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-issuing-personalization-design-${instanceId}`,
          }),
        );
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const nameChanged = (current.name ?? "") !== name;
      const lookupKeyChanged = (current.lookup_key ?? "") !== lookupKey;
      const physicalBundleChanged =
        (idOf(current.physical_bundle) ?? "") !== desiredPhysicalBundle;
      const cardLogoChanged =
        (idOf(current.card_logo) ?? "") !== (desiredCardLogo ?? "");
      const carrierTextChanged = !deepEqual(
        fromObservedCarrierText(current.carrier_text),
        desiredCarrierText,
        { stripNullish: true },
      );
      const preferencesChanged =
        current.preferences.is_default !== desiredIsDefault;

      if (
        !nameChanged &&
        !lookupKeyChanged &&
        !physicalBundleChanged &&
        !cardLogoChanged &&
        !carrierTextChanged &&
        !preferencesChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdateIssuingPersonalizationDesign({
        personalization_design: current.id,
        ...(nameChanged ? { name } : {}),
        ...(lookupKeyChanged
          ? { lookup_key: lookupKey, transfer_lookup_key: true }
          : {}),
        ...(physicalBundleChanged
          ? { physical_bundle: desiredPhysicalBundle }
          : {}),
        ...(cardLogoChanged
          ? {
              card_logo: desiredCardLogo !== undefined ? desiredCardLogo : "",
            }
          : {}),
        ...(carrierTextChanged
          ? {
              carrier_text:
                desiredCarrierText !== undefined
                  ? toWireCarrierText(desiredCarrierText)
                  : "",
            }
          : {}),
        ...(preferencesChanged
          ? { preferences: { is_default: desiredIsDefault } }
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

    delete: Effect.fn(function* (_input) {
      // Stripe has no delete, archive, or deactivate API for Issuing
      // Personalization Designs. Destroy is a no-op; the object remains
      // as residue on the account.
      yield* Effect.void;
    }),
  });
