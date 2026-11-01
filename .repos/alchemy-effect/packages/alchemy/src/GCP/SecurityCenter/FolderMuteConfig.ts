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
  DEFAULT_MUTE_TYPE,
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

export type FolderMuteConfigProps = {
  /**
   * Mute config id (the `{muteConfig}` segment of
   * `folders/{folder}/muteConfigs/{muteConfig}`). If omitted, a unique id
   * is generated from the stack, stage, and logical id. Letters, digits,
   * and hyphens; max 63 characters. Immutable — changing it replaces the
   * config.
   */
  muteConfigId?: string;
  /**
   * Parent folder (`folders/{folder}` or the numeric id). Defaults to
   * the project's Resource Manager folder ancestor.
   * Immutable — changing it replaces the config.
   */
  folder?: string;
  /**
   * Finding filter selecting findings to mute. Required.
   */
  filter: string;
  /**
   * Mute config type. Immutable — changing it replaces the config.
   * @default "STATIC"
   */
  type?: scc.GoogleCloudSecuritycenterV1MuteConfigTypeEnum | (string & {});
  /**
   * RFC3339 expiry for `DYNAMIC` mute configs.
   */
  expiryTime?: string;
  /**
   * Human-readable display name.
   */
  displayName?: string;
  /**
   * Human-readable description. Mute configs have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type FolderMuteConfig = Resource<
  "GCP.SecurityCenter.FolderMuteConfig",
  FolderMuteConfigProps,
  {
    /** Full resource name `folders/{folder}/muteConfigs/{muteConfig}`. */
    name: string;
    /** Mute config id (last path segment). */
    muteConfigId: string;
    /** Folder resource name. */
    folder: string;
    /** Folder id. */
    folderId: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Finding filter. */
    filter: string;
    /** Mute config type. */
    type: string | undefined;
    /** RFC3339 expiry, if set. */
    expiryTime: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Most recent editor of the config. */
    mostRecentEditor: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A folder-scoped Security Command Center mute config.
 *
 * Mute configs have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. Mute config id, folder, and
 * type are identity. Filter, description, display name, and expiry update
 * in place.
 *
 * ### Creating a Mute Config
 * **Example:** Mute low-severity findings
 * ```typescript
 * const mute = yield* GCP.SecurityCenter.FolderMuteConfig("Low", {
 *   filter: 'severity="LOW"',
 *   description: "mute low findings",
 * });
 * ```
 *
 * **Example:** Named config on an explicit folder
 * ```typescript
 * const mute = yield* GCP.SecurityCenter.FolderMuteConfig("Low", {
 *   folder: "folders/123456789",
 *   muteConfigId: "mute-low",
 *   filter: 'severity="LOW"',
 *   type: "STATIC",
 * });
 * ```
 *
 * @resource
 * @category SecurityCenter
 */
export const FolderMuteConfig = Resource<FolderMuteConfig>(
  "GCP.SecurityCenter.FolderMuteConfig",
);

const resourceName = (folder: string, muteConfigId: string) =>
  `${folder}/muteConfigs/${muteConfigId}`;

const toAttrs = (
  config: scc.GoogleCloudSecuritycenterV1MuteConfig,
  folder: string,
  project: string,
) => {
  const name = config.name ?? "";
  const parsed = parseName(name, "muteConfigs");
  const ownership = parseOwnership(config.description);
  return {
    name,
    muteConfigId: parsed.id || lastSegment(name),
    folder,
    folderId: folderIdOf(folder),
    project,
    filter: config.filter ?? "",
    type: config.type,
    expiryTime: config.expiryTime,
    displayName: config.displayName,
    description: ownership.text,
    mostRecentEditor: config.mostRecentEditor,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : scc
        .getFoldersMuteConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const FolderMuteConfigProvider = () =>
  Provider.succeed(FolderMuteConfig, {
    stables: [
      "name",
      "muteConfigId",
      "folder",
      "folderId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceOn(
          olds?.muteConfigId ?? output?.muteConfigId,
          news.muteConfigId,
        ) ??
        replaceOn(
          olds?.folder ?? output?.folder,
          news.folder !== undefined ? folderParent(news.folder) : undefined,
        ) ??
        replaceOn(olds?.type ?? output?.type, news.type)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const folder = yield* resolveFolder(
        olds?.folder ?? output?.folder,
        output?.folder,
      );
      const muteConfigId = yield* toPhysicalId(
        id,
        olds?.muteConfigId,
        output?.muteConfigId,
      );
      const name = output?.name ?? resourceName(folder, muteConfigId);
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
        return yield* scc.listFoldersMuteConfigs
          .pages({ parent: folder, pageSize: 100 })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.muteConfigs ?? []),
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
      const muteConfigId = yield* toPhysicalId(
        id,
        news.muteConfigId,
        output?.muteConfigId,
      );
      const name = resourceName(folder, muteConfigId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeDescription(ownership, news.description);
      const filter = news.filter;
      const type = news.type ?? DEFAULT_MUTE_TYPE;
      const expiryTime = news.expiryTime;
      const displayName = news.displayName;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* scc
          .createFoldersMuteConfigs({
            parent: folder,
            muteConfigId,
            body: { filter, type, expiryTime, displayName, description },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SecuritycenterNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const updateMask = updateMaskOf(
        !sameText(current.filter, filter) ? "filter" : undefined,
        !sameText(current.description, description) ? "description" : undefined,
        !sameText(current.displayName, displayName) ? "displayName" : undefined,
        !sameText(current.expiryTime, expiryTime) ? "expiryTime" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* scc.patchFoldersMuteConfigs({
          name: currentName,
          updateMask,
          body: { filter, expiryTime, displayName, description },
        });
      }

      return toAttrs(current, folder, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* scc
        .deleteFoldersMuteConfigs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
