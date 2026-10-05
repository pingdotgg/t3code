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
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  DEFAULT_RETENTION_DAYS,
  canonIndexConfigs,
  canonRestricted,
  createOwnership,
  encodeDescription,
  hasOwnershipMarker,
  isDeletedBucket,
  isPendingBucket,
  jsonEqual,
  lastSegment,
  locationParent,
  ownedBy,
  parseDescription,
  parseLoggingName,
  toPhysicalId,
  type LogBucketIndexConfig,
} from "./internal.ts";

export type LocationsBucketIndexConfig = LogBucketIndexConfig;

export type LocationsBucketCmekSettings = {
  /**
   * Cloud KMS key used to encrypt new log entries
   * (`projects/{project}/locations/{location}/keyRings/{ring}/cryptoKeys/{key}`).
   * Once set, CMEK cannot be disabled; the key may be rotated.
   */
  kmsKeyName: string;
};

export type LocationsBucketProps = {
  /**
   * Parent resource (`projects/{project}`, `folders/{folder}`,
   * `organizations/{organization}`, or `billingAccounts/{account}`).
   * Defaults to the stack project. Immutable — changing it replaces the
   * bucket.
   */
  parent?: string;
  /**
   * Bucket id (the `{bucket}` segment of
   * `{parent}/locations/{location}/buckets/{bucket}`). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Limited to
   * 100 characters: letters, digits, underscores, hyphens, periods; first
   * character must be alphanumeric. Immutable — changing it replaces the
   * bucket.
   */
  bucketId?: string;
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
  indexConfigs?: LocationsBucketIndexConfig[];
  /**
   * Customer-managed encryption for new log entries. Once configured,
   * CMEK cannot be disabled.
   */
  cmekSettings?: LocationsBucketCmekSettings;
};

export type LocationsBucket = Resource<
  "GCP.Logging.LocationsBucket",
  LocationsBucketProps,
  {
    /** Full resource name `{parent}/locations/{location}/buckets/{bucketId}`. */
    name: string;
    /** Bucket id (last path segment). */
    bucketId: string;
    /** Parent resource (`projects/{project}`, `folders/{folder}`, …). */
    parent: string;
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
    indexConfigs: LocationsBucketIndexConfig[];
    /** CMEK key name, if configured. */
    cmekSettings: LocationsBucketCmekSettings | undefined;
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
 * A Cloud Logging log bucket addressed through the generic locations APIs.
 *
 * Uses `createLocationsBuckets` / `getLocationsBuckets` / `deleteLocationsBuckets`.
 * Log buckets have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. `parent`, `bucketId`, and `location` are
 * identity — changing any of them replaces the bucket. Delete marks the
 * bucket `DELETE_REQUESTED`; GCP purges it after 7 days.
 *
 * ### Creating a Locations Bucket
 * **Example:** Generated name in `global`
 * ```typescript
 * const bucket = yield* GCP.Logging.LocationsBucket("AppLogs", {
 *   description: "application logs",
 * });
 * ```
 *
 * **Example:** Named bucket with custom retention
 * ```typescript
 * const bucket = yield* GCP.Logging.LocationsBucket("AppLogs", {
 *   bucketId: "app-logs",
 *   location: "global",
 *   description: "application logs",
 *   retentionDays: 31,
 * });
 * ```
 *
 * ### Updating a Locations Bucket
 * **Example:** Change description and retention
 * ```typescript
 * const bucket = yield* GCP.Logging.LocationsBucket("AppLogs", {
 *   location: "global",
 *   description: "retained application logs",
 *   retentionDays: 60,
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const LocationsBucket = Resource<LocationsBucket>(
  "GCP.Logging.LocationsBucket",
);

export class LocationsBucketNotResolved extends Data.TaggedError(
  "GCP.Logging.LocationsBucketNotResolved",
)<{
  name: string;
}> {}

export class LocationsBucketFailed extends Data.TaggedError(
  "GCP.Logging.LocationsBucketFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

const resourceName = (parent: string, location: string, bucketId: string) =>
  `${locationParent(parent, location)}/buckets/${bucketId}`;

const normalizeParent = (project: string, parent: string | undefined) => {
  if (parent === undefined || parent.length === 0) {
    return `projects/${project}`;
  }
  if (
    parent.startsWith("projects/") ||
    parent.startsWith("folders/") ||
    parent.startsWith("organizations/") ||
    parent.startsWith("billingAccounts/")
  ) {
    return parent.split("/").slice(0, 2).join("/");
  }
  return `projects/${parent}`;
};

const toAttrs = (
  bucket: logging.LogBucket,
  parent: string,
  location: string,
) => {
  const parsed = parseLoggingName(bucket.name ?? "");
  const bucketId = parsed.bucketId ?? lastSegment(bucket.name ?? "");
  const resolvedParent = parsed.parent || parent;
  const resolvedLocation = parsed.location ?? location;
  const description = parseDescription(bucket.description);
  const cmekKey = bucket.cmekSettings?.kmsKeyName;
  return {
    name:
      bucket.name ??
      (bucketId
        ? resourceName(resolvedParent, resolvedLocation, bucketId)
        : ""),
    bucketId,
    parent: resolvedParent,
    location: resolvedLocation,
    description: description.description,
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
    .getLocationsBuckets({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const undelete = (name: string) =>
  logging
    .undeleteLocationsBuckets({ name, body: {} })
    .pipe(Effect.catchTag(["NotFound", "Conflict"], () => Effect.void));

const waitUntilActive = (name: string) =>
  Effect.gen(function* () {
    const bucket = yield* getByName(name);
    if (bucket === undefined || isDeletedBucket(bucket)) {
      return yield* new LocationsBucketNotResolved({ name });
    }
    if (bucket.lifecycleState === "FAILED") {
      return yield* new LocationsBucketFailed({
        name,
        state: bucket.lifecycleState,
      });
    }
    if (isPendingBucket(bucket.lifecycleState)) {
      return yield* new LocationsBucketNotResolved({ name });
    }
    return bucket;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.Logging.LocationsBucketNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilDeleted = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((bucket) =>
      isDeletedBucket(bucket)
        ? Effect.void
        : Effect.fail(new LocationsBucketNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Logging.LocationsBucketNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const toCreateBody = (
  props: LocationsBucketProps,
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

export const LocationsBucketProvider = () =>
  Provider.succeed(LocationsBucket, {
    stables: ["name", "bucketId", "parent", "location", "createTime"],

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
      const previousParent = olds?.parent ?? output?.parent;
      const parentChanged =
        news.parent !== undefined &&
        previousParent !== undefined &&
        news.parent !== previousParent;
      if (!idChanged && !locationChanged && !parentChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = normalizeParent(
        env.project,
        olds?.parent ?? output?.parent,
      );
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const bucketId = yield* toPhysicalId(
        id,
        olds?.bucketId,
        output?.bucketId,
        "b",
      );
      const name = output?.name ?? resourceName(parent, location, bucketId);
      const existing = yield* getByName(name);
      if (isDeletedBucket(existing)) return undefined;
      const attrs = toAttrs(existing, parent, location);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedBy(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* logging.listLocationsBuckets
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.buckets ?? [])),
            Stream.filter(
              (bucket) =>
                !isDeletedBucket(bucket) &&
                hasOwnershipMarker(bucket.description),
            ),
            Stream.map((bucket) =>
              toAttrs(
                bucket,
                parseLoggingName(bucket.name ?? "").parent ||
                  `projects/${env.project}`,
                parseLoggingName(bucket.name ?? "").location ??
                  DEFAULT_LOCATION,
              ),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = normalizeParent(
        env.project,
        news.parent ?? output?.parent,
      );
      const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
      const bucketId = yield* toPhysicalId(
        id,
        news.bucketId,
        output?.bucketId,
        "b",
      );
      const name = resourceName(parent, location, bucketId);
      const ownership = yield* createOwnership(id);
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
          .createLocationsBuckets({
            parent: locationParent(parent, location),
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
        } else if (
          current !== undefined &&
          isPendingBucket(current.lifecycleState)
        ) {
          current = yield* waitUntilActive(current.name ?? name);
        }
      }

      if (isDeletedBucket(current)) {
        return yield* new LocationsBucketNotResolved({ name });
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
        current = yield* logging.patchLocationsBuckets({
          name: current.name ?? name,
          updateMask: syncMask.join(","),
          body,
        });
        if (isPendingBucket(current.lifecycleState)) {
          current = yield* waitUntilActive(current.name ?? name);
        }
      }

      if (lockedChanged) {
        current = yield* logging.patchLocationsBuckets({
          name: current.name ?? name,
          updateMask: "locked",
          body: { locked: true },
        });
        if (isPendingBucket(current.lifecycleState)) {
          current = yield* waitUntilActive(current.name ?? name);
        }
      }

      return toAttrs(current, parent, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.lifecycleState === "DELETE_REQUESTED") return;
      yield* logging.deleteLocationsBuckets({ name: output.name }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.retry({
          while: (error) =>
            error._tag === "BadRequest" || error._tag === "Conflict",
          times: 10,
          schedule: Schedule.spaced("3 seconds"),
        }),
      );
      yield* waitUntilDeleted(output.name);
    }),
  });
