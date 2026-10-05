import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForDeleteOperation } from "./operations.ts";

const MAX_NAME_LENGTH = 100;
const DEFAULT_LOCATION = "global";
const DEFAULT_RETENTION_DAYS = 30;

export interface LogBucketIndexConfig {
  /**
   * LogEntry field path to index (e.g. `jsonPayload.request.status`).
   */
  fieldPath: string;
  /**
   * Indexed value type.
   */
  type: "INDEX_TYPE_STRING" | "INDEX_TYPE_INTEGER";
}

export interface LogBucketCmekSettings {
  /**
   * Cloud KMS key used to encrypt new log entries
   * (`projects/{project}/locations/{location}/keyRings/{ring}/cryptoKeys/{key}`).
   * Once set, CMEK cannot be disabled; the key may be rotated.
   */
  kmsKeyName: string;
}

export type LogBucketProps = {
  /**
   * Bucket id (the `{bucket}` segment of
   * `projects/{project}/locations/{location}/buckets/{bucket}`). If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   * Limited to 100 characters: letters, digits, underscores, hyphens,
   * periods; first character must be alphanumeric. Immutable — changing
   * it replaces the bucket.
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
  indexConfigs?: LogBucketIndexConfig[];
  /**
   * Customer-managed encryption for new log entries. Once configured,
   * CMEK cannot be disabled.
   */
  cmekSettings?: LogBucketCmekSettings;
};

export type LogBucket = Resource<
  "GCP.Logging.LogBucket",
  LogBucketProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/buckets/{bucketId}`. */
    name: string;
    /** Bucket id (last path segment). */
    bucketId: string;
    /** Project id. */
    project: string;
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
    indexConfigs: LogBucketIndexConfig[];
    /** CMEK key name, if configured. */
    cmekSettings: LogBucketCmekSettings | undefined;
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
 * A Cloud Logging log bucket that stores log entries in a location.
 *
 * Log buckets have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. `bucketId` and `location` are identity —
 * changing either replaces the bucket. Delete marks the bucket
 * `DELETE_REQUESTED`; GCP purges it after 7 days. Reconcile undeletes a
 * bucket still in that grace period so the same name can be reused.
 *
 * ### Creating a Log Bucket
 * **Example:** Generated name in `global`
 * ```typescript
 * const bucket = yield* GCP.Logging.LogBucket("AppLogs", {
 *   description: "application logs",
 * });
 * ```
 *
 * **Example:** Named bucket with custom retention
 * ```typescript
 * const bucket = yield* GCP.Logging.LogBucket("AppLogs", {
 *   bucketId: "app-logs",
 *   location: "global",
 *   description: "application logs",
 *   retentionDays: 31,
 * });
 * ```
 *
 * ### Updating a Log Bucket
 * **Example:** Change description and retention
 * ```typescript
 * const bucket = yield* GCP.Logging.LogBucket("AppLogs", {
 *   location: "global",
 *   description: "retained application logs",
 *   retentionDays: 60,
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const LogBucket = Resource<LogBucket>("GCP.Logging.LogBucket");

export class LogBucketNotResolved extends Data.TaggedError(
  "GCP.Logging.LogBucketNotResolved",
)<{
  name: string;
}> {}

export class LogBucketFailed extends Data.TaggedError(
  "GCP.Logging.LogBucketFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const resourceName = (project: string, location: string, bucketId: string) =>
  `projects/${project}/locations/${location}/buckets/${bucketId}`;

const parseBucketName = (name: string) => {
  const match = name.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)$/,
  );
  if (!match) return undefined;
  return { project: match[1]!, location: match[2]!, bucketId: match[3]! };
};

const bucketIdOf = (bucket: logging.LogBucket, fallback?: string) => {
  const parsed = parseBucketName(bucket.name ?? "");
  return parsed?.bucketId ?? fallback ?? lastSegment(bucket.name ?? "");
};

const locationOf = (bucket: logging.LogBucket, fallback: string) => {
  const parsed = parseBucketName(bucket.name ?? "");
  return parsed?.location ?? fallback;
};

const toId = (id: string, bucketId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (bucketId !== undefined) return bucketId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z0-9]/.test(generated)
      ? generated
      : `b${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const isDeleted = (
  bucket: logging.LogBucket | undefined,
): bucket is undefined =>
  bucket === undefined || bucket.lifecycleState === "DELETE_REQUESTED";

const isPending = (state: string | undefined) =>
  state === "CREATING" || state === "UPDATING";

const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const canonRestricted = (fields: readonly string[] | undefined) =>
  [...(fields ?? [])].slice().sort();

const canonIndexConfigs = (
  configs:
    | readonly logging.IndexConfig[]
    | readonly LogBucketIndexConfig[]
    | undefined,
): LogBucketIndexConfig[] =>
  [...(configs ?? [])]
    .flatMap((config) =>
      config.fieldPath
        ? [
            {
              fieldPath: config.fieldPath,
              type: (config.type ??
                "INDEX_TYPE_STRING") as LogBucketIndexConfig["type"],
            },
          ]
        : [],
    )
    .sort((left, right) => left.fieldPath.localeCompare(right.fieldPath));

const toAttrs = (
  bucket: logging.LogBucket,
  project: string,
  location: string,
) => {
  const bucketId = bucketIdOf(bucket);
  const resolvedLocation = locationOf(bucket, location);
  const parsed = parseDescription(bucket.description);
  const cmekKey = bucket.cmekSettings?.kmsKeyName;
  return {
    name:
      bucket.name ??
      (bucketId ? resourceName(project, resolvedLocation, bucketId) : ""),
    bucketId,
    project,
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
    .getProjectsLocationsBuckets({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const undelete = (name: string) =>
  logging
    .undeleteProjectsLocationsBuckets({ name, body: {} })
    .pipe(Effect.catchTag(["NotFound", "Conflict"], () => Effect.void));

const waitUntilActive = (name: string) =>
  Effect.gen(function* () {
    const bucket = yield* getByName(name);
    if (bucket === undefined || isDeleted(bucket)) {
      return yield* new LogBucketNotResolved({ name });
    }
    if (bucket.lifecycleState === "FAILED") {
      return yield* new LogBucketFailed({
        name,
        state: bucket.lifecycleState,
      });
    }
    if (isPending(bucket.lifecycleState)) {
      return yield* new LogBucketNotResolved({ name });
    }
    return bucket;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.Logging.LogBucketNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilDeleted = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((bucket) =>
      isDeleted(bucket)
        ? Effect.void
        : Effect.fail(new LogBucketNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Logging.LogBucketNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const toCreateBody = (
  props: LogBucketProps,
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

export const LogBucketProvider = () =>
  Provider.succeed(LogBucket, {
    stables: ["name", "bucketId", "project", "location", "createTime"],

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
      if (!idChanged && !locationChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const bucketId = yield* toId(id, olds?.bucketId, output?.bucketId);
      const name =
        output?.name ?? resourceName(env.project, location, bucketId);
      const existing = yield* getByName(name);
      if (isDeleted(existing)) return undefined;
      const attrs = toAttrs(existing, env.project, location);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* logging.listProjectsLocationsBuckets
          .pages({
            parent: `projects/${env.project}/locations/-`,
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
                env.project,
                locationOf(bucket, DEFAULT_LOCATION),
              ),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
      const bucketId = yield* toId(id, news.bucketId, output?.bucketId);
      const name = resourceName(env.project, location, bucketId);
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
          .createProjectsLocationsBuckets({
            parent: `projects/${env.project}/locations/${location}`,
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
        return yield* new LogBucketNotResolved({ name });
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
        current = yield* logging.patchProjectsLocationsBuckets({
          name: current.name ?? name,
          updateMask: syncMask.join(","),
          body,
        });
        if (isPending(current.lifecycleState)) {
          current = yield* waitUntilActive(current.name ?? name);
        }
      }

      if (lockedChanged) {
        current = yield* logging.patchProjectsLocationsBuckets({
          name: current.name ?? name,
          updateMask: "locked",
          body: { locked: true },
        });
        if (isPending(current.lifecycleState)) {
          current = yield* waitUntilActive(current.name ?? name);
        }
      }

      return toAttrs(current, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (!name) return;

      yield* getByName(name).pipe(
        Effect.flatMap((bucket) => {
          if (isDeleted(bucket)) return Effect.void;
          if (bucket !== undefined && isPending(bucket.lifecycleState)) {
            return Effect.fail(new LogBucketNotResolved({ name }));
          }
          return Effect.void;
        }),
        Effect.retry({
          while: (error) => error._tag === "GCP.Logging.LogBucketNotResolved",
          times: 10,
          schedule: Schedule.spaced("2 seconds"),
        }),
      );

      const live = yield* getByName(name);
      if (isDeleted(live)) return;

      const ignoreIfGone = (error: { readonly _tag: "BadRequest" }) =>
        getByName(name).pipe(
          Effect.flatMap((bucket) =>
            isDeleted(bucket) ? Effect.void : Effect.fail(error),
          ),
        );

      const deleteBucket = logging
        .deleteProjectsLocationsBuckets({ name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("BadRequest", ignoreIfGone),
        );

      yield* deleteBucket.pipe(
        Effect.catchTag("BadRequest", () =>
          Effect.gen(function* () {
            const links = yield* logging.listProjectsLocationsBucketsLinks
              .pages({
                parent: name,
                pageSize: 100,
              })
              .pipe(
                Stream.flatMap((page) => Stream.fromIterable(page.links ?? [])),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () =>
                  Effect.succeed([] as logging.Link[]),
                ),
              );
            yield* Effect.forEach(
              links,
              (link) =>
                link.name
                  ? logging
                      .deleteProjectsLocationsBucketsLinks({
                        name: link.name,
                      })
                      .pipe(
                        Effect.flatMap((operation) =>
                          waitForDeleteOperation(operation),
                        ),
                        Effect.catchTag(
                          ["NotFound", "BadRequest"],
                          () => Effect.void,
                        ),
                      )
                  : Effect.void,
              { concurrency: 4 },
            );
            yield* deleteBucket.pipe(
              Effect.retry({
                while: (error) => error._tag === "BadRequest",
                times: 8,
                schedule: Schedule.spaced("2 seconds"),
              }),
              Effect.catchTag("BadRequest", ignoreIfGone),
            );
          }),
        ),
      );
      yield* waitUntilDeleted(name);
    }),
  });
