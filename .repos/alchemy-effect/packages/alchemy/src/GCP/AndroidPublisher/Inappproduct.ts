import * as androidpublisher from "@distilled.cloud/gcp/androidpublisher_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LANGUAGE,
  defaultInappListings,
  defaultInappPrice,
  getInappproduct,
  jsonEqual,
  sameText,
  toDisplayName,
  toSku,
} from "./internal.ts";

export type InappproductProps = {
  /**
   * Play package name of the parent app (for example `com.example.app`).
   * Immutable — changing it replaces the in-app product.
   */
  packageName: string;
  /**
   * SKU unique within the app. If omitted, a unique SKU is generated.
   * Immutable — changing it replaces the product.
   */
  sku?: string;
  /**
   * Default listing language (BCP-47, for example `en-US`).
   * @default "en-US"
   */
  defaultLanguage?: string;
  /**
   * Localized titles and descriptions, keyed by language. A default-language
   * listing titled after the SKU is added when missing.
   */
  listings?: androidpublisher.InAppProductListingMap;
  /**
   * Default price in the developer's Checkout currency. Cannot be zero.
   * @default { currency: "USD", priceMicros: "990000" }
   */
  defaultPrice?: androidpublisher.Price;
  /**
   * Prices per buyer region.
   */
  prices?: androidpublisher.PriceMap;
  /**
   * Product status (`active` or `inactive`).
   */
  status?: androidpublisher.InAppProductStatusEnum | (string & {});
  /**
   * Purchase type. Use `managedUser` for one-time products. Subscriptions
   * should use `MonetizationSubscription` instead.
   * @default "managedUser"
   */
  purchaseType?: androidpublisher.InAppProductPurchaseTypeEnum | (string & {});
  /**
   * Subscription period (ISO 8601). Only for legacy subscription SKUs.
   */
  subscriptionPeriod?: string;
  /**
   * Trial period (ISO 8601, `P7D` to `P999D`).
   */
  trialPeriod?: string;
  /**
   * Grace period (ISO 8601) for declined subscription recurrences.
   */
  gracePeriod?: string;
  /**
   * Tax and compliance settings for managed products.
   */
  managedProductTaxesAndComplianceSettings?: androidpublisher.ManagedProductTaxAndComplianceSettings;
  /**
   * Tax and compliance settings for legacy subscription SKUs.
   */
  subscriptionTaxesAndComplianceSettings?: androidpublisher.SubscriptionTaxAndComplianceSettings;
  /**
   * Auto-convert missing regional prices from the default price.
   * @default true
   */
  autoConvertMissingPrices?: boolean;
  /**
   * Propagation latency tolerance for product updates.
   */
  latencyTolerance?:
    | androidpublisher.PatchInappproductsLatencyToleranceEnum
    | (string & {});
};

export type Inappproduct = Resource<
  "GCP.AndroidPublisher.Inappproduct",
  InappproductProps,
  {
    /** Play package name. */
    packageName: string;
    /** SKU. */
    sku: string;
    /** Project id used when the product was reconciled. */
    project: string;
    /** Default listing language. */
    defaultLanguage: string | undefined;
    /** Localized listings. */
    listings: androidpublisher.InAppProductListingMap | undefined;
    /** Default price. */
    defaultPrice: androidpublisher.Price | undefined;
    /** Regional prices. */
    prices: androidpublisher.PriceMap | undefined;
    /** Product status. */
    status: string | undefined;
    /** Purchase type. */
    purchaseType: string | undefined;
    /** Subscription period, if any. */
    subscriptionPeriod: string | undefined;
    /** Trial period, if any. */
    trialPeriod: string | undefined;
    /** Grace period, if any. */
    gracePeriod: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Play in-app product (`inappproducts`).
 *
 * In-app products have no labels field, so ownership rests on the
 * deterministic SKU: `read` reports a product it finds without prior state
 * as unowned (adopt it with `--adopt`). `packageName` and `sku` are identity — changing either replaces the
 * product. Listings, prices, and status update in place. Prefer
 * `MonetizationSubscription` for subscriptions; this resource is for
 * managed one-time products.
 *
 * ### Creating an In-app Product
 * **Example:** Generated SKU
 * ```typescript
 * const gem = yield* GCP.AndroidPublisher.Inappproduct("GemPack", {
 *   packageName: "com.example.app",
 *   listings: { "en-US": { title: "Gem pack" } },
 * });
 * ```
 *
 * **Example:** Explicit SKU and price
 * ```typescript
 * const gem = yield* GCP.AndroidPublisher.Inappproduct("GemPack", {
 *   packageName: "com.example.app",
 *   sku: "gem_pack_small",
 *   defaultPrice: { currency: "USD", priceMicros: "1990000" },
 *   listings: { "en-US": { title: "Small gem pack" } },
 * });
 * ```
 *
 * ### Updating an In-app Product
 * **Example:** Change the title
 * ```typescript
 * // Same logical id as before; only the listing changes.
 * const gem = yield* GCP.AndroidPublisher.Inappproduct("GemPack", {
 *   packageName: "com.example.app",
 *   listings: { "en-US": { title: "Starter gem pack" } },
 * });
 * ```
 *
 * @resource
 * @category AndroidPublisher
 */
export const Inappproduct = Resource<Inappproduct>(
  "GCP.AndroidPublisher.Inappproduct",
);

export class InappproductNotResolved extends Data.TaggedError(
  "GCP.AndroidPublisher.InappproductNotResolved",
)<{
  packageName: string;
  sku: string;
}> {}

const toAttrs = (product: androidpublisher.InAppProduct, project: string) => ({
  packageName: product.packageName ?? "",
  sku: product.sku ?? "",
  project,
  defaultLanguage: product.defaultLanguage,
  listings: product.listings,
  defaultPrice: product.defaultPrice,
  prices: product.prices,
  status: product.status,
  purchaseType: product.purchaseType,
  subscriptionPeriod: product.subscriptionPeriod,
  trialPeriod: product.trialPeriod,
  gracePeriod: product.gracePeriod,
});

const desiredBody = (input: {
  packageName: string;
  sku: string;
  defaultLanguage: string;
  listings: androidpublisher.InAppProductListingMap;
  news: InappproductProps;
}): androidpublisher.InAppProduct => ({
  packageName: input.packageName,
  sku: input.sku,
  defaultLanguage: input.defaultLanguage,
  listings: input.listings,
  defaultPrice: input.news.defaultPrice ?? defaultInappPrice(),
  prices: input.news.prices,
  status: input.news.status,
  purchaseType: input.news.purchaseType ?? "managedUser",
  subscriptionPeriod: input.news.subscriptionPeriod,
  trialPeriod: input.news.trialPeriod,
  gracePeriod: input.news.gracePeriod,
  managedProductTaxesAndComplianceSettings:
    input.news.managedProductTaxesAndComplianceSettings,
  subscriptionTaxesAndComplianceSettings:
    input.news.subscriptionTaxesAndComplianceSettings,
});

const needsSync = (
  current: androidpublisher.InAppProduct,
  desired: androidpublisher.InAppProduct,
) =>
  !sameText(current.defaultLanguage, desired.defaultLanguage) ||
  !jsonEqual(current.listings, desired.listings) ||
  !jsonEqual(current.defaultPrice, desired.defaultPrice) ||
  (desired.prices !== undefined &&
    !jsonEqual(current.prices, desired.prices)) ||
  (desired.status !== undefined && !sameText(current.status, desired.status)) ||
  (desired.purchaseType !== undefined &&
    !sameText(current.purchaseType, desired.purchaseType)) ||
  !sameText(current.subscriptionPeriod, desired.subscriptionPeriod) ||
  !sameText(current.trialPeriod, desired.trialPeriod) ||
  !sameText(current.gracePeriod, desired.gracePeriod) ||
  (desired.managedProductTaxesAndComplianceSettings !== undefined &&
    !jsonEqual(
      current.managedProductTaxesAndComplianceSettings,
      desired.managedProductTaxesAndComplianceSettings,
    )) ||
  (desired.subscriptionTaxesAndComplianceSettings !== undefined &&
    !jsonEqual(
      current.subscriptionTaxesAndComplianceSettings,
      desired.subscriptionTaxesAndComplianceSettings,
    ));

export const InappproductProvider = () =>
  Provider.succeed(Inappproduct, {
    stables: ["packageName", "sku", "project", "purchaseType"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPackage = olds?.packageName ?? output?.packageName;
      if (
        previousPackage !== undefined &&
        news.packageName !== previousPackage
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousSku = olds?.sku ?? output?.sku;
      if (
        previousSku !== undefined &&
        news.sku !== undefined &&
        news.sku !== previousSku
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const packageName = olds?.packageName ?? output?.packageName ?? "";
      const sku = yield* toSku(id, olds?.sku, output?.sku);
      const existing = yield* getInappproduct(packageName, sku);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state the product may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const packageName = news.packageName;
      const sku = yield* toSku(id, news.sku, output?.sku);
      const defaultLanguage =
        news.defaultLanguage ?? output?.defaultLanguage ?? DEFAULT_LANGUAGE;
      const title = yield* toDisplayName(
        id,
        news.listings?.[defaultLanguage]?.title,
        output?.listings?.[defaultLanguage]?.title,
      );
      const listings = defaultInappListings(
        news.listings,
        title,
        defaultLanguage,
      );
      const autoConvertMissingPrices = news.autoConvertMissingPrices ?? true;
      const desired = desiredBody({
        packageName,
        sku,
        defaultLanguage,
        listings,
        news,
      });

      let current = yield* getInappproduct(packageName, sku);

      if (current === undefined) {
        const created = yield* androidpublisher
          .insertInappproducts({
            packageName,
            autoConvertMissingPrices,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getInappproduct(packageName, sku),
            ),
          );
        current = created ?? undefined;
      } else if (needsSync(current, desired)) {
        current = yield* androidpublisher.patchInappproducts({
          packageName,
          sku: current.sku ?? sku,
          autoConvertMissingPrices,
          latencyTolerance: news.latencyTolerance,
          body: desired,
        });
      }

      if (current === undefined) {
        return yield* new InappproductNotResolved({ packageName, sku });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.packageName || !output.sku) return;
      yield* androidpublisher
        .deleteInappproducts({
          packageName: output.packageName,
          sku: output.sku,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
