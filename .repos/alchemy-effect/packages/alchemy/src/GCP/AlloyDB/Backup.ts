import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import type { EncryptionConfig } from "./Cluster.ts";
import { waitForDeleteOperation, waitForOperation } from "./operations.ts";

const DEFAULT_BACKUP_TYPE = "ON_DEMAND";
const MAX_NAME_LENGTH = 63;

export type BackupProps = {
  /**
   * Source cluster id or full resource name
   * (`projects/{project}/locations/{location}/clusters/{cluster}`).
   * Immutable — changing it replaces the backup.
   */
  clusterName: string;
  /**
   * Region of the backup (`us-central1`, …). Ignored when
   * `clusterName` is a full resource name unless set explicitly.
   * Immutable — changing it replaces the backup. `US-CENTRAL1` is
   * accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Backup id (the `{backup}` segment of
   * `projects/{project}/locations/{location}/backups/{backup}`). If
   * omitted, a unique RFC1035 name is generated. Must match
   * `[a-z]([a-z0-9-]{0,61}[a-z0-9])?`. Immutable — changing it
   * replaces the backup.
   */
  backupId?: string;
  /**
   * User-facing display name.
   */
  displayName?: string;
  /**
   * User-provided description. Changing it replaces the backup.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Arbitrary client annotations (distinct from labels).
   */
  annotations?: Record<string, string>;
  /**
   * Backup type. User-created backups are `ON_DEMAND`. Immutable.
   * @default "ON_DEMAND"
   */
  type?: alloydb.BackupTypeEnum | (string & {});
  /**
   * Customer-managed encryption. Immutable — changing it replaces the
   * backup.
   */
  encryptionConfig?: EncryptionConfig;
  /**
   * Resource Manager tags bound at create time. Immutable.
   */
  tags?: Record<string, string>;
};

export type Backup = Resource<
  "GCP.AlloyDB.Backup",
  BackupProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/backups/{backup}`. */
    name: string;
    /** Backup id (last path segment). */
    backupId: string;
    /** Source cluster resource name. */
    clusterName: string;
    /** Source cluster id. */
    clusterId: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    location: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Client annotations. */
    annotations: Record<string, string>;
    /** Serving state (`READY`, `CREATING`, `FAILED`, …). */
    state: string | undefined;
    /** Backup type (`ON_DEMAND`, `AUTOMATED`, `CONTINUOUS`). */
    type: string;
    /** Size in bytes, as a decimal string. */
    sizeBytes: string | undefined;
    /** Customer-managed encryption, if any. */
    encryptionConfig: EncryptionConfig | undefined;
    /** Database engine major version of the source cluster. */
    databaseVersion: string | undefined;
    /** System-generated UID of the source cluster. */
    clusterUid: string | undefined;
    /** System-generated UID of the backup. */
    uid: string | undefined;
    /** Whether the service is reconciling intended vs actual state. */
    reconciling: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 time when creation finished. */
    createCompletionTime: string | undefined;
    /** RFC3339 time after which the backup may be garbage collected. */
    expiryTime: string | undefined;
    /** HTTP etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * An on-demand AlloyDB backup of a cluster.
 *
 * Changing `backupId`, `location`, `clusterName`, `type`,
 * `encryptionConfig`, `tags`, or `description` replaces the backup.
 * `displayName`, `labels`, and `annotations` update in place.
 *
 * Creating a backup typically takes several minutes and is skipIf-gated
 * in live tests behind `GCP_TEST_ALLOYDB`.
 *
 * ### Creating a Backup
 * **Example:** On-demand backup of a cluster
 * ```typescript
 * const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
 *   pscConfig: { pscEnabled: true },
 *   automatedBackupPolicy: { enabled: false },
 *   continuousBackupConfig: { enabled: false },
 * });
 * const backup = yield* GCP.AlloyDB.Backup("Nightly", {
 *   clusterName: cluster.name,
 *   displayName: "nightly",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Explicit id and description
 * ```typescript
 * const backup = yield* GCP.AlloyDB.Backup("Nightly", {
 *   clusterName: cluster.name,
 *   backupId: "app-db-nightly",
 *   displayName: "app-db-nightly",
 *   description: "manual snapshot",
 * });
 * ```
 *
 * @resource
 * @category AlloyDB
 */
export const Backup = Resource<Backup>("GCP.AlloyDB.Backup");

export class BackupNotResolved extends Data.TaggedError(
  "GCP.AlloyDB.BackupNotResolved",
)<{
  name: string;
}> {}

export class BackupClusterMissing extends Data.TaggedError(
  "GCP.AlloyDB.BackupClusterMissing",
)<{
  message: string;
}> {}

export class BackupNotReady extends Data.TaggedError(
  "GCP.AlloyDB.BackupNotReady",
)<{
  name: string;
  state: string;
}> {}

export class BackupFailed extends Data.TaggedError("GCP.AlloyDB.BackupFailed")<{
  name: string;
  state: string;
}> {}

export class BackupStillExists extends Data.TaggedError(
  "GCP.AlloyDB.BackupStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string) =>
  lastSegment(location).toLowerCase();

const normalizeType = (type: string | undefined) => {
  const value = (type ?? DEFAULT_BACKUP_TYPE).toUpperCase();
  return value === "TYPE_UNSPECIFIED" ? DEFAULT_BACKUP_TYPE : value;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `b${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "backup";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const resourceName = (project: string, location: string, backupId: string) =>
  `projects/${project}/locations/${location}/backups/${backupId}`;

const clusterNameOf = (project: string, location: string, clusterId: string) =>
  `projects/${project}/locations/${location}/clusters/${clusterId}`;

const parseBackupName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const backupsAt = parts.lastIndexOf("backups");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    backupId:
      backupsAt >= 0 && parts[backupsAt + 1]
        ? parts[backupsAt + 1]!
        : lastSegment(name),
  };
};

const parseClusterRef = (
  cluster: string,
  fallbackProject: string,
  fallbackLocation: string,
) => {
  const trimmed = cluster.trim();
  if (trimmed.length === 0) {
    return {
      project: fallbackProject,
      location: normalizeLocation(fallbackLocation),
      clusterId: "",
      clusterName: "",
    };
  }
  if (trimmed.includes("/clusters/") || trimmed.includes("projects/")) {
    const parts = trimmed.split("/").filter((part) => part.length > 0);
    const clustersAt = parts.lastIndexOf("clusters");
    const locationsAt = parts.lastIndexOf("locations");
    const projectsAt = parts.lastIndexOf("projects");
    const clusterId =
      clustersAt >= 0 && parts[clustersAt + 1] ? parts[clustersAt + 1]! : "";
    const project =
      projectsAt >= 0 && parts[projectsAt + 1]
        ? parts[projectsAt + 1]!
        : fallbackProject;
    const location = normalizeLocation(
      (locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]
        : undefined) ?? fallbackLocation,
    );
    return {
      project,
      location,
      clusterId,
      clusterName: clusterNameOf(project, location, clusterId),
    };
  }
  const location = normalizeLocation(fallbackLocation);
  const clusterId = lastSegment(trimmed);
  return {
    project: fallbackProject,
    location,
    clusterId,
    clusterName: clusterNameOf(fallbackProject, location, clusterId),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const stringMapOf = (
  map: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[1].length > 0,
    ),
  );

const toId = (id: string, backupId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      backupId ??
      existing ??
      rfc1035(
        yield* createPhysicalName({
          id,
          maxLength: MAX_NAME_LENGTH,
          lowercase: true,
        }),
      )
    );
  });

const fingerprint = (value: unknown): string => JSON.stringify(value ?? null);

const toEncryptionConfig = (
  config: alloydb.EncryptionConfig | EncryptionConfig | undefined,
): EncryptionConfig | undefined => {
  const kmsKeyName = config?.kmsKeyName;
  if (kmsKeyName === undefined || kmsKeyName.length === 0) return undefined;
  return { kmsKeyName };
};

const isAvailable = (state: string | undefined) =>
  (state ?? "").toUpperCase() === "READY";

const isFailed = (state: string | undefined) =>
  (state ?? "").toUpperCase() === "FAILED";

const toAttrs = (backup: alloydb.Backup, project: string) => {
  const name = backup.name ?? "";
  const parsed = parseBackupName(name);
  const clusterRef = parseClusterRef(
    backup.clusterName ?? "",
    parsed.project || project,
    parsed.location,
  );
  return {
    name,
    backupId: parsed.backupId,
    clusterName: backup.clusterName ?? clusterRef.clusterName,
    clusterId: clusterRef.clusterId,
    project: parsed.project || project,
    location: parsed.location,
    displayName: backup.displayName,
    description: backup.description,
    labels: userLabels(backup.labels),
    annotations: stringMapOf(backup.annotations),
    state: backup.state,
    type: normalizeType(backup.type),
    sizeBytes: backup.sizeBytes,
    encryptionConfig: toEncryptionConfig(backup.encryptionConfig),
    databaseVersion: backup.databaseVersion,
    clusterUid: backup.clusterUid,
    uid: backup.uid,
    reconciling: backup.reconciling === true,
    createTime: backup.createTime,
    updateTime: backup.updateTime,
    createCompletionTime: backup.createCompletionTime,
    expiryTime: backup.expiryTime,
    etag: backup.etag,
  };
};

const isPlaceholder = (backup: alloydb.Backup) => {
  const name = backup.name ?? "";
  return name.endsWith("/backups/-") || name.endsWith("/backups/");
};

const getByName = (name: string) =>
  alloydb
    .getProjectsLocationsBackups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((backup) =>
      backup
        ? Effect.succeed(backup)
        : Effect.fail(new BackupNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AlloyDB.BackupNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilReady = (name: string) =>
  Effect.gen(function* () {
    const backup = yield* getByName(name);
    if (backup === undefined) {
      return yield* new BackupNotReady({ name, state: "MISSING" });
    }
    if (isFailed(backup.state)) {
      return yield* new BackupFailed({
        name,
        state: backup.state ?? "FAILED",
      });
    }
    if (!(isAvailable(backup.state) && backup.reconciling !== true)) {
      return yield* new BackupNotReady({
        name,
        state: backup.state ?? "STATE_UNSPECIFIED",
      });
    }
    return backup;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.AlloyDB.BackupNotReady",
      times: 120,
      schedule: Schedule.spaced("15 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((backup) =>
      backup === undefined
        ? Effect.void
        : Effect.fail(new BackupStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AlloyDB.BackupStillExists",
      times: 120,
      schedule: Schedule.spaced("15 seconds"),
    }),
  );

const toCreateBody = (
  news: BackupProps,
  desiredLabels: Record<string, string>,
  clusterName: string,
  backupType: string,
): alloydb.Backup => {
  const body: alloydb.Backup = {
    clusterName,
    type: backupType,
    displayName: news.displayName,
    labels: desiredLabels,
  };
  if (news.description !== undefined) {
    body.description = news.description;
  }
  if (news.annotations !== undefined) {
    body.annotations = news.annotations;
  }
  const encryption = toEncryptionConfig(news.encryptionConfig);
  if (encryption !== undefined) {
    body.encryptionConfig = encryption;
  }
  if (news.tags !== undefined) {
    body.tags = news.tags;
  }
  return body;
};

export const BackupProvider = () =>
  Provider.succeed(Backup, {
    stables: [
      "name",
      "backupId",
      "clusterName",
      "clusterId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.backupId ?? output?.backupId;
      const nextId = news.backupId ?? previousId;
      const previousCluster = lastSegment(
        olds?.clusterName ?? output?.clusterName ?? output?.clusterId,
      );
      const nextCluster = lastSegment(news.clusterName ?? previousCluster);
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const previousType = normalizeType(olds?.type ?? output?.type);
      const nextType = normalizeType(news.type ?? output?.type);
      const previousKey =
        olds?.encryptionConfig?.kmsKeyName ??
        output?.encryptionConfig?.kmsKeyName ??
        "";
      const nextKey = news.encryptionConfig?.kmsKeyName ?? previousKey;
      const previousTags = fingerprint(olds?.tags ?? undefined);
      const nextTags = fingerprint(news.tags ?? olds?.tags ?? undefined);

      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        (previousCluster.length > 0 &&
          nextCluster.length > 0 &&
          previousCluster !== nextCluster) ||
        previousLocation !== nextLocation ||
        previousType !== nextType ||
        previousKey !== nextKey ||
        (news.tags !== undefined && previousTags !== nextTags) ||
        // PATCH accepts `description` but leaves it unchanged (observed live),
        // so a new description replaces the backup.
        (olds !== undefined &&
          (news.description ?? "") !== (olds.description ?? ""));

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousCluster === nextCluster &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (output?.name) {
        const existing = yield* getByName(output.name);
        if (existing === undefined) return undefined;
        const attrs = toAttrs(existing, env.project);
        return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
          ? attrs
          : Unowned(attrs);
      }
      const backupId = yield* toId(id, olds?.backupId, output?.backupId);
      const ref = parseClusterRef(
        olds?.clusterName ?? output?.clusterName ?? output?.clusterId ?? "",
        env.project,
        olds?.location ?? output?.location ?? env.region,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? ref.location,
      );
      const name = resourceName(env.project, location, backupId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* alloydb.listProjectsLocationsBackups
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.backups ?? [])),
            Stream.filter(
              (backup) =>
                !isPlaceholder(backup) &&
                Object.keys(backup.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
            ),
            Stream.map((backup) => toAttrs(backup, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const backupId = yield* toId(id, news.backupId, output?.backupId);
      const ref = parseClusterRef(
        news.clusterName,
        env.project,
        news.location ?? output?.location ?? env.region,
      );
      if (ref.clusterId.length === 0) {
        return yield* new BackupClusterMissing({
          message:
            "GCP.AlloyDB.Backup requires `clusterName` (cluster id or full resource name)",
        });
      }
      const location = normalizeLocation(news.location ?? ref.location);
      const name = resourceName(env.project, location, backupId);
      const backupType = normalizeType(news.type);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const parent = `projects/${env.project}/locations/${location}`;
        const created = yield* alloydb
          .createProjectsLocationsBackups({
            parent,
            backupId,
            body: toCreateBody(
              news,
              desiredLabels,
              ref.clusterName,
              backupType,
            ),
          })
          .pipe(
            // The cluster only accepts backups a few minutes after its
            // primary instance is created.
            Effect.retry({
              while: (error) => error._tag === "ClusterNotReadyForBackup",
              times: 40,
              schedule: Schedule.spaced("15 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new BackupNotResolved({ name });
      }

      if (!isAvailable(current.state) || current.reconciling === true) {
        current = yield* waitUntilReady(name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const observedDisplayName =
        current.displayName ?? output?.displayName ?? olds?.displayName;
      const displayNameChanged =
        (observedDisplayName ?? "") !== (news.displayName ?? "");
      const annotationsChanged =
        news.annotations !== undefined &&
        fingerprint(stringMapOf(current.annotations)) !==
          fingerprint(news.annotations);

      if (labelsChanged || displayNameChanged || annotationsChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          displayNameChanged ? "displayName" : undefined,
          annotationsChanged ? "annotations" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* alloydb
          .patchProjectsLocationsBackups({
            name,
            updateMask: updateMask.join(","),
            body: {
              name,
              labels: desiredLabels,
              displayName: news.displayName,
              annotations: news.annotations,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 40,
              schedule: Schedule.spaced("15 seconds"),
            }),
          );
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      }

      // AlloyDB omits `displayName` from backup reads (like clusters); the
      // desired value is what was applied.
      return toAttrs(
        { ...current, displayName: current.displayName ?? news.displayName },
        env.project,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* alloydb
        .deleteProjectsLocationsBackups({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 40,
            schedule: Schedule.spaced("15 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(output.name);
    }),
  });
