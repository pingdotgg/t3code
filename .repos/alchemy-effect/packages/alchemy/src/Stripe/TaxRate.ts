import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetTaxRates,
  GetTaxRate,
  CreateTaxRate,
  UpdateTaxRate,
  type TaxRate as StripeTaxRate,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
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

const DISPLAY_NAME_MAX_LENGTH = 250;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/** High-level Stripe tax type, such as `vat` or `sales_tax`. */
export type TaxRateTaxType =
  | "amusement_tax"
  | "communications_tax"
  | "gst"
  | "hst"
  | "igst"
  | "jct"
  | "lease_tax"
  | "pst"
  | "qst"
  | "retail_delivery_fee"
  | "rst"
  | "sales_tax"
  | "service_tax"
  | "vat";

export interface TaxRateProps {
  /**
   * Display name shown to customers on receipts, invoice PDFs, and the
   * hosted invoice page. If omitted, a unique name is generated from the
   * stack, stage, and logical id. Mutable.
   */
  displayName?: string;
  /**
   * Tax rate percent out of 100. Create-only — changing it replaces the
   * tax rate.
   */
  percentage: number;
  /**
   * Whether this tax is inclusive of the listed price. Create-only —
   * changing it replaces the tax rate.
   */
  inclusive: boolean;
  /**
   * Whether the tax rate can be applied to new invoices, subscriptions,
   * and Checkout Sessions. Inactive rates remain on objects that already
   * use them.
   * @default true
   */
  active?: boolean;
  /**
   * Internal description. Not shown to customers.
   */
  description?: string;
  /**
   * Two-letter ISO 3166-1 alpha-2 country code.
   */
  country?: string;
  /**
   * Jurisdiction label for tax reporting; also appears on customer
   * invoices.
   */
  jurisdiction?: string;
  /**
   * ISO 3166-2 subdivision code without the country prefix (e.g. `"NY"`).
   */
  state?: string;
  /**
   * High-level tax type, such as `vat` or `sales_tax`.
   */
  taxType?: TaxRateTaxType;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`. Mutable.
   */
  metadata?: Record<string, string>;
}

export type TaxRate = Resource<
  "Stripe.TaxRate",
  TaxRateProps,
  {
    /** Stripe tax rate id (`txr_…`). */
    id: string;
    /** Display name shown to customers. */
    displayName: string;
    /** Tax rate percent out of 100. */
    percentage: number;
    /** Whether this tax is inclusive of the listed price. */
    inclusive: boolean;
    /** Whether the tax rate can be applied to new objects. */
    active: boolean;
    /** Internal description, if set. */
    description: string | undefined;
    /** Two-letter ISO country code, if set. */
    country: string | undefined;
    /** Jurisdiction label, if set. */
    jurisdiction: string | undefined;
    /** ISO 3166-2 subdivision code, if set. */
    state: string | undefined;
    /** High-level tax type, if set. */
    taxType: TaxRateTaxType | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the tax rate was created. */
    created: number;
    /** Whether the tax rate exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Tax Rate — a percent tax applied to invoices, subscriptions,
 * and Checkout Sessions. `percentage` and `inclusive` are immutable and
 * changing them replaces the tax rate. Display name, active, description,
 * jurisdiction fields, and metadata update in place.
 *
 * Stripe does not hard-delete tax rates; destroying this resource
 * deactivates it (`active: false`).
 *
 * @see https://docs.stripe.com/api/tax_rates
 *
 * ### Creating a Tax Rate
 * **Example:** Exclusive sales tax
 * ```typescript
 * const vat = yield* Stripe.TaxRate("vat", {
 *   displayName: "VAT",
 *   percentage: 20,
 *   inclusive: false,
 * });
 * ```
 *
 * **Example:** Inclusive tax with metadata
 * ```typescript
 * const gst = yield* Stripe.TaxRate("gst", {
 *   displayName: "GST",
 *   percentage: 10,
 *   inclusive: true,
 *   taxType: "gst",
 *   metadata: { region: "au" },
 * });
 * ```
 *
 * ### Updating a Tax Rate
 * **Example:** Rename and pause
 * ```typescript
 * const vat = yield* Stripe.TaxRate("vat", {
 *   displayName: "VAT (paused)",
 *   percentage: 20,
 *   inclusive: false,
 *   active: false,
 *   metadata: { region: "eu" },
 * });
 * ```
 *
 * ### Deactivating a Tax Rate
 * **Example:** Destroy deactivates rather than deleting
 * ```typescript
 * // stack.destroy() / resource removal sets active: false
 * const vat = yield* Stripe.TaxRate("vat", {
 *   displayName: "VAT",
 *   percentage: 20,
 *   inclusive: false,
 * });
 * ```
 *
 * @resource
 */
export const TaxRate = Resource<TaxRate>("Stripe.TaxRate");

export class TaxRateNotResolved extends Data.TaggedError(
  "Stripe.TaxRateNotResolved",
)<{
  displayName: string;
}> {}

type TaxRateAttributes = TaxRate["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const toDisplayName = (
  id: string,
  displayName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      displayName ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: DISPLAY_NAME_MAX_LENGTH }))
    );
  });

const toAttrs = (rate: StripeTaxRate): TaxRateAttributes => ({
  id: rate.id,
  displayName: rate.display_name,
  percentage: rate.percentage,
  inclusive: rate.inclusive,
  active: rate.active,
  description: rate.description ?? undefined,
  country: rate.country ?? undefined,
  jurisdiction: rate.jurisdiction ?? undefined,
  state: rate.state ?? undefined,
  taxType: (rate.tax_type ?? undefined) as TaxRateTaxType | undefined,
  metadata: userMetadata(rate.metadata),
  created: rate.created,
  livemode: rate.livemode,
});

const isMissingTaxRate = isMissingStripeResource;

const getById = (taxRate: string) =>
  GetTaxRate({ tax_rate: taxRate }).pipe(
    Effect.catchIf(isMissingTaxRate, () => Effect.succeed(undefined)),
  );

const listByActive = Effect.fn(function* (active: boolean) {
  const rates: StripeTaxRate[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetTaxRates({
      active,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    rates.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return rates;
});

const listAllTaxRates = Effect.fn(function* () {
  const [active, inactive] = yield* Effect.all(
    [listByActive(true), listByActive(false)],
    { concurrency: 2 },
  );
  const seen = new Set<string>();
  const rates: StripeTaxRate[] = [];
  for (const rate of [...active, ...inactive]) {
    if (seen.has(rate.id)) continue;
    seen.add(rate.id);
    rates.push(rate);
  }
  return rates;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const rates = yield* listAllTaxRates();
  const matches: StripeTaxRate[] = [];
  for (const rate of rates) {
    if (yield* hasAlchemyMetadata(id, tagRecord(rate.metadata))) {
      matches.push(rate);
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
  news: TaxRateProps,
  output: TaxRateAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.percentage !== output.percentage) return true;
  if (news.inclusive !== output.inclusive) return true;
  return false;
};

export const TaxRateProvider = () =>
  Provider.succeed(TaxRate, {
    stables: ["id", "percentage", "inclusive", "created", "livemode"],

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
      // Default list API is active tax rates; inactive (deactivated) rows
      // stay in Stripe but must not re-enter nuke. Filter to alchemy_stack
      // so account-wide teardown only touches our rows.
      const rates = yield* listByActive(true);
      return rates
        .filter((rate) => {
          const metadata = tagRecord(rate.metadata);
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
      const desiredActive = news.active ?? true;

      let current: StripeTaxRate | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateTaxRate({
          display_name: displayName,
          percentage: news.percentage,
          inclusive: news.inclusive,
          active: desiredActive,
          metadata,
          ...(news.description !== undefined
            ? { description: news.description }
            : {}),
          ...(news.country !== undefined ? { country: news.country } : {}),
          ...(news.jurisdiction !== undefined
            ? { jurisdiction: news.jurisdiction }
            : {}),
          ...(news.state !== undefined ? { state: news.state } : {}),
          ...(news.taxType !== undefined ? { tax_type: news.taxType } : {}),
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-tax-rate-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new TaxRateNotResolved({ displayName });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = current.display_name !== displayName;
      const activeChanged = current.active !== desiredActive;
      const descriptionChanged =
        news.description !== undefined &&
        (current.description ?? undefined) !== news.description;
      const countryChanged =
        news.country !== undefined &&
        (current.country ?? undefined) !== news.country;
      const jurisdictionChanged =
        news.jurisdiction !== undefined &&
        (current.jurisdiction ?? undefined) !== news.jurisdiction;
      const stateChanged =
        news.state !== undefined && (current.state ?? undefined) !== news.state;
      const taxTypeChanged =
        news.taxType !== undefined &&
        (current.tax_type ?? undefined) !== news.taxType;

      if (
        !displayNameChanged &&
        !activeChanged &&
        !descriptionChanged &&
        !countryChanged &&
        !jurisdictionChanged &&
        !stateChanged &&
        !taxTypeChanged &&
        !metadataChanged
      ) {
        return toAttrs(current);
      }

      const updated = yield* UpdateTaxRate({
        tax_rate: current.id,
        ...(displayNameChanged ? { display_name: displayName } : {}),
        ...(activeChanged ? { active: desiredActive } : {}),
        ...(descriptionChanged ? { description: news.description } : {}),
        ...(countryChanged ? { country: news.country } : {}),
        ...(jurisdictionChanged ? { jurisdiction: news.jurisdiction } : {}),
        ...(stateChanged ? { state: news.state } : {}),
        ...(taxTypeChanged ? { tax_type: news.taxType } : {}),
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
      yield* UpdateTaxRate({
        tax_rate: existing.id,
        active: false,
      }).pipe(Effect.catchIf(isMissingTaxRate, () => Effect.void));
    }),
  });
