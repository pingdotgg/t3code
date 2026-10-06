import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDescription,
  folderIdOf,
  folderParent,
  hasOwnershipMarker,
  lastSegment,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOn,
  resolveFolder,
  sameText,
  SecuritycenterNotResolved,
  toPhysicalId,
  tryResolveFolder,
  updateMaskOf,
} from "./internal.ts";

export type FolderNotificationConfigProps = {
  /**
   * Config id (the `{config}` segment of
   * `folders/{folder}/notificationConfigs/{config}`). If omitted, a unique
   * id is generated from the stack, stage, and logical id. Letters,
   * digits, and hyphens; max 63 characters. Immutable — changing it
   * replaces the config.
   */
  configId?: string;
  /**
   * Parent folder (`folders/{folder}` or the numeric id). Defaults to
   * the project's Resource Manager folder ancestor.
   * Immutable — changing it replaces the config.
   */
  folder?: string;
  /**
   * Pub/Sub topic that receives findings
   * (`projects/{project}/topics/{topic}`).
   */
  pubsubTopic: string;
  /**
   * Finding filter. Empty exports every finding under the parent.
   */
  filter?: string;
  /**
   * Human-readable description. Notification configs have no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type FolderNotificationConfig = Resource<
  "GCP.SecurityCenter.FolderNotificationConfig",
  FolderNotificationConfigProps,
  {
    /** Full resource name `folders/{folder}/notificationConfigs/{config}`. */
    name: string;
    /** Config id (last path segment). */
    configId: string;
    /** Folder resource name. */
    folder: string;
    /** Folder id. */
    folderId: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Pub/Sub topic that receives findings. */
    pubsubTopic: string;
    /** Finding filter. */
    filter: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Service account Security Command Center uses to publish. */
    serviceAccount: string | undefined;
  },
  never,
  Providers
>;

/**
 * A folder-scoped Security Command Center notification config.
 *
 * Notification configs have no labels field — Alchemy stamps ownership
 * into the description so `list` / nuke can find them. Config id and
 * folder are identity. Pub/Sub topic, filter, and description update in
 * place.
 *
 * ### Creating a Notification Config
 * **Example:** Stream findings to Pub/Sub
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("SccFindings", {});
 * const config = yield* GCP.SecurityCenter.FolderNotificationConfig(
 *   "Findings",
 *   {
 *     pubsubTopic: topic.name,
 *     filter: 'state="ACTIVE"',
 *     description: "active findings",
 *   },
 * );
 * ```
 *
 * **Example:** Named config on an explicit folder
 * ```typescript
 * const config = yield* GCP.SecurityCenter.FolderNotificationConfig(
 *   "Findings",
 *   {
 *     folder: "folders/123456789",
 *     configId: "active-findings",
 *     pubsubTopic: "projects/my-project/topics/scc",
 *   },
 * );
 * ```
 *
 * @resource
 * @category SecurityCenter
 */
export const FolderNotificationConfig = Resource<FolderNotificationConfig>(
  "GCP.SecurityCenter.FolderNotificationConfig",
);

const resourceName = (folder: string, configId: string) =>
  `${folder}/notificationConfigs/${configId}`;

const toAttrs = (
  config: scc.NotificationConfig,
  folder: string,
  project: string,
) => {
  const name = config.name ?? "";
  const parsed = parseName(name, "notificationConfigs");
  const ownership = parseOwnership(config.description);
  return {
    name,
    configId: parsed.id || lastSegment(name),
    folder,
    folderId: folderIdOf(folder),
    project,
    pubsubTopic: config.pubsubTopic ?? "",
    filter: config.streamingConfig?.filter,
    description: ownership.text,
    serviceAccount: config.serviceAccount,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : scc
        .getFoldersNotificationConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const FolderNotificationConfigProvider = () =>
  Provider.succeed(FolderNotificationConfig, {
    stables: ["name", "configId", "folder", "folderId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceOn(olds?.configId ?? output?.configId, news.configId) ??
        replaceOn(
          olds?.folder ?? output?.folder,
          news.folder !== undefined ? folderParent(news.folder) : undefined,
        )
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const folder = yield* resolveFolder(
        olds?.folder ?? output?.folder,
        output?.folder,
      );
      const configId = yield* toPhysicalId(
        id,
        olds?.configId,
        output?.configId,
      );
      const name = output?.name ?? resourceName(folder, configId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, folder, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const folder = yield* tryResolveFolder();
        if (folder === undefined) return [];
        return yield* scc.listFoldersNotificationConfigs
          .pages({ parent: folder, pageSize: 100 })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.notificationConfigs ?? []),
            ),
            Stream.filter((config) => hasOwnershipMarker(config.description)),
            Stream.map((config) => toAttrs(config, folder, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const folder = yield* resolveFolder(news.folder, output?.folder);
      const configId = yield* toPhysicalId(id, news.configId, output?.configId);
      const name = resourceName(folder, configId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeDescription(ownership, news.description);
      const pubsubTopic = news.pubsubTopic;
      const filter = news.filter ?? "";
      const streamingConfig = { filter };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* scc
          .createFoldersNotificationConfigs({
            parent: folder,
            configId,
            body: { pubsubTopic, description, streamingConfig },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SecuritycenterNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const updateMask = updateMaskOf(
        !sameText(current.pubsubTopic, pubsubTopic) ? "pubsubTopic" : undefined,
        !sameText(current.description, description) ? "description" : undefined,
        !sameText(current.streamingConfig?.filter, filter)
          ? "streamingConfig.filter"
          : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* scc.patchFoldersNotificationConfigs({
          name: currentName,
          updateMask,
          body: { pubsubTopic, description, streamingConfig },
        });
      }

      return toAttrs(current, folder, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* scc
        .deleteFoldersNotificationConfigs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
