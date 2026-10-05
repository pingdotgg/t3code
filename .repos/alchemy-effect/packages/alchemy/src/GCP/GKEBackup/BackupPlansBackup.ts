import * as gkebackup from "@distilled.cloud/gcp/gkebackup_v1";
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
  listAtNested,
  listLabeledPages,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameText,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type BackupPlansBackupProps = {
  /**
   * Parent BackupPlan. Full name
   * `projects/{project}/locations/{location}/backupPlans/{backupPlan}`
   * or the plan id (combined with `location`). Immutable — changing it
   * replaces the backup.
   */
  backupPlan: string;
  /**
   * Region used when `backupPlan` is a bare id.
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
   * Minimum age in days before this Backup can be deleted (`0`–`90`).
   * May only be increased after create. Defaults to the parent plan's
   * `backupDeleteLockDays`.
   */
  deleteLockDays?: number;
  /**
   * Age in days after which this Backup is automatically deleted. `0`
   * disables automatic deletion. May only be increased after create.
   * Defaults to the parent plan's `backupRetainDays`.
   */
  retainDays?: number;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type BackupPlansBackup = Resource<
  "GCP.GKEBackup.BackupPlansBackup",
  BackupPlansBackupProps,
  {
    /** Full resource name. */
    name: string;
    /** Backup id (last path segment). */
    backupId: string;
    /** Parent BackupPlan name. */
    backupPlan: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Whether all namespaces were included. */
    allNamespaces: boolean | undefined;
    /** Delete-lock duration in days. */
    deleteLockDays: number | undefined;
    /** Automatic-deletion age in days. */
    retainDays: number | undefined;
    /** Whether this Backup was created manually. */
    manual: boolean | undefined;
    /** Whether the Backup contains volume data. */
    containsVolumeData: boolean | undefined;
    /** Whether the Backup contains Kubernetes Secrets. */
    containsSecrets: boolean | undefined;
    /** Size of the Backup in bytes. */
    sizeBytes: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** Human-readable state reason. */
    stateReason: string | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 completion timestamp. */
    completeTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Backup for GKE backup — a point-in-time capture of a cluster under
 * a BackupPlan.
 *
 * Changing `backupId`, `backupPlan`, or `location` replaces the backup.
 * Description, labels, `deleteLockDays`, and `retainDays` update in
 * place (`deleteLockDays` and `retainDays` may only increase).
 *
 * ### Creating a Backup
 * **Example:** Manual backup
 * ```typescript
 * const backup = yield* GCP.GKEBackup.BackupPlansBackup("Nightly", {
 *   backupPlan: plan.name,
 * });
 * ```
 *
 * **Example:** Retention overrides
 * ```typescript
 * const backup = yield* GCP.GKEBackup.BackupPlansBackup("Nightly", {
 *   backupPlan: plan.name,
 *   deleteLockDays: 7,
 *   retainDays: 30,
 *   description: "pre-release",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Backup
 * **Example:** Description and labels
 * ```typescript
 * const backup = yield* GCP.GKEBackup.BackupPlansBackup("Nightly", {
 *   backupPlan: plan.name,
 *   description: "pre-release v2",
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category GKEBackup
 */
export const BackupPlansBackup = Resource<BackupPlansBackup>(
  "GCP.GKEBackup.BackupPlansBackup",
);

const resourceName = (plan: string, backupId: string) =>
  `${plan}/backups/${backupId}`;

const toAttrs = (item: gkebackup.Backup, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "backups", region);
  return {
    name,
    backupId: parsed.id,
    backupPlan: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    allNamespaces: item.allNamespaces,
    deleteLockDays: item.deleteLockDays,
    retainDays: item.retainDays,
    manual: item.manual,
    containsVolumeData: item.containsVolumeData,
    containsSecrets: item.containsSecrets,
    sizeBytes: item.sizeBytes,
    description: item.description,
    labels: userLabels(item.labels),
    state: item.state,
    stateReason: item.stateReason,
    uid: item.uid,
    createTime: item.createTime,
    completeTime: item.completeTime,
  };
};

const getByName = (name: string) =>
  gkebackup
    .getProjectsLocationsBackupPlansBackups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtNested(project, "backupPlans/-", (parent) =>
    listLabeledPages(
      gkebackup.listProjectsLocationsBackupPlansBackups.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.backups,
      (item) => item.labels,
    ),
  );

export const BackupPlansBackupProvider = () =>
  Provider.succeed(BackupPlansBackup, {
    stables: [
      "name",
      "backupId",
      "backupPlan",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
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
        previousParent: olds?.backupPlan ?? output?.backupPlan,
        nextParent: news.backupPlan,
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
      const plan = expandParent(
        olds?.backupPlan ?? output?.backupPlan ?? "",
        env.project,
        location,
        "backupPlans",
      );
      const name = output?.name ?? resourceName(plan, backupId);
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
      const plan = expandParent(
        news.backupPlan,
        env.project,
        location,
        "backupPlans",
      );
      const name = resourceName(plan, backupId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* gkebackup
          .createProjectsLocationsBackupPlansBackups({
            parent: plan,
            backupId,
            body: {
              deleteLockDays: news.deleteLockDays,
              retainDays: news.retainDays,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameText(current.description, news.description) && "description",
        news.deleteLockDays !== undefined &&
          news.deleteLockDays !== current.deleteLockDays &&
          "deleteLockDays",
        news.retainDays !== undefined &&
          news.retainDays !== current.retainDays &&
          "retainDays",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* gkebackup.patchProjectsLocationsBackupPlansBackups({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              etag: current.etag,
              labels: desiredLabels,
              description: news.description,
              deleteLockDays: news.deleteLockDays,
              retainDays: news.retainDays,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* gkebackup
        .deleteProjectsLocationsBackupPlansBackups({
          name: output.name,
          force: true,
        })
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
