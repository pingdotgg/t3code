import * as netapp from "@distilled.cloud/gcp/netapp_v1";
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
  expandParent,
  fieldMask,
  fingerprint,
  listAtNested,
  listLabeledPages,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type OntapSource = {
  /** Storage pool that hosts the ONTAP volume. */
  storagePool?: string;
  /** ONTAP source volume UUID. */
  volumeUuid?: string;
  /** ONTAP source snapshot UUID. */
  snapshotUuid?: string;
};

export type BackupVaultsBackupProps = {
  /**
   * Parent backup vault. Full name
   * `projects/{project}/locations/{location}/backupVaults/{backupVault}`
   * or the vault id (combined with `location`). Immutable — changing it
   * replaces the backup.
   */
  backupVault: string;
  /**
   * Region used when `backupVault` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Backup id (the `{backup}` segment). If omitted, a unique RFC1035 name
   * is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the backup.
   */
  backupId?: string;
  /**
   * Source volume name or id. Immutable — changing it replaces the
   * backup. Either `sourceVolume` or `ontapSource` is required.
   */
  sourceVolume?: string;
  /**
   * Snapshot to back up. If omitted, a new snapshot is taken. Immutable.
   */
  sourceSnapshot?: string;
  /**
   * ONTAP source details. Immutable — changing it replaces the backup.
   */
  ontapSource?: OntapSource;
  /**
   * Human-readable description. Max 2048 characters.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type BackupVaultsBackup = Resource<
  "GCP.NetApp.BackupVaultsBackup",
  BackupVaultsBackupProps,
  {
    /** Full resource name. */
    name: string;
    /** Backup id (last path segment). */
    backupId: string;
    /** Parent backup vault name. */
    backupVault: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Source volume name. */
    sourceVolume: string | undefined;
    /** Source snapshot name. */
    sourceSnapshot: string | undefined;
    /** ONTAP source details. */
    ontapSource: OntapSource | undefined;
    /** Backup type (`MANUAL` or `SCHEDULED`). */
    backupType: string | undefined;
    /** Region that stores the backup. */
    backupRegion: string | undefined;
    /** Region of the source volume. */
    volumeRegion: string | undefined;
    /** File-system size at backup time, in bytes. */
    volumeUsageBytes: string | undefined;
    /** Chain storage in bytes. */
    chainStorageBytes: string | undefined;
    /** Time until which the backup cannot be deleted. */
    enforcedRetentionEndTime: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud NetApp Volumes backup stored in a backup vault.
 *
 * Changing `backupId`, `backupVault`, `location`, `sourceVolume`,
 * `sourceSnapshot`, or `ontapSource` replaces the backup. Description and
 * labels update in place.
 *
 * ### Creating a Backup
 * **Example:** From a volume
 * ```typescript
 * const backup = yield* GCP.NetApp.BackupVaultsBackup("Nightly", {
 *   backupVault: vault.name,
 *   sourceVolume: volume.name,
 * });
 * ```
 *
 * **Example:** From a snapshot
 * ```typescript
 * const backup = yield* GCP.NetApp.BackupVaultsBackup("Nightly", {
 *   backupVault: vault.name,
 *   sourceVolume: volume.name,
 *   sourceSnapshot: snapshot.name,
 *   description: "pre-release",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Backup
 * **Example:** Description and labels
 * ```typescript
 * const backup = yield* GCP.NetApp.BackupVaultsBackup("Nightly", {
 *   backupVault: vault.name,
 *   sourceVolume: volume.name,
 *   description: "pre-release v2",
 *   labels: { env: "prod", team: "storage" },
 * });
 * ```
 *
 * @resource
 * @category NetApp
 */
export const BackupVaultsBackup = Resource<BackupVaultsBackup>(
  "GCP.NetApp.BackupVaultsBackup",
);

const resourceName = (vault: string, backupId: string) =>
  `${vault}/backups/${backupId}`;

const toOntap = (
  source: netapp.OntapSource | undefined,
): OntapSource | undefined =>
  source === undefined
    ? undefined
    : {
        storagePool: source.storagePool,
        volumeUuid: source.volumeUuid,
        snapshotUuid: source.snapshotUuid,
      };

const toAttrs = (item: netapp.Backup, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "backups", region);
  return {
    name,
    backupId: parsed.id,
    backupVault: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    sourceVolume: item.sourceVolume,
    sourceSnapshot: item.sourceSnapshot,
    ontapSource: toOntap(item.ontapSource),
    backupType: item.backupType,
    backupRegion: item.backupRegion,
    volumeRegion: item.volumeRegion,
    volumeUsageBytes: item.volumeUsageBytes,
    chainStorageBytes: item.chainStorageBytes,
    enforcedRetentionEndTime: item.enforcedRetentionEndTime,
    description: item.description,
    labels: userLabels(item.labels),
    state: item.state,
    createTime: item.createTime,
  };
};

const getByName = (name: string) =>
  netapp
    .getProjectsLocationsBackupVaultsBackups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtNested(project, "backupVaults/-", (parent) =>
    listLabeledPages(
      netapp.listProjectsLocationsBackupVaultsBackups.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.backups,
      (item) => item.labels,
    ),
  );

export const BackupVaultsBackupProvider = () =>
  Provider.succeed(BackupVaultsBackup, {
    stables: [
      "name",
      "backupId",
      "backupVault",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousVolume = olds?.sourceVolume ?? output?.sourceVolume;
      const previousSnapshot = olds?.sourceSnapshot ?? output?.sourceSnapshot;
      const previousOntap = olds?.ontapSource ?? output?.ontapSource;
      return replaceOnIdentity({
        previousId: olds?.backupId ?? output?.backupId,
        nextId: news.backupId ?? olds?.backupId ?? output?.backupId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.backupVault ?? output?.backupVault,
        nextParent: news.backupVault,
        extra:
          (previousVolume !== undefined &&
            news.sourceVolume !== undefined &&
            news.sourceVolume !== previousVolume &&
            !previousVolume.endsWith(`/${news.sourceVolume}`)) ||
          (previousSnapshot !== undefined &&
            news.sourceSnapshot !== undefined &&
            news.sourceSnapshot !== previousSnapshot) ||
          (previousOntap !== undefined &&
            news.ontapSource !== undefined &&
            fingerprint(previousOntap) !== fingerprint(news.ontapSource)),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const backupId = yield* toPhysicalId(
        id,
        olds?.backupId,
        output?.backupId,
        "backup",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const parent = olds?.backupVault ?? output?.backupVault;
      // A row whose parent never resolved (failed create) has nothing to read.
      if (output?.name === undefined && !parent) return undefined;
      const vault = expandParent(
        parent ?? "",
        env.project,
        location,
        "backupVaults",
      );
      const name = output?.name ?? resourceName(vault, backupId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const backupId = yield* toPhysicalId(
        id,
        news.backupId,
        output?.backupId,
        "backup",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const vault = expandParent(
        news.backupVault,
        env.project,
        location,
        "backupVaults",
      );
      const name = resourceName(vault, backupId);
      const sourceVolume =
        news.sourceVolume === undefined
          ? undefined
          : expandParent(news.sourceVolume, env.project, location, "volumes");
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* netapp
          .createProjectsLocationsBackupVaultsBackups({
            parent: vault,
            backupId,
            body: {
              sourceVolume,
              sourceSnapshot: news.sourceSnapshot,
              ontapSource: news.ontapSource,
              description: news.description,
              labels: desiredLabels,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        (current.description ?? "") !== (news.description ?? "") &&
          "description",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* netapp.patchProjectsLocationsBackupVaultsBackups({
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
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* netapp
        .deleteProjectsLocationsBackupVaultsBackups({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
