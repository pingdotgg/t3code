import * as cloudchannel from "@distilled.cloud/gcp/cloudchannel_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  accountOf,
  defaultInvoiceMonth,
  desiredRepricingConfig,
  findChannelPartnerRepricing,
  jsonEqual,
  normalizeDate,
  replaceOnIdentity,
  toChannelPartnerLinkName,
  toChannelPartnerRepricingAttrs,
  toRepricingConfigName,
} from "./internal.ts";

export type ChannelPartnerLinksChannelPartnerRepricingConfigProps = {
  /**
   * Channel partner link that receives this repricing config. Full name
   * `accounts/{account}/channelPartnerLinks/{channelPartner}` or the
   * partner id (combined with `account`). Immutable — changing it
   * replaces the config.
   */
  parent: string;
  /**
   * Reseller account used when `parent` is a bare partner id.
   */
  account?: string;
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

export type ChannelPartnerLinksChannelPartnerRepricingConfig = Resource<
  "GCP.CloudChannel.ChannelPartnerLinksChannelPartnerRepricingConfig",
  ChannelPartnerLinksChannelPartnerRepricingConfigProps,
  {
    /** Resource name `accounts/{account}/channelPartnerLinks/{channelPartner}/channelPartnerRepricingConfigs/{id}`. */
    name: string;
    /** Config id (last path segment). */
    configId: string;
    /** Parent channel partner link. */
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
 * A Cloud Channel channel-partner repricing config.
 *
 * Repricing configs have no labels field. `list` / nuke returns configs
 * under channel partner links of the configured Cloud Channel account
 * (`GOOGLE_CLOUDCHANNEL_ACCOUNT`). Parent partner link and effective
 * invoice month are identity — changing either replaces the config.
 * Adjustment, rebilling basis, entitlement, and overrides update in
 * place for a future month.
 *
 * Creating configs requires Cloud Channel distributor access.
 *
 * ### Creating a Channel Partner Repricing Config
 * **Example:** Pass-through for a future month
 * ```typescript
 * const config =
 *   yield* GCP.CloudChannel.ChannelPartnerLinksChannelPartnerRepricingConfig(
 *     "PartnerBill",
 *     {
 *       parent: "accounts/C012345/channelPartnerLinks/C987654",
 *       effectiveInvoiceMonth: { year: 2099, month: 1, day: 0 },
 *       entitlement:
 *         "accounts/C012345/customers/cust-1/entitlements/ent-1",
 *     },
 *   );
 * ```
 *
 * @resource
 * @category CloudChannel
 */
export const ChannelPartnerLinksChannelPartnerRepricingConfig =
  Resource<ChannelPartnerLinksChannelPartnerRepricingConfig>(
    "GCP.CloudChannel.ChannelPartnerLinksChannelPartnerRepricingConfig",
  );

export class ChannelPartnerLinksChannelPartnerRepricingConfigNotResolved extends Data.TaggedError(
  "GCP.CloudChannel.ChannelPartnerLinksChannelPartnerRepricingConfigNotResolved",
)<{
  name: string;
}> {}

const resolveParent = (newsParent: string, account?: string) =>
  toChannelPartnerLinkName(newsParent, account ?? accountOf(newsParent));

const monthOf = (
  news: ChannelPartnerLinksChannelPartnerRepricingConfigProps,
  outputMonth?: cloudchannel.GoogleTypeDate,
) =>
  Effect.gen(function* () {
    return (
      normalizeDate(news.effectiveInvoiceMonth) ??
      normalizeDate(outputMonth) ??
      (yield* defaultInvoiceMonth())
    );
  });

export const ChannelPartnerLinksChannelPartnerRepricingConfigProvider = () =>
  Provider.succeed(ChannelPartnerLinksChannelPartnerRepricingConfig, {
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
        nextParent: resolveParent(news.parent, news.account),
        extra:
          previousMonth !== undefined &&
          nextMonth !== undefined &&
          !jsonEqual(previousMonth, nextMonth),
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const parent = resolveParent(
        olds?.parent ?? output?.parent ?? "",
        olds?.account ?? accountOf(output?.parent ?? ""),
      );
      const name = toRepricingConfigName(
        parent,
        olds?.configId ?? output?.configId ?? output?.name,
        "channelPartnerRepricingConfigs",
      );
      const existing = yield* findChannelPartnerRepricing(
        parent,
        output?.name ?? name,
        olds?.effectiveInvoiceMonth ??
          output?.repricingConfig?.effectiveInvoiceMonth,
      );
      if (existing === undefined) return undefined;
      const attrs = toChannelPartnerRepricingAttrs(existing);
      return output?.name !== undefined || olds?.configId !== undefined
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const parent = resolveParent(
        news.parent,
        news.account ?? accountOf(output?.parent ?? news.parent),
      );
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
        "channelPartnerRepricingConfigs",
      );

      let current = yield* findChannelPartnerRepricing(
        parent,
        output?.name ?? name,
        month,
      );

      if (current === undefined) {
        const created = yield* cloudchannel
          .createAccountsChannelPartnerLinksChannelPartnerRepricingConfigs({
            parent,
            body: { repricingConfig },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findChannelPartnerRepricing(parent, name, month),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ChannelPartnerLinksChannelPartnerRepricingConfigNotResolved(
          {
            name: name || `${parent}/channelPartnerRepricingConfigs`,
          },
        );
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
          yield* cloudchannel.patchAccountsChannelPartnerLinksChannelPartnerRepricingConfigs(
            {
              name: currentName,
              body: { name: currentName, repricingConfig },
            },
          );
      }

      return toChannelPartnerRepricingAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (name.length === 0) return;
      yield* cloudchannel
        .deleteAccountsChannelPartnerLinksChannelPartnerRepricingConfigs({
          name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
