import * as securitylake from "@distilled.cloud/aws/securitylake";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  readSecurityLakeTags,
  retryWhileConflict,
  toTagList,
} from "./internal.ts";

/**
 * Encryption settings for a Security Lake Region.
 */
export interface DataLakeEncryptionConfiguration {
  /**
   * The KMS key ID used to encrypt objects at rest, or `S3_MANAGED_KEY` for
   * SSE-S3 (the default).
   * @default "S3_MANAGED_KEY"
   */
  kmsKeyId?: string;
}

/**
 * When objects expire out of the data lake.
 */
export interface DataLakeLifecycleExpiration {
  /**
   * How long after creation objects are deleted. Accepts any
   * `Duration.Input` (e.g. `"365 days"`, `Duration.days(365)`; a bare
   * number is milliseconds); the wire unit is whole days.
   */
  days?: Duration.Input;
}

/**
 * A storage-class transition rule.
 */
export interface DataLakeLifecycleTransition {
  /** The S3 storage class to transition into (e.g. `GLACIER`, `ONEZONE_IA`). */
  storageClass?: string;
  /**
   * How long after creation objects transition. Accepts any
   * `Duration.Input` (e.g. `"30 days"`, `Duration.days(30)`; a bare
   * number is milliseconds); the wire unit is whole days.
   */
  days?: Duration.Input;
}

/**
 * Lifecycle management (retention + storage-class transitions) for a Region.
 */
export interface DataLakeLifecycleConfiguration {
  /** When objects expire out of the data lake. */
  expiration?: DataLakeLifecycleExpiration;
  /** Storage-class transition rules. */
  transitions?: DataLakeLifecycleTransition[];
}

/**
 * Rollup-Region replication for a contributing Region.
 */
export interface DataLakeReplicationConfiguration {
  /** The rollup Regions that this Region's data is replicated into. */
  regions?: string[];
  /** IAM role ARN Security Lake assumes to replicate objects. */
  roleArn?: string;
}

/**
 * Per-Region configuration of the Security Lake data lake.
 */
export interface DataLakeRegionConfiguration {
  /** The Region in which Security Lake is enabled. */
  region: string;
  /** Encryption at rest for this Region. */
  encryptionConfiguration?: DataLakeEncryptionConfiguration;
  /** Retention and storage-class transitions for this Region. */
  lifecycleConfiguration?: DataLakeLifecycleConfiguration;
  /** Rollup-Region replication for this Region. */
  replicationConfiguration?: DataLakeReplicationConfiguration;
}

export interface DataLakeProps {
  /**
   * The Regions to enable Security Lake in, each with its own encryption,
   * lifecycle, and replication settings. Adding a Region enables Security Lake
   * there; removing a previously configured Region disables it there.
   */
  configurations: DataLakeRegionConfiguration[];

  /**
   * ARN of the IAM role used by the Security Lake metastore manager (the
   * `AmazonSecurityLakeMetaStoreManagerV2` role) to populate the Glue
   * metastore with partition updates.
   */
  metaStoreManagerRoleArn: string;

  /**
   * Tags applied to the data lake. Alchemy ownership tags are merged in
   * automatically so the data lake can be recognized on subsequent runs.
   */
  tags?: Record<string, string>;
}

/** Attributes of the data lake in one Region. */
export interface DataLakeRegionAttributes {
  /** ARN of the data lake in this Region. */
  dataLakeArn: string;
  /** The Region. */
  region: string;
  /** ARN of the S3 bucket Security Lake created for this Region. */
  s3BucketArn: string | undefined;
  /** Creation status of the data lake in this Region. */
  createStatus: string | undefined;
}

/** @resource */
export interface DataLake extends Resource<
  "AWS.SecurityLake.DataLake",
  DataLakeProps,
  {
    /** ARN of the data lake in the current (deployment) Region. */
    dataLakeArn: string;
    /** Every Region the data lake is enabled in. */
    regions: string[];
    /** Per-Region attributes (ARN, S3 bucket, status). */
    dataLakes: DataLakeRegionAttributes[];
  },
  never,
  Providers
> {}

/**
 * The Amazon Security Lake data lake — the account-wide singleton that
 * onboards the account to Security Lake. Enabling it creates S3 buckets,
 * registers them with Lake Formation, and configures the Glue metastore in
 * every configured Region.
 *
 * This is a heavyweight, account-wide resource: enabling/disabling Security
 * Lake affects the whole account, and the S3 buckets it creates are retained
 * after the data lake is deleted.
 *
 * @section Enabling Security Lake
 * @example Single-Region data lake
 * ```typescript
 * const lake = yield* SecurityLake.DataLake("Lake", {
 *   configurations: [{ region: "us-west-2" }],
 *   metaStoreManagerRoleArn: metastoreRole.roleArn,
 * });
 * ```
 *
 * @example Lifecycle management and KMS encryption
 * ```typescript
 * const lake = yield* SecurityLake.DataLake("Lake", {
 *   configurations: [
 *     {
 *       region: "us-west-2",
 *       encryptionConfiguration: { kmsKeyId: key.keyId },
 *       lifecycleConfiguration: {
 *         expiration: { days: "365 days" },
 *         transitions: [{ storageClass: "ONEZONE_IA", days: "30 days" }],
 *       },
 *     },
 *   ],
 *   metaStoreManagerRoleArn: metastoreRole.roleArn,
 *   tags: { team: "security" },
 * });
 * ```
 */
const DataLakeResource = Resource<DataLake>("AWS.SecurityLake.DataLake");

export { DataLakeResource as DataLake };

/**
 * The data lake failed to reach `COMPLETED` in one of the configured Regions.
 */
export class DataLakeCreateFailed extends Data.TaggedError(
  "DataLakeCreateFailed",
)<{
  readonly region: string;
  readonly reason: string | undefined;
  readonly code: string | undefined;
}> {}

// Convert a per-Region prop configuration (Duration-typed lifecycle days)
// into the wire shape the Security Lake API expects (whole days).
const toWireConfiguration = (
  config: DataLakeRegionConfiguration,
): securitylake.DataLakeConfiguration => ({
  region: config.region,
  encryptionConfiguration: config.encryptionConfiguration,
  lifecycleConfiguration: config.lifecycleConfiguration
    ? {
        expiration: config.lifecycleConfiguration.expiration
          ? { days: toWireDays(config.lifecycleConfiguration.expiration.days) }
          : undefined,
        transitions: config.lifecycleConfiguration.transitions?.map(
          (transition) => ({
            storageClass: transition.storageClass,
            days: toWireDays(transition.days),
          }),
        ),
      }
    : undefined,
  replicationConfiguration: config.replicationConfiguration,
});

// Normalize a per-Region config for observed↔desired comparison. AWS reports
// SSE-S3 as `S3_MANAGED_KEY`, so an unset kmsKeyId compares equal to it.
const normalizeConfig = (config: {
  encryptionConfiguration?: securitylake.DataLakeEncryptionConfiguration;
  lifecycleConfiguration?: securitylake.DataLakeLifecycleConfiguration;
  replicationConfiguration?: securitylake.DataLakeReplicationConfiguration;
}) =>
  JSON.stringify({
    kmsKeyId: config.encryptionConfiguration?.kmsKeyId ?? "S3_MANAGED_KEY",
    expirationDays: config.lifecycleConfiguration?.expiration?.days,
    transitions: [...(config.lifecycleConfiguration?.transitions ?? [])]
      .map((t) => ({ storageClass: t.storageClass, days: t.days }))
      .sort((l, r) =>
        (l.storageClass ?? "").localeCompare(r.storageClass ?? ""),
      ),
    replicationRegions: [
      ...(config.replicationConfiguration?.regions ?? []),
    ].sort(),
    replicationRoleArn: config.replicationConfiguration?.roleArn,
  });

const buildRegionAttrs = (
  lake: securitylake.DataLakeResource,
): DataLakeRegionAttributes => ({
  dataLakeArn: lake.dataLakeArn,
  region: lake.region,
  s3BucketArn: lake.s3BucketArn,
  createStatus: lake.createStatus,
});

const buildAttrs = (
  lakes: securitylake.DataLakeResource[],
  currentRegion: string,
) => {
  const sorted = [...lakes].sort((l, r) => l.region.localeCompare(r.region));
  const current = sorted.find((lake) => lake.region === currentRegion);
  return {
    dataLakeArn: (current ?? sorted[0]!).dataLakeArn,
    regions: sorted.map((lake) => lake.region),
    dataLakes: sorted.map(buildRegionAttrs),
  };
};

// All data lakes for the account across every Region.
const observeDataLakes = securitylake
  .listDataLakes({})
  .pipe(Effect.map((response) => [...(response.dataLakes ?? [])]));

// Observation for read/list: an account that never onboarded Security Lake
// rejects listDataLakes with AccessDeniedException — that means "no data
// lake", not a failure.
const observeDataLakesIfOnboarded = observeDataLakes.pipe(
  Effect.catchTag(["AccessDeniedException", "UnauthorizedException"], () =>
    Effect.succeed([] as securitylake.DataLakeResource[]),
  ),
);

export const DataLakeProvider = () =>
  Provider.effect(
    DataLakeResource,
    Effect.gen(function* () {
      // Bounded wait (~90s) for every desired Region to finish onboarding.
      // A FAILED createStatus is surfaced as a typed error; still-PENDING
      // Regions after the window are returned as-is (the next reconcile
      // converges) rather than hanging.
      const awaitDataLakeReady = Effect.fn(function* (regions: string[]) {
        let lakes: securitylake.DataLakeResource[] = [];
        for (let attempt = 0; attempt < 18; attempt++) {
          lakes = yield* observeDataLakes;
          const failed = lakes.find(
            (lake) =>
              regions.includes(lake.region) && lake.createStatus === "FAILED",
          );
          if (failed) {
            return yield* Effect.fail(
              new DataLakeCreateFailed({
                region: failed.region,
                reason: failed.updateStatus?.exception?.reason,
                code: failed.updateStatus?.exception?.code,
              }),
            );
          }
          const allReady = regions.every((region) =>
            lakes.some(
              (lake) =>
                lake.region === region && lake.createStatus === "COMPLETED",
            ),
          );
          if (allReady) return lakes;
          yield* Effect.sleep("5 seconds");
        }
        return lakes;
      });

      return {
        read: Effect.fn(function* ({ id }) {
          const { region } = yield* AWSEnvironment.current;
          const lakes = yield* observeDataLakesIfOnboarded;
          if (lakes.length === 0) return undefined;
          const attrs = buildAttrs(lakes, region);
          const tags = yield* readSecurityLakeTags(attrs.dataLakeArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // The data lake is an account-wide singleton spanning Regions.
        list: () =>
          Effect.gen(function* () {
            const { region } = yield* AWSEnvironment.current;
            const lakes = yield* observeDataLakesIfOnboarded;
            return lakes.length > 0 ? [buildAttrs(lakes, region)] : [];
          }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { region } = yield* AWSEnvironment.current;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredConfigs = news.configurations.map(toWireConfiguration);
          const desiredRegions = desiredConfigs.map((c) => c.region);

          // 1. OBSERVE — cloud state is authoritative.
          let lakes = yield* observeDataLakes;
          const observedByRegion = new Map(
            lakes.map((lake) => [lake.region, lake]),
          );

          // 2. ENSURE — createDataLake is additive per Region, so enabling
          // missing Regions covers both greenfield onboarding and Region
          // expansion. A ConflictException is a race with a concurrent
          // enable — fall through to observation.
          const missing = desiredConfigs.filter(
            (config) => !observedByRegion.has(config.region),
          );
          if (missing.length > 0) {
            yield* securitylake
              .createDataLake({
                configurations: missing,
                metaStoreManagerRoleArn: news.metaStoreManagerRoleArn,
                tags: toTagList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () => Effect.succeed({})),
              );
          }

          // 3. SYNC per-Region settings — observed ↔ desired delta only.
          const changed = desiredConfigs.filter((config) => {
            const observed = observedByRegion.get(config.region);
            return (
              observed !== undefined &&
              normalizeConfig(config) !== normalizeConfig(observed)
            );
          });
          if (changed.length > 0) {
            yield* securitylake.updateDataLake({
              configurations: changed,
              metaStoreManagerRoleArn: news.metaStoreManagerRoleArn,
            });
          }

          // 3b. SYNC Region removals — only Regions this resource previously
          // managed (recorded in output) are disabled; foreign Regions that
          // happen to be enabled are left alone.
          const staleRegions = (output?.regions ?? []).filter(
            (managed) =>
              !desiredRegions.includes(managed) &&
              observedByRegion.has(managed),
          );
          if (staleRegions.length > 0) {
            yield* securitylake
              .deleteDataLake({ regions: staleRegions })
              .pipe(retryWhileConflict);
          }

          // 3c. Wait (bounded) for onboarding to complete in every Region.
          lakes = yield* awaitDataLakeReady(desiredRegions);
          if (lakes.length === 0) {
            return yield* Effect.fail(
              new DataLakeCreateFailed({
                region: desiredRegions[0] ?? region,
                reason: "data lake not observable after create",
                code: undefined,
              }),
            );
          }
          const managed = lakes.filter((lake) =>
            desiredRegions.includes(lake.region),
          );
          const attrs = buildAttrs(
            managed.length > 0 ? managed : lakes,
            region,
          );

          // 3d. SYNC tags — diff against OBSERVED cloud tags.
          const observedTags = yield* readSecurityLakeTags(attrs.dataLakeArn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* securitylake.tagResource({
              resourceArn: attrs.dataLakeArn,
              tags: upsert.map((t) => ({ key: t.Key, value: t.Value })),
            });
          }
          if (removed.length > 0) {
            yield* securitylake.untagResource({
              resourceArn: attrs.dataLakeArn,
              tagKeys: removed,
            });
          }

          // 4. RETURN fresh attributes.
          yield* session.note(attrs.dataLakeArn);
          return attrs;
        }),

        // Disabling Security Lake retains the S3 buckets it created (AWS
        // behavior); only log collection and the lake configuration go away.
        delete: Effect.fn(function* ({ output }) {
          if (output.regions.length === 0) return;
          yield* securitylake.deleteDataLake({ regions: output.regions }).pipe(
            retryWhileConflict,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );
