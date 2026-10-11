import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import type {
  LogBucketCmekSettings,
  LogBucketIndexConfig,
} from "./LogBucket.ts";
import {
  DEFAULT_LOCATION,
  DEFAULT_RETENTION_DAYS,
  billingAccountIdOf,
  billingAccountParent,
  encodeDescription,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  lookupProjectBillingAccountId,
  parseDescription,
  resolveBillingAccountId,
  toPhysicalId,
} from "./internal.ts";

export type BillingBucketIndexConfig = LogBucketIndexConfig;
export type BillingBucketCmekSettings = LogBucketCmekSettings;

export type BillingBucketProps = {
  /**
   * Bucket id (the `{bucket}` segment of
   * `billingAccounts/{billingAccount}/locations/{location}/buckets/{bucket}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Limited to 100 characters: letters, digits, underscores,
   * hyphens, periods; first character must be alphanumeric. Immutable —
   * changing it replaces the bucket.
   */
  bucketId?: string;
  /**
   * Billing account id (`XXXXXX-XXXXXX-XXXXXX` or
   * `billingAccounts/{id}`). If omitted, Alchemy uses the billing
   * account linked to the current project. Immutable — changing it
   * replaces the bucket.
   */
  billingAccountId?: string;
  /**
   * Location that stores log entries. `global` leaves placement unspecified.
   * Immutable after create — changing it replaces the bucket.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description. Log buckets have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Days to retain log entries before they are deleted. Minimum 1. `0` at
   * create uses the GCP default of 30. Cannot be changed while the bucket
   * is locked.
   * @default 30
   */
  retentionDays?: number;
  /**
   * When true, retention cannot be reduced and the bucket can only be
   * deleted if empty. Locking cannot be undone.
   * @default false
   */
  locked?: boolean;
  /**
   * Enable Log Analytics. Once enabled, it cannot be disabled.
   * @default false
   */
  analyticsEnabled?: boolean;
  /**
   * Log entry field paths denied in this bucket (e.g. `textPayload`,
   * `jsonPayload`).
   */
  restrictedFields?: string[];
  /**
   * Custom indexed fields. Automatically indexed paths cannot be changed.
   */
  indexConfigs?: BillingBucketIndexConfig[];
  /**
   * Customer-managed encryption for new log entries. Once configured,
   * CMEK cannot be disabled.
   */
  cmekSettings?: BillingBucketCmekSettings;
};

export type BillingBucket = Resource<
  "GCP.Logging.BillingBucket",
  BillingBucketProps,
  {
    /** Full resource name `billingAccounts/{billingAccount}/locations/{location}/buckets/{bucketId}`. */
    name: string;
    /** Bucket id (last path segment). */
    bucketId: string;
    /** Billing account id. */
    billingAccountId: string;
    /** Location that stores log entries. */
    location: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Retention period in days. */
    retentionDays: number;
    /** Whether the bucket is locked. */
    locked: boolean;
    /** Whether Log Analytics is enabled. */
    analyticsEnabled: boolean;
    /** Restricted field paths. */
    restrictedFields: string[];
    /** Custom index configs. */
    indexConfigs: BillingBucketIndexConfig[];
    /** CMEK key name, if configured. */
    cmekSettings: BillingBucketCmekSettings | undefined;
    /** Bucket lifecycle (`ACTIVE`, `DELETE_REQUESTED`, …). */
    lifecycleState: string | undefined;
    /** RFC3339 creation timestamp. Unset on GCP default buckets. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Logging log bucket owned by a billing account.
 *
 * Log buckets have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. `bucketId`, `location`, and
 * `billingAccountId` are identity — changing any replaces the bucket.
 * Delete marks the bucket `DELETE_REQUESTED`; GCP purges it after 7 days.
 * Reconcile undeletes a bucket still in that grace period so the same
 * name can be reused.
 *
 * ### Creating a Billing Log Bucket
 * **Example:** Generated name in `global`
 * ```typescript
 * const bucket = yield* GCP.Logging.BillingBucket("AppLogs", {
 *   description: "application logs",
 * });
 * ```
 *
 * **Example:** Named bucket with custom retention
 * ```typescript
 * const bucket = yield* GCP.Logging.BillingBucket("AppLogs", {
 *   billingAccountId: "AAAAAA-BBBBBB-CCCCCC",
 *   bucketId: "app-logs",
 *   location: "global",
 *   description: "application logs",
 *   retentionDays: 31,
 * });
 * ```
 *
 * ### Updating a Billing Log Bucket
 * **Example:** Change description and retention
 * ```typescript
 * const bucket = yield* GCP.Logging.BillingBucket("AppLogs", {
 *   location: "global",
 *   description: "retained application logs",
 *   retentionDays: 60,
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const BillingBucket = Resource<BillingBucket>(
  "GCP.Logging.BillingBucket",
);

export class BillingBucketNotResolved extends Data.TaggedError(
  "GCP.Logging.BillingBucketNotResolved",
)<{
  name: string;
}> {}

export class BillingBucketFailed extends Data.TaggedError(
  "GCP.Logging.BillingBucketFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

const resourceName = (
  billingAccountId: string,
  location: string,
  bucketId: string,
) =>
  `${billingAccountParent(billingAccountId)}/locations/${location}/buckets/${bucketId}`;

const parseBucketName = (name: string) => {
  const match = name.match(
    /^billingAccounts\/([^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    billingAccountId: match[1]!,
    location: match[2]!,
    bucketId: match[3]!,
  };
};

const bucketIdOf = (bucket: logging.LogBucket, fallback?: string) => {
  const parsed = parseBucketName(bucket.name ?? "");
  return parsed?.bucketId ?? fallback ?? lastSegment(bucket.name ?? "");
};

const locationOf = (bucket: logging.LogBucket, fallback: string) => {
  const parsed = parseBucketName(bucket.name ?? "");
  return parsed?.location ?? fallback;
};

const isDeleted = (
  bucket: logging.LogBucket | undefined,
): bucket is undefined =>
  bucket === undefined || bucket.lifecycleState === "DELETE_REQUESTED";

const isPending = (state: string | undefined) =>
  state === "CREATING" || state === "UPDATING";

const canonRestricted = (fields: readonly string[] | undefined) =>
  [...(fields ?? [])].slice().sort();

const canonIndexConfigs = (
  configs:
    | readonly logging.IndexConfig[]
    | readonly BillingBucketIndexConfig[]
    | undefined,
): BillingBucketIndexConfig[] =>
  [...(configs ?? [])]
    .flatMap((config) =>
      config.fieldPath
        ? [
            {
              fieldPath: config.fieldPath,
              type: (config.type ??
                "INDEX_TYPE_STRING") as BillingBucketIndexConfig["type"],
            },
          ]
        : [],
    )
    .sort((left, right) => left.fieldPath.localeCompare(right.fieldPath));

const toAttrs = (
  bucket: logging.LogBucket,
  billingAccountId: string,
  location: string,
) => {
  const parsedName = parseBucketName(bucket.name ?? "");
  const bucketId = bucketIdOf(bucket);
  const resolvedLocation = locationOf(bucket, location);
  const parsed = parseDescription(bucket.description);
  const cmekKey = bucket.cmekSettings?.kmsKeyName;
  const account = parsedName?.billingAccountId ?? billingAccountId;
  return {
    name:
      bucket.name ??
      (bucketId ? resourceName(account, resolvedLocation, bucketId) : ""),
    bucketId,
    billingAccountId: account,
    location: resolvedLocation,
    description: parsed.description,
    retentionDays: bucket.retentionDays ?? DEFAULT_RETENTION_DAYS,
    locked: bucket.locked === true,
    analyticsEnabled: bucket.analyticsEnabled === true,
    restrictedFields: [...(bucket.restrictedFields ?? [])],
    indexConfigs: canonIndexConfigs(bucket.indexConfigs),
    cmekSettings: cmekKey ? { kmsKeyName: cmekKey } : undefined,
    lifecycleState: bucket.lifecycleState,
    createTime: bucket.createTime,
    updateTime: bucket.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getBillingAccountsLocationsBuckets({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const undelete = (name: string) =>
  logging
    .undeleteBillingAccountsLocationsBuckets({ name, body: {} })
    .pipe(Effect.catchTag(["NotFound", "Conflict"], () => Effect.void));

const waitUntilActive = (name: string) =>
  Effect.gen(function* () {
    const bucket = yield* getByName(name);
    if (bucket === undefined || isDeleted(bucket)) {
      return yield* new BillingBucketNotResolved({ name });
    }
    if (bucket.lifecycleState === "FAILED") {
      return yield* new BillingBucketFailed({
        name,
        state: bucket.lifecycleState,
      });
    }
    if (isPending(bucket.lifecycleState)) {
      return yield* new BillingBucketNotResolved({ name });
    }
    return bucket;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.Logging.BillingBucketNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilDeleted = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((bucket) =>
      isDeleted(bucket)
        ? Effect.void
        : Effect.fail(new BillingBucketNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Logging.BillingBucketNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const toCreateBody = (
  props: BillingBucketProps,
  description: string,
): logging.LogBucket => ({
  description,
  retentionDays: props.retentionDays,
  locked: props.locked === true ? true : undefined,
  analyticsEnabled: props.analyticsEnabled === true ? true : undefined,
  restrictedFields:
    props.restrictedFields && props.restrictedFields.length > 0
      ? [...props.restrictedFields]
      : undefined,
  indexConfigs:
    props.indexConfigs && props.indexConfigs.length > 0
      ? props.indexConfigs.map((config) => ({
          fieldPath: config.fieldPath,
          type: config.type,
        }))
      : undefined,
  cmekSettings: props.cmekSettings
    ? { kmsKeyName: props.cmekSettings.kmsKeyName }
    : undefined,
});

export const BillingBucketProvider = () =>
  Provider.succeed(BillingBucket, {
    stables: ["name", "bucketId", "billingAccountId", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.bucketId ?? output?.bucketId;
      const idChanged =
        previousId !== undefined &&
        news.bucketId !== undefined &&
        news.bucketId !== previousId;
      const previousLocation = olds?.location ?? output?.location;
      const locationChanged =
        previousLocation !== undefined &&
        news.location !== undefined &&
        news.location !== previousLocation;
      const previousAccount =
        olds?.billingAccountId ?? output?.billingAccountId;
      const accountChanged =
        previousAccount !== undefined &&
        news.billingAccountId !== undefined &&
        billingAccountIdOf(news.billingAccountId) !==
          billingAccountIdOf(previousAccount);
      if (!idChanged && !locationChanged && !accountChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const billingAccountId = yield* resolveBillingAccountId(
        olds?.billingAccountId,
        output?.billingAccountId,
      );
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const bucketId = yield* toPhysicalId(
        id,
        olds?.bucketId,
        output?.bucketId,
        "b",
      );
      const name =
        output?.name ?? resourceName(billingAccountId, location, bucketId);
      const existing = yield* getByName(name);
      if (isDeleted(existing)) return undefined;
      const attrs = toAttrs(existing, billingAccountId, location);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const billingAccountId = yield* lookupProjectBillingAccountId(
          env.project,
        );
        if (billingAccountId === undefined) return [];
        return yield* logging.listBillingAccountsLocationsBuckets
          .pages({
            parent: `${billingAccountParent(billingAccountId)}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.buckets ?? [])),
            Stream.filter(
              (bucket) =>
                !isDeleted(bucket) && hasOwnershipMarker(bucket.description),
            ),
            Stream.map((bucket) =>
              toAttrs(
                bucket,
                billingAccountId,
                locationOf(bucket, DEFAULT_LOCATION),
              ),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as BillingBucket["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const billingAccountId = yield* resolveBillingAccountId(
        news.billingAccountId,
        output?.billingAccountId,
      );
      const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
      const bucketId = yield* toPhysicalId(
        id,
        news.bucketId,
        output?.bucketId,
        "b",
      );
      const name = resourceName(billingAccountId, location, bucketId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (
        current !== undefined &&
        current.lifecycleState === "DELETE_REQUESTED"
      ) {
        yield* undelete(current.name ?? name);
        current = yield* waitUntilActive(current.name ?? name);
      }

      if (current === undefined) {
        const created = yield* logging
          .createBillingAccountsLocationsBuckets({
            parent: `${billingAccountParent(billingAccountId)}/locations/${location}`,
            bucketId,
            body: toCreateBody(news, desiredDescription),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
        if (
          current !== undefined &&
          current.lifecycleState === "DELETE_REQUESTED"
        ) {
          yield* undelete(current.name ?? name);
          current = yield* waitUntilActive(current.name ?? name);
        } else if (current !== undefined && isPending(current.lifecycleState)) {
          current = yield* waitUntilActive(current.name ?? name);
        }
      }

      if (isDeleted(current)) {
        return yield* new BillingBucketNotResolved({ name });
      }

      const desiredLocked = news.locked === true;
      const desiredAnalytics = news.analyticsEnabled === true;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const retentionChanged =
        news.retentionDays !== undefined &&
        current.locked !== true &&
        (current.retentionDays ?? DEFAULT_RETENTION_DAYS) !==
          news.retentionDays;
      const restrictedChanged =
        news.restrictedFields !== undefined &&
        !jsonEqual(
          canonRestricted(current.restrictedFields),
          canonRestricted(news.restrictedFields),
        );
      const indexChanged =
        news.indexConfigs !== undefined &&
        !jsonEqual(
          canonIndexConfigs(current.indexConfigs),
          canonIndexConfigs(news.indexConfigs),
        );
      const analyticsChanged =
        news.analyticsEnabled !== undefined &&
        desiredAnalytics &&
        current.analyticsEnabled !== true;
      const cmekChanged =
        news.cmekSettings !== undefined &&
        (current.cmekSettings?.kmsKeyName ?? "") !==
          news.cmekSettings.kmsKeyName;
      const lockedChanged =
        news.locked !== undefined && desiredLocked && current.locked !== true;

      const syncMask = [
        descriptionChanged ? "description" : undefined,
        retentionChanged ? "retentionDays" : undefined,
        restrictedChanged ? "restrictedFields" : undefined,
        indexChanged ? "indexConfigs" : undefined,
        analyticsChanged ? "analyticsEnabled" : undefined,
        cmekChanged ? "cmekSettings" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (syncMask.length > 0) {
        const body: logging.LogBucket = {};
        if (descriptionChanged) body.description = desiredDescription;
        if (retentionChanged) body.retentionDays = news.retentionDays;
        if (restrictedChanged) {
          body.restrictedFields = [...(news.restrictedFields ?? [])];
        }
        if (indexChanged) {
          body.indexConfigs = (news.indexConfigs ?? []).map((config) => ({
            fieldPath: config.fieldPath,
            type: config.type,
          }));
        }
        if (analyticsChanged) body.analyticsEnabled = true;
        if (cmekChanged) {
          body.cmekSettings = { kmsKeyName: news.cmekSettings?.kmsKeyName };
        }
        current = yield* logging.patchBillingAccountsLocationsBuckets({
          name: current.name ?? name,
          updateMask: syncMask.join(","),
          body,
        });
        if (isPending(current.lifecycleState)) {
          current = yield* waitUntilActive(current.name ?? name);
        }
      }

      if (lockedChanged) {
        current = yield* logging.patchBillingAccountsLocationsBuckets({
          name: current.name ?? name,
          updateMask: "locked",
          body: { locked: true },
        });
        if (isPending(current.lifecycleState)) {
          current = yield* waitUntilActive(current.name ?? name);
        }
      }

      return toAttrs(current, billingAccountId, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.lifecycleState === "DELETE_REQUESTED") return;
      yield* logging
        .deleteBillingAccountsLocationsBuckets({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilDeleted(output.name);
    }),
  });
