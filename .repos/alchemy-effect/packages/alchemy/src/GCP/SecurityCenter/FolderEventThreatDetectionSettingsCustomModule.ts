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
  DEFAULT_ETD_TYPE,
  defaultEtdConfig,
  encodeDescription,
  etdSettingsParent,
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
  tryResolveFolder,
  updateMaskOf,
} from "./internal.ts";

export type FolderEventThreatDetectionSettingsCustomModuleProps = {
  /**
   * Parent folder (`folders/{folder}` or the numeric id). Defaults to
   * the project's Resource Manager folder ancestor.
   * Immutable — changing it replaces the module.
   */
  folder?: string;
  /**
   * Custom module type (for example `CONFIGURABLE_BAD_IP`). Immutable —
   * changing it replaces the module.
   * @default "CONFIGURABLE_BAD_IP"
   */
  type?: string;
  /**
   * Module configuration matching `type`.
   */
  config?: scc.DocumentMap;
  /**
   * Enablement state.
   * @default "ENABLED"
   */
  enablementState?:
    | scc.EventThreatDetectionCustomModuleEnablementStateEnum
    | (string & {});
  /**
   * Cloud provider this module applies to.
   * @default "GOOGLE_CLOUD_PLATFORM"
   */
  cloudProvider?:
    | scc.EventThreatDetectionCustomModuleCloudProviderEnum
    | (string & {});
  /**
   * Human-readable display name.
   */
  displayName?: string;
  /**
   * Human-readable description. Event Threat Detection custom modules
   * have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
};

export type FolderEventThreatDetectionSettingsCustomModule = Resource<
  "GCP.SecurityCenter.FolderEventThreatDetectionSettingsCustomModule",
  FolderEventThreatDetectionSettingsCustomModuleProps,
  {
    /** Full resource name `{folder}/eventThreatDetectionSettings/customModules/{module}`. */
    name: string;
    /** Module id (last path segment; server assigned). */
    moduleId: string;
    /** Folder resource name. */
    folder: string;
    /** Folder id. */
    folderId: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Custom module type. */
    type: string | undefined;
    /** Module configuration. */
    config: scc.DocumentMap | undefined;
    /** Enablement state. */
    enablementState: string | undefined;
    /** Cloud provider. */
    cloudProvider: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
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
 * A folder-scoped Event Threat Detection custom module.
 *
 * Custom modules have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. The module id is assigned by
 * the API. Folder and type are identity. Config, enablement, display name,
 * and description update in place.
 *
 * ### Creating a Custom Module
 * **Example:** Flag a test IP
 * ```typescript
 * const module = yield* GCP.SecurityCenter.FolderEventThreatDetectionSettingsCustomModule(
 *   "BadIp",
 *   {
 *     type: "CONFIGURABLE_BAD_IP",
 *     config: {
 *       metadata: { severity: "LOW" },
 *       ips: ["192.0.2.1"],
 *     },
 *     description: "test bad ip",
 *   },
 * );
 * ```
 *
 * @resource
 * @category SecurityCenter
 */
export const FolderEventThreatDetectionSettingsCustomModule =
  Resource<FolderEventThreatDetectionSettingsCustomModule>(
    "GCP.SecurityCenter.FolderEventThreatDetectionSettingsCustomModule",
  );

const toAttrs = (
  module: scc.EventThreatDetectionCustomModule,
  folder: string,
  project: string,
) => {
  const name = module.name ?? "";
  const parsed = parseName(name, "customModules");
  const ownership = parseOwnership(module.description);
  return {
    name,
    moduleId: parsed.id || lastSegment(name),
    folder,
    folderId: folderIdOf(folder),
    project,
    type: module.type,
    config: module.config,
    enablementState: module.enablementState,
    cloudProvider: module.cloudProvider,
    displayName: module.displayName,
    description: ownership.text,
    ancestorModule: module.ancestorModule,
    lastEditor: module.lastEditor,
    updateTime: module.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : scc
        .getFoldersEventThreatDetectionSettingsCustomModules({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  scc.listFoldersEventThreatDetectionSettingsCustomModules
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.eventThreatDetectionCustomModules ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (parent: string, id: string) =>
  Effect.gen(function* () {
    const modules = yield* listAt(parent);
    for (const module of modules) {
      if (yield* ownedByAlchemy(id, module.description)) return module;
    }
    return undefined;
  });

export const FolderEventThreatDetectionSettingsCustomModuleProvider = () =>
  Provider.succeed(FolderEventThreatDetectionSettingsCustomModule, {
    stables: ["name", "moduleId", "folder", "folderId", "project", "type"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceOn(
          olds?.folder ?? output?.folder,
          news.folder !== undefined ? folderParent(news.folder) : undefined,
        ) ?? replaceOn(olds?.type ?? output?.type, news.type)
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
        existing = yield* findOwned(etdSettingsParent(folder), id);
      }
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
        const modules = yield* listAt(etdSettingsParent(folder));
        return modules
          .filter((module) => hasOwnershipMarker(module.description))
          .map((module) => toAttrs(module, folder, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const folder = yield* resolveFolder(news.folder, output?.folder);
      const parent = etdSettingsParent(folder);
      const ownership = yield* createInternalLabels(id);
      const description = encodeDescription(ownership, news.description);
      const type = news.type ?? DEFAULT_ETD_TYPE;
      const config = news.config ?? defaultEtdConfig;
      const enablementState = news.enablementState ?? DEFAULT_ENABLEMENT;
      const cloudProvider = news.cloudProvider ?? DEFAULT_CLOUD_PROVIDER;
      const displayName = news.displayName;

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* findOwned(parent, id);
      }

      if (current === undefined) {
        const created = yield* scc
          .createFoldersEventThreatDetectionSettingsCustomModules({
            parent,
            body: {
              type,
              config,
              enablementState,
              cloudProvider,
              displayName,
              description,
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
        fingerprint(current.config) !== fingerprint(config)
          ? "config"
          : undefined,
        !sameText(current.enablementState, enablementState)
          ? "enablementState"
          : undefined,
        !sameText(current.displayName, displayName) ? "displayName" : undefined,
        !sameText(current.description, description) ? "description" : undefined,
      );

      if (updateMask.length > 0) {
        current =
          yield* scc.patchFoldersEventThreatDetectionSettingsCustomModules({
            name: currentName,
            updateMask,
            body: { config, enablementState, displayName, description },
          });
      }

      return toAttrs(current, folder, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* scc
        .deleteFoldersEventThreatDetectionSettingsCustomModules({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
