import * as file from "@distilled.cloud/gcp/file_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_SHARE_NAME,
  DEFAULT_ZONE,
  expandParent,
  fieldMask,
  isDeletingState,
  lastSegment,
  listLabeledPages,
  normalizeLocation,
  parseName,
  regionOf,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type BackupProps = {
  /**
   * Source Filestore instance. Full name
   * `projects/{project}/locations/{location}/instances/{instance}` or
   * the instance id (combined with `instanceLocation`). Immutable —
   * changing it replaces the backup.
   */
  sourceInstance: string;
  /**
   * File share on the source instance to back up. Immutable — changing
   * it replaces the backup.
   * @default "share1"
   */
  sourceFileShare?: string;
  /**
   * Zone of the source instance when `sourceInstance` is a bare id.
   * Ignored when `sourceInstance` is a full resource name.
   * @default "us-central1-a"
   */
  instanceLocation?: string;
  /**
   * Region that stores the backup (`us-central1`, …). Backups are
   * regional and may live in a different region than the instance.
   * Immutable — changing it replaces the backup. `US-CENTRAL1` is
   * accepted and normalized to `us-central1`.
   * @default the region of the source instance
   */
  location?: string;
  /**
   * Backup id (the `{backup}` segment of
   * `projects/{project}/locations/{location}/backups/{backup}`). If
   * omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must start with a letter, be 1-63 characters, and
   * end with a letter or digit. Immutable — changing it replaces the
   * backup.
   */
  backupId?: string;
  /**
   * Human-readable description (2048 characters or less).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Customer-managed KMS key for backup encryption
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   * Immutable — changing it replaces the backup.
   */
  kmsKey?: string;
  /**
   * Resource Manager tags (namespaced key to short value). Input-only
   * and immutable.
   */
  tags?: Record<string, string>;
};

export type Backup = Resource<
  "GCP.Filestore.Backup",
  BackupProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/backups/{backup}`. */
    name: string;
    /** Backup id (last path segment). */
    backupId: string;
    /** Project id. */
    project: string;
    /** Backup region. */
    location: string;
    /** Source instance resource name. */
    sourceInstance: string | undefined;
    /** Source file share name. */
    sourceFileShare: string | undefined;
    /** Source instance service tier. */
    sourceInstanceTier: string | undefined;
    /** File protocol of the source instance. */
    fileSystemProtocol: string | undefined;
    /** Source share capacity in GiB when the backup was taken. */
    capacityGb: string | undefined;
    /** Bytes occupied by this backup (shared storage; can change). */
    storageBytes: string | undefined;
    /** Bytes downloaded when restoring this backup. */
    downloadBytes: string | undefined;
    /** Customer-managed KMS key, if any. */
    kmsKey: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state (`READY`, `CREATING`, `FINALIZING`, …). */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Filestore backup of an instance file share.
 *
 * Changing `backupId`, `location`, `sourceInstance`, `sourceFileShare`,
 * or `kmsKey` replaces the backup. Description and labels update in
 * place.
 *
 * Backups are regional. Creating a backup of a Basic HDD share typically
 * takes several minutes.
 *
 * ### Creating a Backup
 * **Example:** Backup the default share
 * ```typescript
 * const nfs = yield* GCP.Filestore.Instance("Nfs", {});
 * const backup = yield* GCP.Filestore.Backup("Nightly", {
 *   sourceInstance: nfs.name,
 * });
 * ```
 *
 * **Example:** Explicit id, share, labels, and description
 * ```typescript
 * const backup = yield* GCP.Filestore.Backup("Nightly", {
 *   sourceInstance: nfs.name,
 *   sourceFileShare: "share1",
 *   backupId: "app-nfs-nightly",
 *   location: "us-central1",
 *   description: "nightly backup",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Backup
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Description and labels
 * ```typescript
 * const backup = yield* GCP.Filestore.Backup("Nightly", {
 *   sourceInstance: nfs.name,
 *   description: "nightly backup v2",
 *   labels: { env: "prod", team: "storage" },
 * });
 * ```
 *
 * @resource
 * @category Filestore
 */
export const Backup = Resource<Backup>("GCP.Filestore.Backup");

export class BackupSourceMissing extends Data.TaggedError(
  "GCP.Filestore.BackupSourceMissing",
)<{
  message: string;
}> {}

const resourceName = (project: string, location: string, backupId: string) =>
  `projects/${project}/locations/${location}/backups/${backupId}`;

const parseInstanceRef = (
  value: string,
  fallbackProject: string,
  fallbackLocation: string,
) => {
  const trimmed = value.trim();
  if (trimmed.includes("/")) {
    const parsed = parseName(trimmed, "instances", DEFAULT_ZONE);
    const instanceLocation = normalizeLocation(parsed.location, DEFAULT_ZONE);
    return {
      project: parsed.project || fallbackProject,
      location: instanceLocation,
      instanceId: parsed.id,
      instanceName: expandParent(
        parsed.id,
        parsed.project || fallbackProject,
        instanceLocation,
        "instances",
      ),
    };
  }
  const location = normalizeLocation(fallbackLocation, DEFAULT_ZONE);
  const instanceId = lastSegment(trimmed);
  return {
    project: fallbackProject,
    location,
    instanceId,
    instanceName: expandParent(
      instanceId,
      fallbackProject,
      location,
      "instances",
    ),
  };
};

const backupLocationOf = (
  newsLocation: string | undefined,
  outputLocation: string | undefined,
  instanceLocation: string,
) =>
  normalizeLocation(newsLocation ?? outputLocation, regionOf(instanceLocation));

const toAttrs = (backup: file.Backup, project: string, region: string) => {
  const name = backup.name ?? "";
  const parsed = parseName(name, "backups", region);
  return {
    name,
    backupId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    sourceInstance: backup.sourceInstance,
    sourceFileShare: backup.sourceFileShare,
    sourceInstanceTier: backup.sourceInstanceTier,
    fileSystemProtocol: backup.fileSystemProtocol,
    capacityGb: backup.capacityGb,
    storageBytes: backup.storageBytes,
    downloadBytes: backup.downloadBytes,
    kmsKey: backup.kmsKey,
    description: backup.description,
    labels: userLabels(backup.labels),
    state: backup.state,
    createTime: backup.createTime,
  };
};

const isPlaceholder = (backup: file.Backup) => {
  const name = backup.name ?? "";
  return (
    name.length === 0 ||
    name.endsWith("/backups/-") ||
    name.endsWith("/backups/")
  );
};

const getByName = (name: string) =>
  Effect.gen(function* () {
    if (name.length === 0 || name.includes("//")) return undefined;
    return yield* file
      .getProjectsLocationsBackups({ name })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  });

export const BackupProvider = () =>
  Provider.succeed(Backup, {
    stables: [
      "name",
      "backupId",
      "project",
      "location",
      "sourceInstance",
      "sourceFileShare",
      "kmsKey",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousInstance = parseInstanceRef(
        olds?.sourceInstance ?? output?.sourceInstance ?? "",
        env.project,
        olds?.instanceLocation ?? output?.location ?? DEFAULT_ZONE,
      );
      const nextInstance = parseInstanceRef(
        news.sourceInstance,
        env.project,
        news.instanceLocation ??
          olds?.instanceLocation ??
          previousInstance.location,
      );
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        regionOf(previousInstance.location),
      );
      const nextLocation = backupLocationOf(
        news.location,
        olds?.location ?? output?.location,
        nextInstance.location,
      );
      const previousShare =
        olds?.sourceFileShare ?? output?.sourceFileShare ?? DEFAULT_SHARE_NAME;
      const nextShare = news.sourceFileShare ?? previousShare;
      const previousKey = olds?.kmsKey ?? output?.kmsKey ?? "";
      const nextKey = news.kmsKey ?? previousKey;
      return replaceOnIdentity({
        previousId: olds?.backupId ?? output?.backupId,
        nextId: news.backupId ?? olds?.backupId ?? output?.backupId,
        previousLocation,
        nextLocation,
        extra:
          previousInstance.instanceName !== nextInstance.instanceName ||
          previousShare !== nextShare ||
          previousKey !== nextKey,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instance = parseInstanceRef(
        olds?.sourceInstance ?? output?.sourceInstance ?? "",
        env.project,
        olds?.instanceLocation ?? output?.location ?? DEFAULT_ZONE,
      );
      const location = backupLocationOf(
        olds?.location,
        output?.location,
        instance.location,
      );
      const backupId = yield* toPhysicalId(
        id,
        olds?.backupId,
        output?.backupId,
        "backup",
      );
      const name =
        output?.name ?? resourceName(env.project, location, backupId);
      const existing = yield* getByName(name);
      if (existing === undefined || isPlaceholder(existing)) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listLabeledPages(
          file.listProjectsLocationsBackups.pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          }),
          (page) => page.backups,
          (item) => item.labels,
        );
        return items
          .filter((item) => !isPlaceholder(item))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      if (news.sourceInstance.trim().length === 0) {
        return yield* new BackupSourceMissing({
          message: "sourceInstance is required",
        });
      }
      const instance = parseInstanceRef(
        news.sourceInstance,
        env.project,
        news.instanceLocation ?? DEFAULT_ZONE,
      );
      const location = backupLocationOf(
        news.location,
        output?.location,
        instance.location,
      );
      const backupId = yield* toPhysicalId(
        id,
        news.backupId,
        output?.backupId,
        "backup",
      );
      const name = resourceName(env.project, location, backupId);
      const sourceFileShare = news.sourceFileShare ?? DEFAULT_SHARE_NAME;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current !== undefined && isDeletingState(current.state)) {
        yield* waitUntilGone(
          getByName(current.name ?? name),
          current.name ?? name,
        );
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* file
          .createProjectsLocationsBackups({
            parent: `projects/${env.project}/locations/${location}`,
            backupId,
            body: {
              sourceInstance: instance.instanceName,
              sourceFileShare,
              description: news.description,
              labels: desiredLabels,
              kmsKey: news.kmsKey,
              tags: news.tags,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );
      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        (current.description ?? "") !== (news.description ?? "") &&
          "description",
      ]);

      if (mask.length > 0) {
        const operation = yield* file.patchProjectsLocationsBackups({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
            description: news.description,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
        );
        if (current === undefined) {
          return yield* new ResourceNotResolved({ name });
        }
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name || output.name.includes("//")) return;
      const operation = yield* file
        .deleteProjectsLocationsBackups({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
