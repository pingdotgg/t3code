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
  organizationIdOf,
  organizationParent,
  ownedByAlchemy,
  parseOwnership,
  replaceOn,
  resolveOrganization,
  sameText,
  shaDisplayNameOf,
  shaSettingsParent,
  tryResolveOrganization,
  updateMaskOf,
} from "./internal.ts";
import type {
  CustomConfig,
  SecurityHealthAnalyticsCloudProvider,
  SecurityHealthAnalyticsEnablementState,
  SecurityHealthAnalyticsSeverity,
} from "./SecurityHealthAnalyticsSettingsCustomModule.ts";

export type OrganizationsSecurityHealthAnalyticsSettingsCustomModuleProps = {
  /**
   * Module id (the `{customModule}` segment of
   * `organizations/{organization}/securityHealthAnalyticsSettings/customModules/{customModule}`).
   * Server-assigned on create. Supply it to target an existing module.
   * Immutable — changing it replaces the module.
   */
  moduleId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric id).
   * Defaults to the project's Resource Manager
   * ancestor. Immutable — changing it replaces the module.
   */
  organization?: string;
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

export type OrganizationsSecurityHealthAnalyticsSettingsCustomModule = Resource<
  "GCP.SecurityCenter.OrganizationsSecurityHealthAnalyticsSettingsCustomModule",
  OrganizationsSecurityHealthAnalyticsSettingsCustomModuleProps,
  {
    /** Full resource name `organizations/{organization}/securityHealthAnalyticsSettings/customModules/{customModule}`. */
    name: string;
    /** Module id (last path segment). */
    moduleId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Project id of the deploying stack. */
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
 * An organization-scoped Security Health Analytics custom module.
 *
 * Custom modules have no labels field — Alchemy stamps ownership into
 * `customConfig.description` so `list` / nuke can find them. Module id,
 * organization, and display name are identity (the id is server-assigned).
 * Enablement and custom config update in place.
 *
 * ### Creating a Custom Module
 * **Example:** Always-true compute instance check
 * ```typescript
 * const module = yield* GCP.SecurityCenter.OrganizationsSecurityHealthAnalyticsSettingsCustomModule(
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
 * **Example:** Named module on an explicit organization
 * ```typescript
 * const module = yield* GCP.SecurityCenter.OrganizationsSecurityHealthAnalyticsSettingsCustomModule(
 *   "AlwaysTrue",
 *   {
 *     organization: "organizations/123456789",
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
export const OrganizationsSecurityHealthAnalyticsSettingsCustomModule =
  Resource<OrganizationsSecurityHealthAnalyticsSettingsCustomModule>(
    "GCP.SecurityCenter.OrganizationsSecurityHealthAnalyticsSettingsCustomModule",
  );

export class OrganizationsSecurityHealthAnalyticsSettingsCustomModuleNotResolved extends Data.TaggedError(
  "GCP.SecurityCenter.OrganizationsSecurityHealthAnalyticsSettingsCustomModuleNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organization: string, moduleId: string) =>
  `${organization}/securityHealthAnalyticsSettings/customModules/${moduleId}`;

const customConfigOf = (
  config: scc.GoogleCloudSecuritycenterV1CustomConfig | undefined,
): CustomConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    predicate: config.predicate,
    resourceSelector: config.resourceSelector,
    severity: config.severity as SecurityHealthAnalyticsSeverity | undefined,
    description: parseOwnership(config.description).text,
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
  organization: string,
  project: string,
) => {
  const name = module.name ?? "";
  return {
    name,
    moduleId: lastSegment(name),
    organization,
    organizationId: organizationIdOf(organization),
    project,
    displayName: module.displayName,
    enablementState: module.enablementState,
    customConfig: customConfigOf(module.customConfig),
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
        .getOrganizationsSecurityHealthAnalyticsSettingsCustomModules({
          name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listModules = (organization: string) =>
  collectPages(
    scc.listOrganizationsSecurityHealthAnalyticsSettingsCustomModules.pages({
      parent: shaSettingsParent(organization),
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

const observe = (organization: string, id: string, name: string) =>
  Effect.gen(function* () {
    const existing = yield* getByName(name);
    if (existing !== undefined) return existing;
    const items = yield* listModules(organization);
    return yield* findOwned(
      items,
      (item) => item.customConfig?.description,
      id,
    );
  });

export const OrganizationsSecurityHealthAnalyticsSettingsCustomModuleProvider =
  () =>
    Provider.succeed(OrganizationsSecurityHealthAnalyticsSettingsCustomModule, {
      stables: [
        "name",
        "moduleId",
        "organization",
        "organizationId",
        "project",
        "displayName",
        "ancestorModule",
      ],

      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        return (
          replaceOn(olds?.moduleId ?? output?.moduleId, news.moduleId) ??
          replaceOn(
            olds?.organization ?? output?.organization,
            news.organization === undefined
              ? undefined
              : organizationParent(news.organization),
          ) ??
          replaceOn(olds?.displayName ?? output?.displayName, news.displayName)
        );
      }),

      read: Effect.fn(function* ({ id, olds, output }) {
        const env = yield* GcpEnvironment.current;
        const organization = yield* resolveOrganization(
          olds?.organization ?? output?.organization,
          output?.organization,
        );
        const moduleId = olds?.moduleId ?? output?.moduleId;
        const name =
          output?.name ??
          (moduleId ? resourceName(organization, moduleId) : "");
        const existing = yield* observe(organization, id, name);
        if (existing === undefined) return undefined;
        const attrs = toAttrs(existing, organization, env.project);
        return (yield* ownedByAlchemy(id, existing.customConfig?.description))
          ? attrs
          : Unowned(attrs);
      }),

      list: () =>
        Effect.gen(function* () {
          const env = yield* GcpEnvironment.current;
          const organization = yield* tryResolveOrganization();
          if (organization === undefined) return [];
          const items = yield* listModules(organization);
          return items
            .filter((module) =>
              hasOwnershipMarker(module.customConfig?.description),
            )
            .map((module) => toAttrs(module, organization, env.project));
        }),

      reconcile: Effect.fn(function* ({ id, news, output }) {
        const env = yield* GcpEnvironment.current;
        const organization = yield* resolveOrganization(
          news.organization,
          output?.organization,
        );
        const parent = shaSettingsParent(organization);
        const moduleId = news.moduleId ?? output?.moduleId;
        const name =
          output?.name ??
          (moduleId ? resourceName(organization, moduleId) : "");
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

        let current = yield* observe(organization, id, name);

        if (current === undefined) {
          current =
            yield* scc.createOrganizationsSecurityHealthAnalyticsSettingsCustomModules(
              {
                parent,
                body,
              },
            );
        }

        if (current === undefined) {
          return yield* new OrganizationsSecurityHealthAnalyticsSettingsCustomModuleNotResolved(
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
        const configChanged = !jsonEqual(current.customConfig, customConfig);
        const updateMask = updateMaskOf(
          enablementChanged ? "enablement_state" : undefined,
          configChanged ? "custom_config" : undefined,
        );

        if (updateMask.length > 0) {
          current =
            yield* scc.patchOrganizationsSecurityHealthAnalyticsSettingsCustomModules(
              {
                name: currentName,
                updateMask,
                body: {
                  enablementState,
                  customConfig,
                },
              },
            );
        }

        return toAttrs(current, organization, env.project);
      }),

      delete: Effect.fn(function* ({ output }) {
        yield* scc
          .deleteOrganizationsSecurityHealthAnalyticsSettingsCustomModules({
            name: output.name,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    });
