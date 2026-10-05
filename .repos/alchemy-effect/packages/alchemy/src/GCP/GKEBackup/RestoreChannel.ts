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

export type RestoreChannelProps = {
  /**
   * Restore channel id (the `{restoreChannel}` segment of
   * `projects/{project}/locations/{location}/restoreChannels/{restoreChannel}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the channel.
   */
  restoreChannelId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the channel. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Project that is allowed to restore backups via this channel. Full
   * name `projects/{project}` or a project id. Must differ from the
   * source project. Immutable — changing it replaces the channel.
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

export type RestoreChannel = Resource<
  "GCP.GKEBackup.RestoreChannel",
  RestoreChannelProps,
  {
    /** Full resource name. */
    name: string;
    /** Restore channel id (last path segment). */
    restoreChannelId: string;
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
 * A Backup for GKE restore channel that authorizes restoring backups
 * into a destination project.
 *
 * Changing `restoreChannelId`, `location`, or `destinationProject`
 * replaces the channel. Description and labels update in place.
 *
 * ### Creating a Restore Channel
 * **Example:** Generated name
 * ```typescript
 * const channel = yield* GCP.GKEBackup.RestoreChannel("CrossProject", {
 *   destinationProject: "projects/my-restore-project",
 * });
 * ```
 *
 * **Example:** Explicit id, destination, and labels
 * ```typescript
 * const channel = yield* GCP.GKEBackup.RestoreChannel("CrossProject", {
 *   restoreChannelId: "app-restores",
 *   destinationProject: "projects/my-restore-project",
 *   description: "cross-project restores",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Restore Channel
 * **Example:** Description and labels
 * ```typescript
 * const channel = yield* GCP.GKEBackup.RestoreChannel("CrossProject", {
 *   destinationProject: "projects/my-restore-project",
 *   description: "cross-project restores v2",
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category GKEBackup
 */
export const RestoreChannel = Resource<RestoreChannel>(
  "GCP.GKEBackup.RestoreChannel",
);

const resourceName = (
  project: string,
  location: string,
  restoreChannelId: string,
) =>
  `projects/${project}/locations/${location}/restoreChannels/${restoreChannelId}`;

const toAttrs = (
  item: gkebackup.RestoreChannel,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "restoreChannels", region);
  return {
    name,
    restoreChannelId: parsed.id,
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
    .getProjectsLocationsRestoreChannels({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      gkebackup.listProjectsLocationsRestoreChannels.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.restoreChannels,
      (item) => item.labels,
    ),
  );

export const RestoreChannelProvider = () =>
  Provider.succeed(RestoreChannel, {
    stables: [
      "name",
      "restoreChannelId",
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
        previousId: olds?.restoreChannelId ?? output?.restoreChannelId,
        nextId:
          news.restoreChannelId ??
          olds?.restoreChannelId ??
          output?.restoreChannelId,
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
      const restoreChannelId = yield* toPhysicalId(
        id,
        olds?.restoreChannelId,
        output?.restoreChannelId,
        "restorechannel",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, restoreChannelId);
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
      const restoreChannelId = yield* toPhysicalId(
        id,
        news.restoreChannelId,
        output?.restoreChannelId,
        "restorechannel",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, restoreChannelId);
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
          .createProjectsLocationsRestoreChannels({
            parent: parentOf(env.project, location),
            restoreChannelId,
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
        const operation =
          yield* gkebackup.patchProjectsLocationsRestoreChannels({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              etag: current.etag,
              labels: desiredLabels,
              description: news.description,
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
        .deleteProjectsLocationsRestoreChannels({ name: output.name })
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
