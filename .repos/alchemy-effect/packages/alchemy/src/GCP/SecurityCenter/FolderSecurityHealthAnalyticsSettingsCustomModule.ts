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
  DEFAULT_CLOUD_PROVIDER,
  DEFAULT_ENABLEMENT,
  defaultShaCustomConfig,
  encodeDescription,
  fingerprint,
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
  shaSettingsParent,
  toShaDisplayName,
  tryResolveFolder,
  updateMaskOf,
} from "./internal.ts";

export type FolderSecurityHealthAnalyticsSettingsCustomModuleProps = {
  /**
   * Parent folder (`folders/{folder}` or the numeric id). Defaults to
   * the project's Resource Manager folder ancestor.
   * Immutable — changing it replaces the module.
   */
  folder?: string;
  /**
   * Display name. Must start with a lowercase letter and contain only
   * letters, digits, and underscores (max 128). Unique under the parent.
   * If omitted, a unique name is generated. Custom modules have no labels
   * field, so Alchemy ownership is stored in `customConfig.description`.
   */
  displayName?: string;
  /**
   * Detector configuration. When omitted, Alchemy uses a never-matching
   * CEL predicate so the module stays inert.
   */
  customConfig?: scc.GoogleCloudSecuritycenterV1CustomConfig;
  /**
   * Enablement state.
   * @default "ENABLED"
   */
  enablementState?:
    | scc.GoogleCloudSecuritycenterV1SecurityHealthAnalyticsCustomModuleEnablementStateEnum
    | (string & {});
  /**
   * Cloud provider this module applies to.
   * @default "GOOGLE_CLOUD_PLATFORM"
   */
  cloudProvider?:
    | scc.GoogleCloudSecuritycenterV1SecurityHealthAnalyticsCustomModuleCloudProviderEnum
    | (string & {});
};

export type FolderSecurityHealthAnalyticsSettingsCustomModule = Resource<
  "GCP.SecurityCenter.FolderSecurityHealthAnalyticsSettingsCustomModule",
  FolderSecurityHealthAnalyticsSettingsCustomModuleProps,
  {
    /** Full resource name `{folder}/securityHealthAnalyticsSettings/customModules/{module}`. */
    name: string;
    /** Module id (last path segment; server assigned). */
    moduleId: string;
    /** Folder resource name. */
    folder: string;
    /** Folder id. */
    folderId: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** Detector configuration with the Alchemy ownership prefix stripped from description. */
    customConfig: scc.GoogleCloudSecuritycenterV1CustomConfig | undefined;
    /** Enablement state. */
    enablementState: string | undefined;
    /** Cloud provider. */
    cloudProvider: string | undefined;
    /** Ancestor module this one inherits from, if any. */
    ancestorModule: string | undefined;
    /** Last editor of the module. */
    lastEditor: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A folder-scoped Security Health Analytics custom module.
 *
 * Custom modules have no labels field — Alchemy stamps ownership into
 * `customConfig.description` so `list` / nuke can find them. The module id
 * is assigned by the API. Folder is identity. Display name, custom config,
 * and enablement update in place.
 *
 * ### Creating a Custom Module
 * **Example:** Never-matching detector
 * ```typescript
 * const module = yield* GCP.SecurityCenter.FolderSecurityHealthAnalyticsSettingsCustomModule(
 *   "Unused",
 *   {
 *     customConfig: {
 *       predicate: { expression: 'resource.name == "alchemy-nonexistent"' },
 *       resourceSelector: {
 *         resourceTypes: ["compute.googleapis.com/Instance"],
 *       },
 *       severity: "LOW",
 *       recommendation: "No action required.",
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category SecurityCenter
 */
export const FolderSecurityHealthAnalyticsSettingsCustomModule =
  Resource<FolderSecurityHealthAnalyticsSettingsCustomModule>(
    "GCP.SecurityCenter.FolderSecurityHealthAnalyticsSettingsCustomModule",
  );

const desiredCustomConfig = (
  ownership: Record<string, string>,
  customConfig: scc.GoogleCloudSecuritycenterV1CustomConfig | undefined,
): scc.GoogleCloudSecuritycenterV1CustomConfig => {
  const base = customConfig ?? defaultShaCustomConfig;
  return {
    ...base,
    description: encodeDescription(ownership, base.description),
  };
};

const toAttrs = (
  module: scc.GoogleCloudSecuritycenterV1SecurityHealthAnalyticsCustomModule,
  folder: string,
  project: string,
) => {
  const name = module.name ?? "";
  const parsed = parseName(name, "customModules");
  const ownership = parseOwnership(module.customConfig?.description);
  const customConfig = module.customConfig
    ? { ...module.customConfig, description: ownership.text }
    : undefined;
  return {
    name,
    moduleId: parsed.id || lastSegment(name),
    folder,
    folderId: folderIdOf(folder),
    project,
    displayName: module.displayName,
    customConfig,
    enablementState: module.enablementState,
    cloudProvider: module.cloudProvider,
    ancestorModule: module.ancestorModule,
    lastEditor: module.lastEditor,
    updateTime: module.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : scc
        .getFoldersSecurityHealthAnalyticsSettingsCustomModules({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  scc.listFoldersSecurityHealthAnalyticsSettingsCustomModules
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.securityHealthAnalyticsCustomModules ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (parent: string, id: string) =>
  Effect.gen(function* () {
    const modules = yield* listAt(parent);
    for (const module of modules) {
      if (yield* ownedByAlchemy(id, module.customConfig?.description)) {
        return module;
      }
    }
    return undefined;
  });

export const FolderSecurityHealthAnalyticsSettingsCustomModuleProvider = () =>
  Provider.succeed(FolderSecurityHealthAnalyticsSettingsCustomModule, {
    stables: ["name", "moduleId", "folder", "folderId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOn(
        olds?.folder ?? output?.folder,
        news.folder !== undefined ? folderParent(news.folder) : undefined,
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const folder = yield* resolveFolder(
        olds?.folder ?? output?.folder,
        output?.folder,
      );
      let existing = yield* getByName(output?.name ?? "");
      if (existing === undefined) {
        existing = yield* findOwned(shaSettingsParent(folder), id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, folder, env.project);
      return (yield* ownedByAlchemy(id, existing.customConfig?.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const folder = yield* tryResolveFolder();
        if (folder === undefined) return [];
        const modules = yield* listAt(shaSettingsParent(folder));
        return modules
          .filter((module) =>
            hasOwnershipMarker(module.customConfig?.description),
          )
          .map((module) => toAttrs(module, folder, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const folder = yield* resolveFolder(news.folder, output?.folder);
      const parent = shaSettingsParent(folder);
      const ownership = yield* createInternalLabels(id);
      const displayName = yield* toShaDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const customConfig = desiredCustomConfig(ownership, news.customConfig);
      const enablementState = news.enablementState ?? DEFAULT_ENABLEMENT;
      const cloudProvider = news.cloudProvider ?? DEFAULT_CLOUD_PROVIDER;

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* findOwned(parent, id);
      }

      if (current === undefined) {
        const created = yield* scc
          .createFoldersSecurityHealthAnalyticsSettingsCustomModules({
            parent,
            body: {
              displayName,
              customConfig,
              enablementState,
              cloudProvider,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(parent, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SecuritycenterNotResolved({
          name: `${parent}/customModules`,
        });
      }

      const currentName = current.name ?? "";
      const updateMask = updateMaskOf(
        !sameText(current.displayName, displayName) ? "displayName" : undefined,
        fingerprint(current.customConfig) !== fingerprint(customConfig)
          ? "customConfig"
          : undefined,
        !sameText(current.enablementState, enablementState)
          ? "enablementState"
          : undefined,
      );

      if (updateMask.length > 0) {
        current =
          yield* scc.patchFoldersSecurityHealthAnalyticsSettingsCustomModules({
            name: currentName,
            updateMask,
            body: { displayName, customConfig, enablementState },
          });
      }

      return toAttrs(current, folder, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* scc
        .deleteFoldersSecurityHealthAnalyticsSettingsCustomModules({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
