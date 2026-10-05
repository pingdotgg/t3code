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
  encodeDescription,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  organizationIdOf,
  parseDescription,
  resolveOrganization,
  toPhysicalId,
  tryResolveOrganization,
} from "./internal.ts";

export type OrganizationLogBucketProps = {
  /**
   * Bucket id (the `{bucket}` segment of
   * `organizations/{organization}/locations/{location}/buckets/{bucket}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Limited to 100 characters: letters, digits, underscores,
   * hyphens, periods; first character must be alphanumeric. Immutable —
   * changing it replaces the bucket.
   */
  bucketId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to the project ancestor organization. Immutable —
   * changing it replaces the bucket.
   */
  organization?: string;
  /**
   * Location that stores log entries. `global` leaves placement
   * unspecified. Immutable after create — changing it replaces the
   * bucket.
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
   * Days to retain log entries before they are deleted. Minimum 1. `0`
   * at create uses the GCP default of 30. Cannot be changed while the
   * bucket is locked.
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

export type OrganizationLogBucket = Resource<
  "GCP.Logging.OrganizationLogBucket",
  OrganizationLogBucketProps,
  {
    /** Full resource name `organizations/{organization}/locations/{location}/buckets/{bucketId}`. */
    name: string;
    /** Bucket id (last path segment). */
    bucketId: string;
    /** Organization resource name `organizations/{organization}`. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Project id of the deploying stack. */
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
 * A Cloud Logging log bucket on an organization.
 *
 * Log buckets have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. `bucketId`, `location`, and organization
 * are identity — changing any replaces the bucket. Delete marks the
 * bucket `DELETE_REQUESTED`; GCP purges it after 7 days. Reconcile
 * undeletes a bucket still in that grace period so the same name can be
 * reused.
 *
 * ### Creating an Organization Log Bucket
 * **Example:** Generated name in `global`
 * ```typescript
 * const bucket = yield* GCP.Logging.OrganizationLogBucket("AppLogs", {
 *   description: "organization application logs",
 * });
 * ```
 *
 * **Example:** Named bucket with custom retention
 * ```typescript
 * const bucket = yield* GCP.Logging.OrganizationLogBucket("AppLogs", {
 *   organization: "organizations/123456789",
 *   bucketId: "app-logs",
 *   location: "global",
 *   description: "application logs",
 *   retentionDays: 31,
 * });
 * ```
 *
 * ### Updating an Organization Log Bucket
 * **Example:** Change description and retention
 * ```typescript
 * const bucket = yield* GCP.Logging.OrganizationLogBucket("AppLogs", {
 *   location: "global",
 *   organization: "organizations/123456789",
 *   description: "retained application logs",
 *   retentionDays: 60,
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const OrganizationLogBucket = Resource<OrganizationLogBucket>(
  "GCP.Logging.OrganizationLogBucket",
);

export class OrganizationLogBucketNotResolved extends Data.TaggedError(
  "GCP.Logging.OrganizationLogBucketNotResolved",
)<{
  name: string;
}> {}

export class OrganizationLogBucketFailed extends Data.TaggedError(
  "GCP.Logging.OrganizationLogBucketFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

const resourceName = (
  organization: string,
  location: string,
  bucketId: string,
) => `${organization}/locations/${location}/buckets/${bucketId}`;

const parseBucketName = (name: string) => {
  const match = name.match(
    /^(organizations\/[^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    organization: match[1]!,
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

const organizationOf = (bucket: logging.LogBucket, fallback: string) => {
  const parsed = parseBucketName(bucket.name ?? "");
  return parsed?.organization ?? fallback;
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
  organization: string,
  project: string,
  location: string,
) => {
  const bucketId = bucketIdOf(bucket);
  const resolvedLocation = locationOf(bucket, location);
  const resolvedOrg = organizationOf(bucket, organization);
  const parsed = parseDescription(bucket.description);
  const cmekKey = bucket.cmekSettings?.kmsKeyName;
  return {
    name:
      bucket.name ??
      (bucketId ? resourceName(resolvedOrg, resolvedLocation, bucketId) : ""),
    bucketId,
    organization: resolvedOrg,
    organizationId: organizationIdOf(resolvedOrg),
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
    .getOrganizationsLocationsBuckets({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const undelete = (name: string) =>
  logging
    .undeleteOrganizationsLocationsBuckets({ name, body: {} })
    .pipe(Effect.catchTag(["NotFound", "Conflict"], () => Effect.void));

const waitUntilActive = (name: string) =>
  Effect.gen(function* () {
    const bucket = yield* getByName(name);
    if (bucket === undefined || isDeleted(bucket)) {
      return yield* new OrganizationLogBucketNotResolved({ name });
    }
    if (bucket.lifecycleState === "FAILED") {
      return yield* new OrganizationLogBucketFailed({
        name,
        state: bucket.lifecycleState,
      });
    }
    if (isPending(bucket.lifecycleState)) {
      return yield* new OrganizationLogBucketNotResolved({ name });
    }
    return bucket;
  }).pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Logging.OrganizationLogBucketNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilDeleted = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((bucket) =>
      isDeleted(bucket)
        ? Effect.void
        : Effect.fail(new OrganizationLogBucketNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Logging.OrganizationLogBucketNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const toCreateBody = (
  props: OrganizationLogBucketProps,
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

export const OrganizationLogBucketProvider = () =>
  Provider.succeed(OrganizationLogBucket, {
    stables: [
      "name",
      "bucketId",
      "organization",
      "organizationId",
      "project",
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
      const previousOrg = olds?.organization ?? output?.organization;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        news.organization !== previousOrg;
      if (!idChanged && !locationChanged && !orgChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const bucketId = yield* toPhysicalId(
        id,
        olds?.bucketId,
        output?.bucketId,
        "b",
      );
      const name =
        output?.name ?? resourceName(organization, location, bucketId);
      const existing = yield* getByName(name);
      if (isDeleted(existing)) return undefined;
      const attrs = toAttrs(existing, organization, env.project, location);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        return yield* logging.listOrganizationsLocationsBuckets
          .pages({
            parent: `${organization}/locations/-`,
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
                organizationOf(bucket, organization),
                env.project,
                locationOf(bucket, DEFAULT_LOCATION),
              ),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
      const bucketId = yield* toPhysicalId(
        id,
        news.bucketId,
        output?.bucketId,
        "b",
      );
      const name = resourceName(organization, location, bucketId);
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
          .createOrganizationsLocationsBuckets({
            parent: `${organization}/locations/${location}`,
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
        return yield* new OrganizationLogBucketNotResolved({ name });
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
        current = yield* logging.patchOrganizationsLocationsBuckets({
          name: current.name ?? name,
          updateMask: syncMask.join(","),
          body,
        });
        if (isPending(current.lifecycleState)) {
          current = yield* waitUntilActive(current.name ?? name);
        }
      }

      if (lockedChanged) {
        current = yield* logging.patchOrganizationsLocationsBuckets({
          name: current.name ?? name,
          updateMask: "locked",
          body: { locked: true },
        });
        if (isPending(current.lifecycleState)) {
          current = yield* waitUntilActive(current.name ?? name);
        }
      }

      return toAttrs(current, organization, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.lifecycleState === "DELETE_REQUESTED") return;
      yield* logging
        .deleteOrganizationsLocationsBuckets({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilDeleted(output.name);
    }),
  });
