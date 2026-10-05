import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnership,
  etdDisplayNameOf,
  etdSettingsParent,
  findOwned,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  ownedByAlchemy,
  parseOwnership,
  projectOf,
  replaceOn,
  sameText,
  updateMaskOf,
} from "./internal.ts";

export type EventThreatDetectionEnablementState =
  | "ENABLEMENT_STATE_UNSPECIFIED"
  | "ENABLED"
  | "DISABLED"
  | "INHERITED";

export type EventThreatDetectionCloudProvider =
  | "CLOUD_PROVIDER_UNSPECIFIED"
  | "GOOGLE_CLOUD_PLATFORM"
  | "AMAZON_WEB_SERVICES"
  | "MICROSOFT_AZURE";

export type EventThreatDetectionConfig = scc.DocumentMap;

export type EventThreatDetectionSettingsCustomModuleProps = {
  /**
   * Module id (the `{module}` segment of
   * `projects/{project}/eventThreatDetectionSettings/customModules/{module}`).
   * Server-assigned on create. Supply it to target an existing module.
   * Immutable — changing it replaces the module.
   */
  moduleId?: string;
  /**
   * Module type, e.g. `CONFIGURABLE_BAD_IP`. Immutable — changing it
   * replaces the module.
   */
  type: string;
  /**
   * Display name (letters, digits, underscores; max 128 characters).
   */
  displayName?: string;
  /**
   * Human-readable description. Custom modules have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Enablement state at this parent.
   * @default "ENABLED"
   */
  enablementState?: EventThreatDetectionEnablementState;
  /**
   * Module configuration (template-specific JSON).
   */
  config?: EventThreatDetectionConfig;
  /**
   * Cloud provider this module applies to.
   */
  cloudProvider?: EventThreatDetectionCloudProvider;
};

export type EventThreatDetectionSettingsCustomModule = Resource<
  "GCP.SecurityCenter.EventThreatDetectionSettingsCustomModule",
  EventThreatDetectionSettingsCustomModuleProps,
  {
    /** Full resource name `projects/{project}/eventThreatDetectionSettings/customModules/{module}`. */
    name: string;
    /** Module id (last path segment). */
    moduleId: string;
    /** Project id. */
    project: string;
    /** Module type. */
    type: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Enablement state. */
    enablementState: string | undefined;
    /** Module configuration. */
    config: EventThreatDetectionConfig | undefined;
    /** Cloud provider. */
    cloudProvider: string | undefined;
    /** Ancestor module this one inherits from, if any. */
    ancestorModule: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Last editor email. */
    lastEditor: string | undefined;
  },
  never,
  Providers
>;

/**
 * A project-scoped Event Threat Detection custom module.
 *
 * Custom modules have no labels field — Alchemy stamps ownership into
 * the description so `list` / nuke can find them. Module id and type are
 * identity (the id is server-assigned). Display name, description,
 * enablement, and config update in place.
 *
 * ### Creating a Custom Module
 * **Example:** Flag connections to a test IP
 * ```typescript
 * const module = yield* GCP.SecurityCenter.EventThreatDetectionSettingsCustomModule(
 *   "BadIp",
 *   {
 *     type: "CONFIGURABLE_BAD_IP",
 *     displayName: "alchemy_bad_ip",
 *     description: "test bad ip",
 *     config: {
 *       metadata: {
 *         severity: "LOW",
 *         description: "test",
 *         recommendation: "investigate",
 *       },
 *       ips: ["192.0.2.1"],
 *     },
 *   },
 * );
 * ```
 *
 * ### Updating a Custom Module
 * **Example:** Disable the module
 * ```typescript
 * const module = yield* GCP.SecurityCenter.EventThreatDetectionSettingsCustomModule(
 *   "BadIp",
 *   {
 *     type: "CONFIGURABLE_BAD_IP",
 *     enablementState: "DISABLED",
 *   },
 * );
 * ```
 *
 * @resource
 * @category SecurityCenter
 */
export const EventThreatDetectionSettingsCustomModule =
  Resource<EventThreatDetectionSettingsCustomModule>(
    "GCP.SecurityCenter.EventThreatDetectionSettingsCustomModule",
  );

export class EventThreatDetectionSettingsCustomModuleNotResolved extends Data.TaggedError(
  "GCP.SecurityCenter.EventThreatDetectionSettingsCustomModuleNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, moduleId: string) =>
  `projects/${project}/eventThreatDetectionSettings/customModules/${moduleId}`;

const toAttrs = (
  module: scc.EventThreatDetectionCustomModule,
  project: string,
) => {
  const name = module.name ?? "";
  const parsed = parseOwnership(module.description);
  return {
    name,
    moduleId: lastSegment(name),
    project: projectOf(name) || project,
    type: module.type,
    displayName: module.displayName,
    description: parsed.text,
    enablementState: module.enablementState,
    config: module.config,
    cloudProvider: module.cloudProvider,
    ancestorModule: module.ancestorModule,
    updateTime: module.updateTime,
    lastEditor: module.lastEditor,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : scc
        .getProjectsEventThreatDetectionSettingsCustomModules({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listModules = (project: string) =>
  collectPages(
    scc.listProjectsEventThreatDetectionSettingsCustomModules.pages({
      parent: etdSettingsParent(`projects/${project}`),
      pageSize: 100,
    }),
    (page) => page.eventThreatDetectionCustomModules,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as scc.EventThreatDetectionCustomModule[]),
    ),
  );

const observe = (project: string, id: string, name: string) =>
  Effect.gen(function* () {
    const existing = yield* getByName(name);
    if (existing !== undefined) return existing;
    const items = yield* listModules(project);
    return yield* findOwned(items, (item) => item.description, id);
  });

export const EventThreatDetectionSettingsCustomModuleProvider = () =>
  Provider.succeed(EventThreatDetectionSettingsCustomModule, {
    stables: ["name", "moduleId", "project", "type", "ancestorModule"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceOn(olds?.moduleId ?? output?.moduleId, news.moduleId) ??
        replaceOn(olds?.type ?? output?.type, news.type)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const moduleId = olds?.moduleId ?? output?.moduleId;
      const name =
        output?.name ?? (moduleId ? resourceName(env.project, moduleId) : "");
      const existing = yield* observe(env.project, id, name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listModules(env.project);
        return items
          .filter((module) => hasOwnershipMarker(module.description))
          .map((module) => toAttrs(module, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = etdSettingsParent(`projects/${env.project}`);
      const moduleId = news.moduleId ?? output?.moduleId;
      const name =
        output?.name ?? (moduleId ? resourceName(env.project, moduleId) : "");
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const enablementState = news.enablementState ?? "ENABLED";
      const displayName =
        news.displayName ??
        etdDisplayNameOf(
          yield* createPhysicalName({
            id,
            maxLength: 63,
            lowercase: true,
          }),
        );
      const body: scc.EventThreatDetectionCustomModule = {
        type: news.type,
        displayName,
        description,
        enablementState,
        config: news.config,
        cloudProvider: news.cloudProvider,
      };

      let current = yield* observe(env.project, id, name);

      if (current === undefined) {
        const created =
          yield* scc.createProjectsEventThreatDetectionSettingsCustomModules({
            parent,
            body,
          });
        current = created;
      }

      if (current === undefined) {
        return yield* new EventThreatDetectionSettingsCustomModuleNotResolved({
          name: name || parent,
        });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const enablementChanged = !sameText(
        current.enablementState,
        enablementState,
      );
      const configChanged = !jsonEqual(current.config, news.config);
      const updateMask = updateMaskOf(
        displayChanged ? "display_name" : undefined,
        descriptionChanged ? "description" : undefined,
        enablementChanged ? "enablement_state" : undefined,
        configChanged ? "config" : undefined,
      );

      if (updateMask.length > 0) {
        current =
          yield* scc.patchProjectsEventThreatDetectionSettingsCustomModules({
            name: currentName,
            updateMask,
            body: {
              displayName,
              description,
              enablementState,
              config: news.config,
            },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* scc
        .deleteProjectsEventThreatDetectionSettingsCustomModules({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
