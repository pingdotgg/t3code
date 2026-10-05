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
  scopeParent,
  toPhysicalId,
  type LogBucketIndexConfig,
} from "./internal.ts";

export type FolderBucketIndexConfig = LogBucketIndexConfig;

export type FolderBucketCmekSettings = {
  /**
   * Cloud KMS key used to encrypt new log entries
   * (`projects/{project}/locations/{location}/keyRings/{ring}/cryptoKeys/{key}`).
   * Once set, CMEK cannot be disabled; the key may be rotated.
   */
  kmsKeyName: string;
};

export type FolderBucketProps = {
  /**
   * Folder id (`folders/{folder}` or the numeric id). When omitted, the
   * stack project is used so the same distilled folder-location APIs can
   * manage project buckets. Immutable — changing it replaces the bucket.
   */
  folderId?: string;
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
  indexConfigs?: FolderBucketIndexConfig[];
  /**
   * Customer-managed encryption for new log entries. Once configured,
   * CMEK cannot be disabled.
   */
  cmekSettings?: FolderBucketCmekSettings;
};

export type FolderBucket = Resource<
  "GCP.Logging.FolderBucket",
  FolderBucketProps,
  {
    /** Full resource name `{parent}/locations/{location}/buckets/{bucketId}`. */
    name: string;
    /** Bucket id (last path segment). */
    bucketId: string;
    /** Parent resource (`folders/{folder}` or `projects/{project}`). */
    parent: string;
    /** Folder id when the parent is a folder. */
    folderId: string | undefined;
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
    indexConfigs: FolderBucketIndexConfig[];
    /** CMEK key name, if configured. */
    cmekSettings: FolderBucketCmekSettings | undefined;
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
 * A Cloud Logging log bucket owned by a folder (or the stack project).
 *
 * Uses the folder-location Logging APIs (`createFoldersLocationsBuckets`
 * and siblings). Log buckets have no labels field, so Alchemy stamps
 * ownership into the description for `list` / nuke. `folderId`, `bucketId`,
 * and `location` are identity — changing any of them replaces the bucket.
 * Delete marks the bucket `DELETE_REQUESTED`; GCP purges it after 7 days.
 *
 * ### Creating a Folder Bucket
 * **Example:** Generated name in `global` on the stack project
 * ```typescript
 * const bucket = yield* GCP.Logging.FolderBucket("AppLogs", {
 *   description: "application logs",
 * });
 * ```
 *
 * **Example:** Named bucket on a folder
 * ```typescript
 * const bucket = yield* GCP.Logging.FolderBucket("AppLogs", {
 *   folderId: "123456789",
 *   bucketId: "app-logs",
 *   location: "global",
 *   description: "application logs",
 *   retentionDays: 31,
 * });
 * ```
 *
 * ### Updating a Folder Bucket
 * **Example:** Change description and retention
 * ```typescript
 * const bucket = yield* GCP.Logging.FolderBucket("AppLogs", {
 *   location: "global",
 *   description: "retained application logs",
 *   retentionDays: 60,
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const FolderBucket = Resource<FolderBucket>("GCP.Logging.FolderBucket");

export class FolderBucketNotResolved extends Data.TaggedError(
  "GCP.Logging.FolderBucketNotResolved",
)<{
  name: string;
}> {}

export class FolderBucketFailed extends Data.TaggedError(
  "GCP.Logging.FolderBucketFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

const resourceName = (parent: string, location: string, bucketId: string) =>
  `${locationParent(parent, location)}/buckets/${bucketId}`;

const folderIdOf = (parent: string) =>
  parent.startsWith("folders/") ? lastSegment(parent) : undefined;

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
    folderId: folderIdOf(resolvedParent),
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
    .getFoldersLocationsBuckets({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const undelete = (name: string) =>
  logging
    .undeleteFoldersLocationsBuckets({ name, body: {} })
    .pipe(Effect.catchTag(["NotFound", "Conflict"], () => Effect.void));

const waitUntilActive = (name: string) =>
  Effect.gen(function* () {
    const bucket = yield* getByName(name);
    if (bucket === undefined || isDeletedBucket(bucket)) {
      return yield* new FolderBucketNotResolved({ name });
    }
    if (bucket.lifecycleState === "FAILED") {
      return yield* new FolderBucketFailed({
        name,
        state: bucket.lifecycleState,
      });
    }
    if (isPendingBucket(bucket.lifecycleState)) {
      return yield* new FolderBucketNotResolved({ name });
    }
    return bucket;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.Logging.FolderBucketNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilDeleted = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((bucket) =>
      isDeletedBucket(bucket)
        ? Effect.void
        : Effect.fail(new FolderBucketNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Logging.FolderBucketNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const toCreateBody = (
  props: FolderBucketProps,
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

export const FolderBucketProvider = () =>
  Provider.succeed(FolderBucket, {
    stables: [
      "name",
      "bucketId",
      "parent",
      "folderId",
      "location",
      "createTime",
    ],

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
      const previousFolder = olds?.folderId ?? output?.folderId;
      const folderChanged =
        news.folderId !== undefined && news.folderId !== previousFolder;
      if (!idChanged && !locationChanged && !folderChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = scopeParent(
        env.project,
        olds?.folderId ?? output?.folderId,
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
        return yield* logging.listFoldersLocationsBuckets
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
      const parent = scopeParent(
        env.project,
        news.folderId ?? output?.folderId,
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
          .createFoldersLocationsBuckets({
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
        return yield* new FolderBucketNotResolved({ name });
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
        current = yield* logging.patchFoldersLocationsBuckets({
          name: current.name ?? name,
          updateMask: syncMask.join(","),
          body,
        });
        if (isPendingBucket(current.lifecycleState)) {
          current = yield* waitUntilActive(current.name ?? name);
        }
      }

      if (lockedChanged) {
        current = yield* logging.patchFoldersLocationsBuckets({
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
      yield* logging.deleteFoldersLocationsBuckets({ name: output.name }).pipe(
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
