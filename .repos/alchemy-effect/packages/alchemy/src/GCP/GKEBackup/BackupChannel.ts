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
  fieldMask,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  projectName,
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

export type BackupChannelProps = {
  /**
   * Backup channel id (the `{backupChannel}` segment of
   * `projects/{project}/locations/{location}/backupChannels/{backupChannel}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the channel.
   */
  backupChannelId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the channel. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Project that is allowed to store backups created via this channel.
   * Full name `projects/{project}` or a project id. Must differ from
   * the source project. Immutable — changing it replaces the channel.
   */
  destinationProject: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type BackupChannel = Resource<
  "GCP.GKEBackup.BackupChannel",
  BackupChannelProps,
  {
    /** Full resource name. */
    name: string;
    /** Backup channel id (last path segment). */
    backupChannelId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Destination project resource name. */
    destinationProject: string | undefined;
    /** Destination project id. */
    destinationProjectId: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Backup for GKE backup channel that authorizes storing backups in a
 * destination project.
 *
 * Changing `backupChannelId`, `location`, or `destinationProject` replaces
 * the channel. Description and labels update in place.
 *
 * ### Creating a Backup Channel
 * **Example:** Generated name
 * ```typescript
 * const channel = yield* GCP.GKEBackup.BackupChannel("CrossProject", {
 *   destinationProject: "projects/my-backup-project",
 * });
 * ```
 *
 * **Example:** Explicit id, destination, and labels
 * ```typescript
 * const channel = yield* GCP.GKEBackup.BackupChannel("CrossProject", {
 *   backupChannelId: "app-backups",
 *   destinationProject: "projects/my-backup-project",
 *   description: "cross-project backups",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Backup Channel
 * **Example:** Description and labels
 * ```typescript
 * const channel = yield* GCP.GKEBackup.BackupChannel("CrossProject", {
 *   destinationProject: "projects/my-backup-project",
 *   description: "cross-project backups v2",
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category GKEBackup
 */
export const BackupChannel = Resource<BackupChannel>(
  "GCP.GKEBackup.BackupChannel",
);

const resourceName = (
  project: string,
  location: string,
  backupChannelId: string,
) =>
  `projects/${project}/locations/${location}/backupChannels/${backupChannelId}`;

const toAttrs = (
  item: gkebackup.BackupChannel,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "backupChannels", region);
  return {
    name,
    backupChannelId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    destinationProject: item.destinationProject,
    destinationProjectId: item.destinationProjectId,
    description: item.description,
    labels: userLabels(item.labels),
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  gkebackup
    .getProjectsLocationsBackupChannels({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      gkebackup.listProjectsLocationsBackupChannels.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.backupChannels,
      (item) => item.labels,
    ),
  );

export const BackupChannelProvider = () =>
  Provider.succeed(BackupChannel, {
    stables: [
      "name",
      "backupChannelId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousDest =
        olds?.destinationProject ?? output?.destinationProject;
      const nextDest = news.destinationProject;
      return replaceOnIdentity({
        previousId: olds?.backupChannelId ?? output?.backupChannelId,
        nextId:
          news.backupChannelId ??
          olds?.backupChannelId ??
          output?.backupChannelId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          previousDest !== undefined &&
          nextDest !== undefined &&
          previousDest !== nextDest &&
          !previousDest.endsWith(`/${nextDest}`) &&
          previousDest !== `projects/${nextDest}`,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const backupChannelId = yield* toPhysicalId(
        id,
        olds?.backupChannelId,
        output?.backupChannelId,
        "backupchannel",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, backupChannelId);
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
      const backupChannelId = yield* toPhysicalId(
        id,
        news.backupChannelId,
        output?.backupChannelId,
        "backupchannel",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, backupChannelId);
      const destinationProject = projectName(
        news.destinationProject,
        env.project,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* gkebackup
          .createProjectsLocationsBackupChannels({
            parent: parentOf(env.project, location),
            backupChannelId,
            body: {
              destinationProject,
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
      ]);

      if (mask.length > 0) {
        const operation = yield* gkebackup.patchProjectsLocationsBackupChannels(
          {
            name: current.name ?? name,
            updateMask: mask,
            body: {
              etag: current.etag,
              labels: desiredLabels,
              description: news.description,
            },
          },
        );
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
        .deleteProjectsLocationsBackupChannels({
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
