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
  findOwned,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  ownedByAlchemy,
  parseOwnership,
  projectOf,
  replaceOn,
  sameText,
  shaDisplayNameOf,
  shaSettingsParent,
  updateMaskOf,
} from "./internal.ts";

export type SecurityHealthAnalyticsEnablementState =
  | "ENABLEMENT_STATE_UNSPECIFIED"
  | "ENABLED"
  | "DISABLED"
  | "INHERITED";

export type SecurityHealthAnalyticsCloudProvider =
  | "CLOUD_PROVIDER_UNSPECIFIED"
  | "GOOGLE_CLOUD_PLATFORM"
  | "AMAZON_WEB_SERVICES"
  | "MICROSOFT_AZURE";

export type SecurityHealthAnalyticsSeverity =
  | "SEVERITY_UNSPECIFIED"
  | "CRITICAL"
  | "HIGH"
  | "MEDIUM"
  | "LOW";

export type Expr = {
  /** CEL expression. */
  expression?: string;
  /** Short title. */
  title?: string;
  /** Human-readable description. */
  description?: string;
  /** Source location of the expression. */
  location?: string;
};

export type CustomOutputProperty = {
  /** Property name. */
  name?: string;
  /** CEL expression that produces the property value. */
  valueExpression?: Expr;
};

export type CustomConfig = {
  /** CEL predicate that selects resources. */
  predicate?: Expr;
  /** Resource types this module inspects. */
  resourceSelector?: {
    /** Fully-qualified resource type names. */
    resourceTypes?: string[];
  };
  /** Finding severity. */
  severity?: SecurityHealthAnalyticsSeverity;
  /**
   * Finding description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix here (custom modules have no labels) and stripped from
   * attributes.
   */
  description?: string;
  /** Recommended next steps. */
  recommendation?: string;
  /** Extra properties written onto findings. */
  customOutput?: {
    properties?: CustomOutputProperty[];
  };
};

export type SecurityHealthAnalyticsSettingsCustomModuleProps = {
  /**
   * Module id (the `{customModule}` segment of
   * `projects/{project}/securityHealthAnalyticsSettings/customModules/{customModule}`).
   * Server-assigned on create. Supply it to target an existing module.
   * Immutable — changing it replaces the module.
   */
  moduleId?: string;
  /**
   * Display name. Becomes the finding category. Must start with an
   * uppercase letter, contain only letters, digits, or underscores, and
   * be at most 128 characters. Immutable — changing it replaces the
   * module.
   */
  displayName?: string;
  /**
   * Enablement state at this parent.
   * @default "ENABLED"
   */
  enablementState?: SecurityHealthAnalyticsEnablementState;
  /**
   * Detection configuration. Required on create.
   */
  customConfig: CustomConfig;
  /**
   * Cloud provider this module applies to.
   */
  cloudProvider?: SecurityHealthAnalyticsCloudProvider;
};

export type SecurityHealthAnalyticsSettingsCustomModule = Resource<
  "GCP.SecurityCenter.SecurityHealthAnalyticsSettingsCustomModule",
  SecurityHealthAnalyticsSettingsCustomModuleProps,
  {
    /** Full resource name `projects/{project}/securityHealthAnalyticsSettings/customModules/{customModule}`. */
    name: string;
    /** Module id (last path segment). */
    moduleId: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** Enablement state. */
    enablementState: string | undefined;
    /** Detection configuration with the Alchemy ownership prefix stripped. */
    customConfig: CustomConfig | undefined;
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
 * A project-scoped Security Health Analytics custom module.
 *
 * Custom modules have no labels field — Alchemy stamps ownership into
 * `customConfig.description` so `list` / nuke can find them. Module id
 * and display name are identity (the id is server-assigned). Enablement
 * and custom config update in place.
 *
 * ### Creating a Custom Module
 * **Example:** Always-true compute instance check
 * ```typescript
 * const module = yield* GCP.SecurityCenter.SecurityHealthAnalyticsSettingsCustomModule(
 *   "AlwaysTrue",
 *   {
 *     displayName: "AlchemyAlwaysTrue",
 *     customConfig: {
 *       predicate: { expression: 'resource.name == "alchemy-nonexistent"' },
 *       resourceSelector: {
 *         resourceTypes: ["compute.googleapis.com/Instance"],
 *       },
 *       severity: "LOW",
 *       description: "always true",
 *       recommendation: "n/a",
 *     },
 *   },
 * );
 * ```
 *
 * ### Updating a Custom Module
 * **Example:** Disable the module
 * ```typescript
 * const module = yield* GCP.SecurityCenter.SecurityHealthAnalyticsSettingsCustomModule(
 *   "AlwaysTrue",
 *   {
 *     enablementState: "DISABLED",
 *     displayName: "AlchemyAlwaysTrue",
 *     customConfig: {
 *       predicate: { expression: 'resource.name == "alchemy-nonexistent"' },
 *       resourceSelector: {
 *         resourceTypes: ["compute.googleapis.com/Instance"],
 *       },
 *       severity: "LOW",
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category SecurityCenter
 */
export const SecurityHealthAnalyticsSettingsCustomModule =
  Resource<SecurityHealthAnalyticsSettingsCustomModule>(
    "GCP.SecurityCenter.SecurityHealthAnalyticsSettingsCustomModule",
  );

export class SecurityHealthAnalyticsSettingsCustomModuleNotResolved extends Data.TaggedError(
  "GCP.SecurityCenter.SecurityHealthAnalyticsSettingsCustomModuleNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, moduleId: string) =>
  `projects/${project}/securityHealthAnalyticsSettings/customModules/${moduleId}`;

const customConfigOf = (
  config: scc.GoogleCloudSecuritycenterV1CustomConfig | undefined,
  stripOwnership: boolean,
): CustomConfig | undefined => {
  if (config === undefined) return undefined;
  const description = stripOwnership
    ? parseOwnership(config.description).text
    : config.description;
  return {
    predicate: config.predicate,
    resourceSelector: config.resourceSelector,
    severity: config.severity as SecurityHealthAnalyticsSeverity | undefined,
    description,
    recommendation: config.recommendation,
    customOutput: config.customOutput,
  };
};

const desiredCustomConfig = (
  config: CustomConfig,
  ownership: Record<string, string>,
): scc.GoogleCloudSecuritycenterV1CustomConfig => ({
  ...config,
  description: encodeOwnership(ownership, config.description),
});

const toAttrs = (
  module: scc.GoogleCloudSecuritycenterV1SecurityHealthAnalyticsCustomModule,
  project: string,
) => {
  const name = module.name ?? "";
  return {
    name,
    moduleId: lastSegment(name),
    project: projectOf(name) || project,
    displayName: module.displayName,
    enablementState: module.enablementState,
    customConfig: customConfigOf(module.customConfig, true),
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
        .getProjectsSecurityHealthAnalyticsSettingsCustomModules({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listModules = (project: string) =>
  collectPages(
    scc.listProjectsSecurityHealthAnalyticsSettingsCustomModules.pages({
      parent: shaSettingsParent(`projects/${project}`),
      pageSize: 100,
    }),
    (page) => page.securityHealthAnalyticsCustomModules,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed(
        [] as scc.GoogleCloudSecuritycenterV1SecurityHealthAnalyticsCustomModule[],
      ),
    ),
  );

const observe = (project: string, id: string, name: string) =>
  Effect.gen(function* () {
    const existing = yield* getByName(name);
    if (existing !== undefined) return existing;
    const items = yield* listModules(project);
    return yield* findOwned(
      items,
      (item) => item.customConfig?.description,
      id,
    );
  });

export const SecurityHealthAnalyticsSettingsCustomModuleProvider = () =>
  Provider.succeed(SecurityHealthAnalyticsSettingsCustomModule, {
    stables: ["name", "moduleId", "project", "displayName", "ancestorModule"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceOn(olds?.moduleId ?? output?.moduleId, news.moduleId) ??
        replaceOn(olds?.displayName ?? output?.displayName, news.displayName)
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
      return (yield* ownedByAlchemy(id, existing.customConfig?.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listModules(env.project);
        return items
          .filter((module) =>
            hasOwnershipMarker(module.customConfig?.description),
          )
          .map((module) => toAttrs(module, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = shaSettingsParent(`projects/${env.project}`);
      const moduleId = news.moduleId ?? output?.moduleId;
      const name =
        output?.name ?? (moduleId ? resourceName(env.project, moduleId) : "");
      const ownership = yield* createInternalLabels(id);
      const customConfig = desiredCustomConfig(news.customConfig, ownership);
      const enablementState = news.enablementState ?? "ENABLED";
      const displayName =
        news.displayName ??
        shaDisplayNameOf(
          yield* createPhysicalName({
            id,
            maxLength: 63,
            lowercase: true,
          }),
        );
      const body: scc.GoogleCloudSecuritycenterV1SecurityHealthAnalyticsCustomModule =
        {
          displayName,
          enablementState,
          customConfig,
          cloudProvider: news.cloudProvider,
        };

      let current = yield* observe(env.project, id, name);

      if (current === undefined) {
        current =
          yield* scc.createProjectsSecurityHealthAnalyticsSettingsCustomModules(
            {
              parent,
              body,
            },
          );
      }

      if (current === undefined) {
        return yield* new SecurityHealthAnalyticsSettingsCustomModuleNotResolved(
          {
            name: name || parent,
          },
        );
      }

      const currentName = current.name ?? name;
      const enablementChanged = !sameText(
        current.enablementState,
        enablementState,
      );
      const configChanged = !jsonEqual(
        {
          ...current.customConfig,
          description: current.customConfig?.description,
        },
        customConfig,
      );
      const updateMask = updateMaskOf(
        enablementChanged ? "enablement_state" : undefined,
        configChanged ? "custom_config" : undefined,
      );

      if (updateMask.length > 0) {
        current =
          yield* scc.patchProjectsSecurityHealthAnalyticsSettingsCustomModules({
            name: currentName,
            updateMask,
            body: {
              enablementState,
              customConfig,
            },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* scc
        .deleteProjectsSecurityHealthAnalyticsSettingsCustomModules({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
