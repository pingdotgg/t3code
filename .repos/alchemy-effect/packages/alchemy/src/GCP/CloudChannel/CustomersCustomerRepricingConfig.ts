import * as cloudchannel from "@distilled.cloud/gcp/cloudchannel_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  defaultInvoiceMonth,
  desiredRepricingConfig,
  findCustomerRepricing,
  jsonEqual,
  normalizeDate,
  normalizeName,
  replaceOnIdentity,
  toCustomerRepricingAttrs,
  toRepricingConfigName,
} from "./internal.ts";

export type CustomersCustomerRepricingConfigProps = {
  /**
   * Customer that receives this repricing config. Full name
   * `accounts/{account}/customers/{customer}`. Immutable — changing it
   * replaces the config.
   */
  parent: string;
  /**
   * Config id (last segment of the resource name). Server-assigned on
   * create. Immutable — changing it replaces the config.
   */
  configId?: string;
  /**
   * Year/month when the adjustment activates. Day must be `0`. You can
   * only create or update configs for a future month. Immutable —
   * changing it replaces the config.
   */
  effectiveInvoiceMonth?: cloudchannel.GoogleTypeDate;
  /**
   * Rebilling basis used for the bill.
   * @default "COST_AT_LIST"
   */
  rebillingBasis?:
    | cloudchannel.GoogleCloudChannelV1RepricingConfigRebillingBasisEnum
    | (string & {});
  /**
   * Markup or markdown percentage (`"1.00"` is +1%, `"-1.00"` is -1%,
   * `"0.00"` is pass-through). Ignored when `adjustment` is set.
   * @default "0.00"
   */
  adjustmentPercentage?: string;
  /**
   * Full adjustment. Defaults to a percentage adjustment of
   * `adjustmentPercentage`.
   */
  adjustment?: cloudchannel.GoogleCloudChannelV1RepricingAdjustment;
  /**
   * Entitlement this config applies to
   * (`accounts/{account}/customers/{customer}/entitlements/{entitlement}`).
   */
  entitlement?: string;
  /**
   * Entitlement granularity. Takes precedence over `entitlement`.
   */
  entitlementGranularity?: cloudchannel.GoogleCloudChannelV1RepricingConfigEntitlementGranularity;
  /**
   * Conditional overrides applied before the default adjustment.
   */
  conditionalOverrides?: cloudchannel.GoogleCloudChannelV1ConditionalOverrideList;
};

export type CustomersCustomerRepricingConfig = Resource<
  "GCP.CloudChannel.CustomersCustomerRepricingConfig",
  CustomersCustomerRepricingConfigProps,
  {
    /** Resource name `accounts/{account}/customers/{customer}/customerRepricingConfigs/{id}`. */
    name: string;
    /** Config id (last path segment). */
    configId: string;
    /** Parent customer resource name. */
    parent: string;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Repricing configuration. */
    repricingConfig:
      | cloudchannel.GoogleCloudChannelV1RepricingConfig
      | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Channel customer repricing config.
 *
 * Repricing configs have no labels field: `read` reports a config it
 * finds without prior state as unowned (adopt it with `--adopt`). Parent
 * customer and effective invoice month are identity — changing either
 * replaces the config. Adjustment, rebilling basis, entitlement, and
 * overrides update in place for a future month.
 *
 * Creating configs requires Cloud Channel reseller access and a
 * provisioned entitlement.
 *
 * ### Creating a Customer Repricing Config
 * **Example:** Pass-through for a future month
 * ```typescript
 * const config = yield* GCP.CloudChannel.CustomersCustomerRepricingConfig(
 *   "AcmeBill",
 *   {
 *     parent: customer.name,
 *     effectiveInvoiceMonth: { year: 2099, month: 1, day: 0 },
 *     entitlement: `${customer.name}/entitlements/ent-1`,
 *   },
 * );
 * ```
 *
 * **Example:** One percent markup
 * ```typescript
 * const config = yield* GCP.CloudChannel.CustomersCustomerRepricingConfig(
 *   "AcmeBill",
 *   {
 *     parent: customer.name,
 *     effectiveInvoiceMonth: { year: 2099, month: 1, day: 0 },
 *     adjustmentPercentage: "1.00",
 *     entitlement: `${customer.name}/entitlements/ent-1`,
 *   },
 * );
 * ```
 *
 * @resource
 * @category CloudChannel
 */
export const CustomersCustomerRepricingConfig =
  Resource<CustomersCustomerRepricingConfig>(
    "GCP.CloudChannel.CustomersCustomerRepricingConfig",
  );

export class CustomersCustomerRepricingConfigNotResolved extends Data.TaggedError(
  "GCP.CloudChannel.CustomersCustomerRepricingConfigNotResolved",
)<{
  name: string;
}> {}

const monthOf = (
  news: CustomersCustomerRepricingConfigProps,
  outputMonth?: cloudchannel.GoogleTypeDate,
) =>
  Effect.gen(function* () {
    return (
      normalizeDate(news.effectiveInvoiceMonth) ??
      normalizeDate(outputMonth) ??
      (yield* defaultInvoiceMonth())
    );
  });

export const CustomersCustomerRepricingConfigProvider = () =>
  Provider.succeed(CustomersCustomerRepricingConfig, {
    stables: ["name", "configId", "parent"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMonth = normalizeDate(
        olds?.effectiveInvoiceMonth ??
          output?.repricingConfig?.effectiveInvoiceMonth,
      );
      const nextMonth = normalizeDate(news.effectiveInvoiceMonth);
      return replaceOnIdentity({
        previousId: olds?.configId ?? output?.configId,
        nextId: news.configId,
        previousParent: olds?.parent ?? output?.parent,
        nextParent: news.parent,
        extra:
          previousMonth !== undefined &&
          nextMonth !== undefined &&
          !jsonEqual(previousMonth, nextMonth),
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const parent = normalizeName(olds?.parent ?? output?.parent ?? "");
      const name = toRepricingConfigName(
        parent,
        olds?.configId ?? output?.configId ?? output?.name,
        "customerRepricingConfigs",
      );
      const existing = yield* findCustomerRepricing(
        parent,
        output?.name ?? name,
        olds?.effectiveInvoiceMonth ??
          output?.repricingConfig?.effectiveInvoiceMonth,
      );
      if (existing === undefined) return undefined;
      const attrs = toCustomerRepricingAttrs(existing);
      // No labels field: without prior state the config may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const parent = normalizeName(news.parent);
      const month = yield* monthOf(
        news,
        output?.repricingConfig?.effectiveInvoiceMonth,
      );
      const repricingConfig = desiredRepricingConfig({
        effectiveInvoiceMonth: month,
        rebillingBasis: news.rebillingBasis,
        adjustmentPercentage: news.adjustmentPercentage,
        adjustment: news.adjustment,
        entitlementGranularity:
          news.entitlementGranularity ??
          (news.entitlement
            ? { entitlement: news.entitlement }
            : output?.repricingConfig?.entitlementGranularity),
        conditionalOverrides: news.conditionalOverrides,
      });
      const name = toRepricingConfigName(
        parent,
        news.configId ?? output?.configId ?? output?.name,
        "customerRepricingConfigs",
      );

      let current = yield* findCustomerRepricing(
        parent,
        output?.name ?? name,
        month,
      );

      if (current === undefined) {
        const created = yield* cloudchannel
          .createAccountsCustomersCustomerRepricingConfigs({
            parent,
            body: { repricingConfig },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findCustomerRepricing(parent, name, month),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomersCustomerRepricingConfigNotResolved({
          name: name || `${parent}/customerRepricingConfigs`,
        });
      }

      const currentName = current.name ?? name;
      const observed = current.repricingConfig;
      const changed =
        !jsonEqual(
          normalizeDate(observed?.effectiveInvoiceMonth),
          normalizeDate(repricingConfig.effectiveInvoiceMonth),
        ) ||
        (observed?.rebillingBasis ?? "") !==
          (repricingConfig.rebillingBasis ?? "") ||
        !jsonEqual(observed?.adjustment, repricingConfig.adjustment) ||
        !jsonEqual(
          observed?.entitlementGranularity,
          repricingConfig.entitlementGranularity,
        ) ||
        !jsonEqual(
          observed?.conditionalOverrides,
          repricingConfig.conditionalOverrides,
        );

      if (changed && currentName.length > 0) {
        current =
          yield* cloudchannel.patchAccountsCustomersCustomerRepricingConfigs({
            name: currentName,
            body: { name: currentName, repricingConfig },
          });
      }

      return toCustomerRepricingAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (name.length === 0) return;
      yield* cloudchannel
        .deleteAccountsCustomersCustomerRepricingConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
