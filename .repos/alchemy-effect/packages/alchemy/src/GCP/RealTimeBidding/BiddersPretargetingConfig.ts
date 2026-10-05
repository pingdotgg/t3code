import * as rtb from "@distilled.cloud/gcp/realtimebidding_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  configIdOf,
  encodeDisplayName,
  expandParent,
  findOwnedConfig,
  getConfig,
  hasOwnershipMarker,
  ignoreMissing,
  listOwnedConfigs,
  mergeSpec,
  ownedByAlchemy,
  ownershipLabels,
  parentOfName,
  parseDisplayName,
  replaceOnIdentity,
  resourceName,
  specFromRow,
  specOf,
  toConfigBody,
  toDisplayName,
  updateMaskOf,
  type AppTargetingValue,
  type CreativeDimensionsValue,
  type NumericTargetingDimensionValue,
  type PretargetingState,
  type StringTargetingDimensionValue,
} from "./internal.ts";

export type StringTargetingDimension = StringTargetingDimensionValue;
export type NumericTargetingDimension = NumericTargetingDimensionValue;
export type CreativeDimensions = CreativeDimensionsValue;
export type AppTargeting = AppTargetingValue;

export type BiddersPretargetingConfigProps = {
  /**
   * Parent bidder, as `bidders/{bidder}` or the bidder account id.
   * Immutable — changing it replaces the config.
   */
  parent: string;
  /**
   * Server-assigned config id (last path segment). Omit on create; pass
   * the observed id to keep the same config. Immutable — changing it
   * replaces the config.
   */
  configId?: string;
  /**
   * Human-readable display name. Must be unique among the bidder's
   * pretargeting configs. If omitted, a unique name is generated from
   * the stack, stage, and logical id. Pretargeting configs have no
   * labels field, so Alchemy stamps ownership into a `[alchemy …]`
   * prefix and strips it from attributes.
   */
  displayName?: string;
  /**
   * Desired serving state after create (`ACTIVE` or `SUSPENDED`).
   * Create always yields `ACTIVE`. `SUSPENDED` is applied with
   * `pretargetingConfigs.suspend`.
   */
  state?: PretargetingState;
  /**
   * Creative formats (`HTML`, `VAST`, `NATIVE`). Unset allows every
   * format.
   */
  includedFormats?: string[];
  /**
   * Environments (`APP`, `WEB`). Unset includes every environment.
   */
  includedEnvironments?: string[];
  /**
   * Device platforms (`PERSONAL_COMPUTER`, `PHONE`, `TABLET`,
   * `CONNECTED_TV`). Unset allows every platform.
   */
  includedPlatforms?: string[];
  /**
   * User identifier types (`GOOGLE_COOKIE`, `DEVICE_ID`, …). At least
   * one listed type must be present on a bid request.
   */
  includedUserIdTypes?: string[];
  /**
   * Language codes to include (AdWords language codes).
   */
  includedLanguages?: string[];
  /**
   * Mobile OS ids from the Authorized Buyers mobile-os dictionary.
   */
  includedMobileOperatingSystemIds?: string[];
  /**
   * Sensitive content label ids to exclude.
   */
  excludedContentLabelIds?: string[];
  /**
   * User targeting modes a bid request must allow (`REMARKETING_ADS`,
   * `INTEREST_BASED_TARGETING`).
   */
  allowedUserTargetingModes?: string[];
  /**
   * Interstitial filter (`ONLY_INTERSTITIAL_REQUESTS` or
   * `ONLY_NON_INTERSTITIAL_REQUESTS`). Unset allows both.
   */
  interstitialTargeting?: string;
  /**
   * Maximum QPS for this config across bidding endpoints.
   */
  maximumQps?: string;
  /**
   * Minimum predicted viewability decile (0–10). `5` means 50%.
   */
  minimumViewabilityDecile?: number;
  /**
   * Included and excluded geo ids.
   */
  geoTargeting?: NumericTargetingDimension;
  /**
   * Included and excluded remarketing list ids.
   */
  userListTargeting?: NumericTargetingDimension;
  /**
   * Included and excluded publisher vertical ids.
   */
  verticalTargeting?: NumericTargetingDimension;
  /**
   * Inclusive or exclusive website targeting.
   */
  webTargeting?: StringTargetingDimension;
  /**
   * Inclusive or exclusive publisher-id targeting.
   */
  publisherTargeting?: StringTargetingDimension;
  /**
   * App id and app-category targeting.
   */
  appTargeting?: AppTargeting;
  /**
   * Creative pixel dimensions (HTML and Native).
   */
  includedCreativeDimensions?: CreativeDimensions[];
};

export type BiddersPretargetingConfig = Resource<
  "GCP.RealTimeBidding.BiddersPretargetingConfig",
  BiddersPretargetingConfigProps,
  {
    /** Full resource name `bidders/{bidder}/pretargetingConfigs/{config}`. */
    name: string;
    /** Server-assigned config id (last path segment). */
    configId: string;
    /** Parent bidder resource name `bidders/{bidder}`. */
    parent: string;
    /** Project id used when the config was reconciled. */
    project: string;
    /** Display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Server-reported state (`ACTIVE` or `SUSPENDED`). */
    state: string | undefined;
    /** Billing id used to attribute spend. */
    billingId: string | undefined;
    /** Previously targeted geos that are no longer valid. */
    invalidGeoIds: string[] | undefined;
    /** Creative formats. */
    includedFormats: string[] | undefined;
    /** Environments. */
    includedEnvironments: string[] | undefined;
    /** Device platforms. */
    includedPlatforms: string[] | undefined;
    /** User identifier types. */
    includedUserIdTypes: string[] | undefined;
    /** Language codes. */
    includedLanguages: string[] | undefined;
    /** Mobile OS ids. */
    includedMobileOperatingSystemIds: string[] | undefined;
    /** Excluded content label ids. */
    excludedContentLabelIds: string[] | undefined;
    /** Required user targeting modes. */
    allowedUserTargetingModes: string[] | undefined;
    /** Interstitial filter. */
    interstitialTargeting: string | undefined;
    /** Maximum QPS. */
    maximumQps: string | undefined;
    /** Minimum viewability decile. */
    minimumViewabilityDecile: number | undefined;
    /** Geo targeting. */
    geoTargeting: NumericTargetingDimension | undefined;
    /** Remarketing list targeting. */
    userListTargeting: NumericTargetingDimension | undefined;
    /** Vertical targeting. */
    verticalTargeting: NumericTargetingDimension | undefined;
    /** Website targeting. */
    webTargeting: StringTargetingDimension | undefined;
    /** Publisher targeting. */
    publisherTargeting: StringTargetingDimension | undefined;
    /** App targeting. */
    appTargeting: AppTargeting | undefined;
    /** Creative dimensions. */
    includedCreativeDimensions: CreativeDimensions[] | undefined;
  },
  never,
  Providers
>;

/**
 * An Authorized Buyers Real-time Bidding pretargeting configuration
 * (`bidders/{bidder}/pretargetingConfigs/{config}`).
 *
 * Pretargeting configs have no labels field, so Alchemy stamps ownership
 * into `displayName` for `list` / nuke. Parent and config id are
 * identity — changing either replaces the config. Display name and
 * targeting update in place. Create yields `ACTIVE`; pass `state:
 * "SUSPENDED"` to suspend. A bidder may own at most 10 configs.
 *
 * ### Creating a Pretargeting Config
 * **Example:** Generated display name
 * ```typescript
 * const config = yield* GCP.RealTimeBidding.BiddersPretargetingConfig(
 *   "WebHtml",
 *   { parent: "bidders/123" },
 * );
 * ```
 *
 * **Example:** Named config for web HTML
 * ```typescript
 * const config = yield* GCP.RealTimeBidding.BiddersPretargetingConfig(
 *   "WebHtml",
 *   {
 *     parent: "bidders/123",
 *     displayName: "web-html",
 *     includedEnvironments: ["WEB"],
 *     includedFormats: ["HTML"],
 *   },
 * );
 * ```
 *
 * ### Updating a Pretargeting Config
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Add Native and suspend
 * ```typescript
 * const config = yield* GCP.RealTimeBidding.BiddersPretargetingConfig(
 *   "WebHtml",
 *   {
 *     parent: "bidders/123",
 *     displayName: "web-html-v2",
 *     includedEnvironments: ["WEB"],
 *     includedFormats: ["HTML", "NATIVE"],
 *     state: "SUSPENDED",
 *   },
 * );
 * ```
 *
 * @resource
 * @category RealTimeBidding
 */
export const BiddersPretargetingConfig = Resource<BiddersPretargetingConfig>(
  "GCP.RealTimeBidding.BiddersPretargetingConfig",
);

export class BiddersPretargetingConfigNotResolved extends Data.TaggedError(
  "GCP.RealTimeBidding.BiddersPretargetingConfigNotResolved",
)<{
  parent: string;
  name: string;
}> {}

export class BiddersPretargetingConfigParentRequired extends Data.TaggedError(
  "GCP.RealTimeBidding.BiddersPretargetingConfigParentRequired",
)<{
  message: string;
}> {}

const lookupName = (
  parent: string,
  configId: string | undefined,
  existingName: string | undefined,
) => {
  if (existingName && existingName.length > 0) return existingName;
  if (configId && configId.length > 0 && parent.length > 0) {
    return resourceName(parent, configId);
  }
  return "";
};

const specFromProps = (
  props: BiddersPretargetingConfigProps,
): ReturnType<typeof specOf> =>
  specOf({
    allowedUserTargetingModes: props.allowedUserTargetingModes,
    excludedContentLabelIds: props.excludedContentLabelIds,
    includedLanguages: props.includedLanguages,
    webTargeting: props.webTargeting,
    includedPlatforms: props.includedPlatforms,
    includedFormats: props.includedFormats,
    maximumQps: props.maximumQps,
    geoTargeting: props.geoTargeting,
    includedEnvironments: props.includedEnvironments,
    userListTargeting: props.userListTargeting,
    publisherTargeting: props.publisherTargeting,
    includedUserIdTypes: props.includedUserIdTypes,
    minimumViewabilityDecile: props.minimumViewabilityDecile,
    verticalTargeting: props.verticalTargeting,
    includedCreativeDimensions: props.includedCreativeDimensions,
    interstitialTargeting: props.interstitialTargeting,
    appTargeting: props.appTargeting,
    includedMobileOperatingSystemIds: props.includedMobileOperatingSystemIds,
  });

const toAttrs = (row: rtb.PretargetingConfig, project: string) => {
  const name = row.name ?? "";
  const parent = parentOfName(name);
  return {
    name,
    configId: configIdOf(name),
    parent,
    project,
    displayName: parseDisplayName(row.displayName).displayName,
    state: row.state,
    billingId: row.billingId,
    invalidGeoIds: row.invalidGeoIds,
    includedFormats: row.includedFormats,
    includedEnvironments: row.includedEnvironments,
    includedPlatforms: row.includedPlatforms,
    includedUserIdTypes: row.includedUserIdTypes,
    includedLanguages: row.includedLanguages,
    includedMobileOperatingSystemIds: row.includedMobileOperatingSystemIds,
    excludedContentLabelIds: row.excludedContentLabelIds,
    allowedUserTargetingModes: row.allowedUserTargetingModes,
    interstitialTargeting: row.interstitialTargeting,
    maximumQps: row.maximumQps,
    minimumViewabilityDecile: row.minimumViewabilityDecile,
    geoTargeting: row.geoTargeting,
    userListTargeting: row.userListTargeting,
    verticalTargeting: row.verticalTargeting,
    webTargeting: row.webTargeting,
    publisherTargeting: row.publisherTargeting,
    appTargeting: row.appTargeting,
    includedCreativeDimensions: row.includedCreativeDimensions,
  };
};

const syncState = (
  current: rtb.PretargetingConfig,
  desired: string | undefined,
) =>
  Effect.gen(function* () {
    if (!desired || !current.name) return current;
    const observed = current.state ?? "";
    if (observed === desired) return current;
    if (desired === "ACTIVE" && observed === "SUSPENDED") {
      return yield* rtb.activateBiddersPretargetingConfigs({
        name: current.name,
      });
    }
    if (desired === "SUSPENDED" && observed === "ACTIVE") {
      return yield* rtb.suspendBiddersPretargetingConfigs({
        name: current.name,
      });
    }
    return current;
  });

export const BiddersPretargetingConfigProvider = () =>
  Provider.succeed(BiddersPretargetingConfig, {
    stables: ["name", "configId", "parent", "project", "billingId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousParent: expandParent(olds?.parent ?? output?.parent ?? ""),
        nextParent: expandParent(news.parent),
        previousId: olds?.configId ?? output?.configId,
        nextId: news.configId,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandParent(olds?.parent ?? output?.parent ?? "");
      const name = lookupName(
        parent,
        olds?.configId ?? output?.configId,
        output?.name,
      );
      let existing = yield* getConfig(name);
      if (existing === undefined) {
        existing = yield* findOwnedConfig(id, parent, name);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rows = yield* listOwnedConfigs();
        return rows
          .filter((row) => hasOwnershipMarker(row.displayName))
          .map((row) => toAttrs(row, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandParent(news.parent);
      if (parent.length === 0) {
        return yield* new BiddersPretargetingConfigParentRequired({
          message:
            "BiddersPretargetingConfig requires parent (bidders/{bidder})",
        });
      }
      const ownership = yield* ownershipLabels(id);
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const stamped = encodeDisplayName(ownership, displayName);
      const name = lookupName(
        parent,
        news.configId ?? output?.configId,
        output?.name,
      );

      let current = yield* getConfig(name);
      if (current === undefined) {
        current = yield* findOwnedConfig(id, parent, name, stamped);
      }

      const desired = mergeSpec(
        specFromProps(news),
        current === undefined ? undefined : specFromRow(current),
      );

      if (current === undefined) {
        const created = yield* rtb
          .createBiddersPretargetingConfigs({
            parent,
            body: toConfigBody(stamped, desired),
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedConfig(id, parent, name, stamped),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new BiddersPretargetingConfigNotResolved({
          parent,
          name: name || stamped,
        });
      }

      const currentName = current.name ?? name;
      const updateMask = updateMaskOf(current, desired, stamped);
      if (updateMask.length > 0) {
        current = yield* rtb.patchBiddersPretargetingConfigs({
          name: currentName,
          updateMask,
          body: toConfigBody(stamped, desired),
        });
      }

      current = yield* syncState(current, news.state);

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreMissing(
        rtb.deleteBiddersPretargetingConfigs({ name: output.name }),
      );
    }),
  });
