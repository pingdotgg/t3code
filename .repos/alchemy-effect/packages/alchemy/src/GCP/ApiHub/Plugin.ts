import * as apihub from "@distilled.cloud/gcp/apihub_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  ApihubNotResolved,
  DEFAULT_PLUGIN_ACTIONS,
  encodeOwnership,
  hasOwnershipMarker,
  locationParent,
  MAX_PLUGIN_DISPLAY_NAME_LENGTH,
  normalizeLocation,
  ownedByAlchemy,
  ownershipLabels,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  sameJson,
  sameText,
  toPhysicalId,
  waitUntilGone,
} from "./internal.ts";
import { waitForDeleteOperation } from "./internal.ts";

type PluginActionConfig = apihub.GoogleCloudApihubV1PluginActionConfig;
type PluginCategory = apihub.GoogleCloudApihubV1PluginPluginCategoryEnum;
type PluginGatewayType = apihub.GoogleCloudApihubV1PluginGatewayTypeEnum;
type HostingService = apihub.GoogleCloudApihubV1HostingService;
type ConfigTemplate = apihub.GoogleCloudApihubV1ConfigTemplate;
type AttributeValues = apihub.GoogleCloudApihubV1AttributeValues;
type Documentation = apihub.GoogleCloudApihubV1Documentation;

export type PluginProps = {
  /**
   * Plugin id (the `{plugin}` segment of
   * `projects/{project}/locations/{location}/plugins/{plugin}`). If
   * omitted, a unique id is generated. Immutable — changing it replaces
   * the plugin.
   */
  pluginId?: string;
  /**
   * Location of the API Hub instance (`us-central1`, …). Immutable —
   * changing it replaces the plugin.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Max 50 characters.
   */
  displayName?: string;
  /**
   * Human-readable description. Plugins have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from
   * attributes. The API has no patch for plugins, so changing description
   * (or other body fields) replaces the plugin.
   */
  description?: string;
  /**
   * Documentation URI that explains how to set up the plugin.
   */
  documentation?: Documentation;
  /**
   * Category of the plugin.
   * @default "API_PRODUCER"
   */
  pluginCategory?: PluginCategory | (string & {});
  /**
   * Gateway type for on-ramp plugins.
   */
  gatewayType?: PluginGatewayType | (string & {});
  /**
   * Actions supported by the plugin. Required by the API; a default
   * on-demand `sync-metadata` action is used when omitted.
   */
  actionsConfig?: PluginActionConfig[];
  /**
   * Hosting service URI for user-defined plugins.
   */
  hostingService?: HostingService;
  /**
   * Configuration template (auth + additional variables).
   */
  configTemplate?: ConfigTemplate;
  /**
   * Plugin type (`system-plugin-type` attribute).
   */
  type?: AttributeValues;
  /**
   * When false, disable the plugin after it exists. User-owned plugins
   * created via the plugin framework manage state at the instance level.
   * @default true
   */
  enabled?: boolean;
};

export type Plugin = Resource<
  "GCP.ApiHub.Plugin",
  PluginProps,
  {
    /** Full resource name. */
    name: string;
    /** Plugin id (last path segment). */
    pluginId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Documentation. */
    documentation: Documentation | undefined;
    /** Category. */
    pluginCategory: string | undefined;
    /** Gateway type. */
    gatewayType: string | undefined;
    /** Action configuration. */
    actionsConfig: PluginActionConfig[] | undefined;
    /** Hosting service. */
    hostingService: HostingService | undefined;
    /** Config template. */
    configTemplate: ConfigTemplate | undefined;
    /** Plugin type attribute. */
    type: AttributeValues | undefined;
    /** Ownership type (`SYSTEM_OWNED` or `USER_OWNED`). */
    ownershipType: string | undefined;
    /** Plugin state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An API Hub plugin — a user-owned or system-owned connector that
 * publishes API metadata into Hub.
 *
 * Plugins have no labels and no patch RPC, so Alchemy stamps ownership
 * into the description and treats body-field changes as replacements.
 * Enable/disable syncs in place. Location and plugin id are identity.
 *
 * ### Creating a Plugin
 * **Example:** Generated id with the default action
 * ```typescript
 * const plugin = yield* GCP.ApiHub.Plugin("OnRamp", {
 *   displayName: "on-ramp",
 *   description: "custom collector",
 * });
 * ```
 *
 * **Example:** Named plugin with an explicit action
 * ```typescript
 * const plugin = yield* GCP.ApiHub.Plugin("OnRamp", {
 *   pluginId: "orders-onramp",
 *   displayName: "orders on-ramp",
 *   pluginCategory: "API_PRODUCER",
 *   actionsConfig: [
 *     {
 *       id: "sync-metadata",
 *       displayName: "Sync metadata",
 *       description: "pull specs",
 *       triggerMode: "API_HUB_ON_DEMAND_TRIGGER",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category ApiHub
 */
export const Plugin = Resource<Plugin>("GCP.ApiHub.Plugin");

const resourceName = (project: string, location: string, pluginId: string) =>
  `${locationParent(project, location)}/plugins/${pluginId}`;

const toAttrs = (
  plugin: apihub.GoogleCloudApihubV1Plugin,
  project: string,
  region: string,
) => {
  const name = plugin.name ?? "";
  const parsed = parseName(name, "plugins", region);
  const { text } = parseOwnership(plugin.description);
  return {
    name,
    pluginId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: plugin.displayName,
    description: text,
    documentation: plugin.documentation,
    pluginCategory: plugin.pluginCategory,
    gatewayType: plugin.gatewayType,
    actionsConfig: plugin.actionsConfig,
    hostingService: plugin.hostingService,
    configTemplate: plugin.configTemplate,
    type: plugin.type,
    ownershipType: plugin.ownershipType,
    state: plugin.state,
    createTime: plugin.createTime,
    updateTime: plugin.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apihub
        .getProjectsLocationsPlugins({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  apihub.listProjectsLocationsPlugins.pages({ parent, pageSize: 1000 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.plugins ?? [])),
    Stream.filter((item) => hasOwnershipMarker(item.description)),
    Stream.map((item) => toAttrs(item, project, region)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

const actionsOf = (news: PluginProps) =>
  news.actionsConfig ?? DEFAULT_PLUGIN_ACTIONS;

const categoryOf = (news: PluginProps) => news.pluginCategory ?? "API_PRODUCER";

const displayNameOf = (news: PluginProps, pluginId: string) =>
  (news.displayName ?? pluginId).slice(0, MAX_PLUGIN_DISPLAY_NAME_LENGTH);

export const PluginProvider = () =>
  Provider.succeed(Plugin, {
    stables: ["name", "pluginId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const extra =
        olds !== undefined &&
        (!sameText(news.displayName, olds.displayName) ||
          !sameText(news.description, olds.description) ||
          !sameJson(news.documentation, olds.documentation) ||
          !sameJson(news.actionsConfig, olds.actionsConfig) ||
          !sameText(news.pluginCategory, olds.pluginCategory) ||
          !sameText(news.gatewayType, olds.gatewayType) ||
          !sameJson(news.hostingService, olds.hostingService) ||
          !sameJson(news.configTemplate, olds.configTemplate) ||
          !sameJson(news.type, olds.type));
      return replaceOnIdentity({
        previousId: olds?.pluginId ?? output?.pluginId,
        nextId: news.pluginId ?? olds?.pluginId ?? output?.pluginId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const pluginId = yield* toPhysicalId(
        id,
        olds?.pluginId,
        output?.pluginId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, pluginId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listAt(
          locationParent(env.project, env.region),
          env.project,
          env.region,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const pluginId = yield* toPhysicalId(id, news.pluginId, output?.pluginId);
      const name = resourceName(env.project, location, pluginId);
      const ownership = yield* ownershipLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = displayNameOf(news, pluginId);
      const parent = locationParent(env.project, location);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apihub
          .createProjectsLocationsPlugins({
            parent,
            pluginId,
            body: {
              displayName,
              description,
              documentation: news.documentation,
              pluginCategory: categoryOf(news),
              gatewayType: news.gatewayType,
              actionsConfig: actionsOf(news),
              hostingService: news.hostingService,
              configTemplate: news.configTemplate,
              type: news.type,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? (yield* getByName(name));
      }

      if (current === undefined) {
        return yield* new ApihubNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const desiredEnabled = news.enabled !== false;
      const currentlyEnabled = current.state !== "DISABLED";
      if (desiredEnabled !== currentlyEnabled) {
        current = desiredEnabled
          ? yield* apihub.enableProjectsLocationsPlugins({
              name: currentName,
              body: {},
            })
          : yield* apihub.disableProjectsLocationsPlugins({
              name: currentName,
              body: {},
            });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apihub
        .deleteProjectsLocationsPlugins({ name: output.name })
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
