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
  ApihubInstanceFailed,
  ApihubNotResolved,
  encodeOwnershipLine,
  hasOwnershipMarker,
  locationParent,
  MAX_PLUGIN_INSTANCE_DISPLAY_NAME_LENGTH,
  normalizeLocation,
  ownedByAlchemy,
  ownershipLabels,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";
import { waitForDeleteOperation, waitForOperation } from "./internal.ts";

export type PluginInstanceAction =
  apihub.GoogleCloudApihubV1PluginInstanceAction;
export type AuthConfig = apihub.GoogleCloudApihubV1AuthConfig;
export type ConfigVariableMap = apihub.GoogleCloudApihubV1ConfigVariableMap;
export type SourceEnvironmentMap =
  apihub.GoogleCloudApihubV1SourceEnvironmentMap;

export type PluginsInstanceProps = {
  /**
   * Parent plugin resource name
   * `projects/{project}/locations/{location}/plugins/{plugin}`.
   * Immutable — changing it replaces the instance.
   */
  plugin: string;
  /**
   * Plugin instance id (the `{instance}` segment). If omitted, a unique
   * id is generated. Immutable — changing it replaces the instance.
   */
  pluginInstanceId?: string;
  /**
   * Location of the API Hub instance. Defaults to the parent plugin's
   * location. Immutable — changing it replaces the instance.
   */
  location?: string;
  /**
   * Display name. Max 255 characters. Plugin instances have no
   * description, so Alchemy stamps ownership into a `[alchemy …]` prefix
   * and strips it from attributes.
   */
  displayName?: string;
  /**
   * Actions this instance should run. Each `actionId` must match an
   * action on the parent plugin. Defaults to `{ actionId: "sync-metadata" }`.
   */
  actions?: PluginInstanceAction[];
  /**
   * Authentication configuration for this instance.
   */
  authConfig?: AuthConfig;
  /**
   * Additional config variables keyed by template id.
   */
  additionalConfig?: ConfigVariableMap;
  /**
   * Source project id (runtime project for Google Cloud plugins).
   */
  sourceProjectId?: string;
  /**
   * Source environment config keyed by environment name.
   */
  sourceEnvironmentsConfig?: SourceEnvironmentMap;
};

export type PluginsInstance = Resource<
  "GCP.ApiHub.PluginsInstance",
  PluginsInstanceProps,
  {
    /** Full resource name. */
    name: string;
    /** Plugin instance id (last path segment). */
    pluginInstanceId: string;
    /** Parent plugin resource name. */
    plugin: string;
    /** Parent plugin id. */
    pluginId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Actions. */
    actions: PluginInstanceAction[] | undefined;
    /** Auth config. */
    authConfig: AuthConfig | undefined;
    /** Additional config. */
    additionalConfig: ConfigVariableMap | undefined;
    /** Source project id. */
    sourceProjectId: string | undefined;
    /** Source environment config. */
    sourceEnvironmentsConfig: SourceEnvironmentMap | undefined;
    /** Instance state. */
    state: string | undefined;
    /** Error message when state is ERROR or FAILED. */
    errorMessage: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An API Hub plugin instance — a configured running copy of a plugin.
 *
 * Plugin instances have no labels or description, so Alchemy stamps
 * ownership into the display name for `list` / nuke. Plugin, location,
 * and instance id are identity. Display name (and schedule cron on
 * actions) update in place; auth/additional config changes replace the
 * instance because ApplyPluginInstanceConfig is not in the distilled SDK.
 *
 * ### Creating a Plugin Instance
 * **Example:** Instance of a user-owned plugin
 * ```typescript
 * const plugin = yield* GCP.ApiHub.Plugin("OnRamp", {
 *   displayName: "on-ramp",
 * });
 * const instance = yield* GCP.ApiHub.PluginsInstance("Collector", {
 *   plugin: plugin.name,
 *   displayName: "orders collector",
 * });
 * ```
 *
 * **Example:** Named instance with an explicit action
 * ```typescript
 * const instance = yield* GCP.ApiHub.PluginsInstance("Collector", {
 *   plugin: plugin.name,
 *   pluginInstanceId: "orders-collector",
 *   actions: [{ actionId: "sync-metadata" }],
 * });
 * ```
 *
 * @resource
 * @category ApiHub
 */
export const PluginsInstance = Resource<PluginsInstance>(
  "GCP.ApiHub.PluginsInstance",
);

const DEFAULT_ACTIONS: PluginInstanceAction[] = [{ actionId: "sync-metadata" }];

const resourceName = (plugin: string, pluginInstanceId: string) =>
  `${plugin}/instances/${pluginInstanceId}`;

const toAttrs = (
  instance: apihub.GoogleCloudApihubV1PluginInstance,
  project: string,
  region: string,
): PluginsInstance["Attributes"] => {
  const name = instance.name ?? "";
  const parsed = parseName(name, "instances", region);
  const { text } = parseOwnership(instance.displayName);
  return {
    name,
    pluginInstanceId: parsed.id,
    plugin: parsed.plugin ?? parsed.parent,
    pluginId: parsed.pluginId,
    project: parsed.project || project,
    location: parsed.location,
    displayName: text,
    actions: instance.actions,
    authConfig: instance.authConfig,
    additionalConfig: instance.additionalConfig,
    sourceProjectId: instance.sourceProjectId,
    sourceEnvironmentsConfig: instance.sourceEnvironmentsConfig,
    state: instance.state === undefined ? undefined : `${instance.state}`,
    errorMessage: instance.errorMessage,
    createTime: instance.createTime,
    updateTime: instance.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apihub
        .getProjectsLocationsPluginsInstances({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  apihub.listProjectsLocationsPluginsInstances
    .pages({ parent, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.pluginInstances ?? [])),
      Stream.filter((item) => hasOwnershipMarker(item.displayName)),
      Stream.map((item) => toAttrs(item, project, region)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (current): current is apihub.GoogleCloudApihubV1PluginInstance =>
        current !== undefined &&
        current.state !== "CREATING" &&
        current.state !== "APPLYING_CONFIG",
      () => new ApihubNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ApiHub.ResourceNotResolved",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
    Effect.flatMap((current) => {
      if (current.state === "ERROR" || current.state === "FAILED") {
        return Effect.fail(
          new ApihubInstanceFailed({
            name,
            state: current.state,
            message: current.errorMessage,
          }),
        );
      }
      return Effect.succeed(current);
    }),
  );

const scheduleOf = (actions: PluginInstanceAction[] | undefined) =>
  (actions ?? []).map((action) => ({
    actionId: action.actionId,
    scheduleCronExpression: action.scheduleCronExpression ?? "",
    scheduleTimeZone: action.scheduleTimeZone ?? "",
  }));

export const PluginsInstanceProvider = () =>
  Provider.succeed(PluginsInstance, {
    stables: [
      "name",
      "pluginInstanceId",
      "plugin",
      "pluginId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const extra =
        olds !== undefined &&
        (!sameJson(news.authConfig, olds.authConfig) ||
          !sameJson(news.additionalConfig, olds.additionalConfig) ||
          !sameText(news.sourceProjectId, olds.sourceProjectId) ||
          !sameJson(
            news.sourceEnvironmentsConfig,
            olds.sourceEnvironmentsConfig,
          ) ||
          !sameJson(
            (news.actions ?? DEFAULT_ACTIONS).map((action) => action.actionId),
            (olds.actions ?? DEFAULT_ACTIONS).map((action) => action.actionId),
          ));
      const previousPlugin = olds?.plugin ?? output?.plugin;
      const pluginChanged =
        previousPlugin !== undefined &&
        news.plugin !== undefined &&
        news.plugin !== previousPlugin;
      const identity = replaceOnIdentity({
        previousId: olds?.pluginInstanceId ?? output?.pluginInstanceId,
        nextId:
          news.pluginInstanceId ??
          olds?.pluginInstanceId ??
          output?.pluginInstanceId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra: extra || pluginChanged,
      });
      if (identity !== undefined) return identity;
      if (pluginChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const plugin = olds?.plugin ?? output?.plugin ?? "";
      const pluginInstanceId = yield* toPhysicalId(
        id,
        olds?.pluginInstanceId,
        output?.pluginInstanceId,
      );
      const name =
        output?.name ??
        (plugin.length > 0 ? resourceName(plugin, pluginInstanceId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listAt(
          `${locationParent(env.project, env.region)}/plugins/-`,
          env.project,
          env.region,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const plugin = news.plugin;
      const parsedPlugin = parseName(plugin, "plugins", env.region);
      const location = normalizeLocation(
        news.location ?? parsedPlugin.location ?? output?.location,
        env.region,
      );
      const pluginName = plugin.includes("/")
        ? plugin
        : `${locationParent(env.project, location)}/plugins/${plugin}`;
      const pluginInstanceId = yield* toPhysicalId(
        id,
        news.pluginInstanceId,
        output?.pluginInstanceId,
      );
      const name = resourceName(pluginName, pluginInstanceId);
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName,
        MAX_PLUGIN_INSTANCE_DISPLAY_NAME_LENGTH,
      );
      const actions = news.actions ?? DEFAULT_ACTIONS;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apihub
          .createProjectsLocationsPluginsInstances({
            parent: pluginName,
            pluginInstanceId,
            body: {
              displayName,
              actions,
              authConfig: news.authConfig,
              additionalConfig: news.additionalConfig,
              sourceProjectId: news.sourceProjectId,
              sourceEnvironmentsConfig: news.sourceEnvironmentsConfig,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
          current = yield* waitUntilExists(getByName(name), name);
        }
        if (current === undefined) {
          current = yield* waitUntilExists(getByName(name), name).pipe(
            Effect.catchTag("GCP.ApiHub.ResourceNotResolved", () =>
              Effect.succeed(undefined),
            ),
          );
        }
      }

      if (current === undefined) {
        return yield* new ApihubNotResolved({ name });
      }

      const currentName = current.name ?? name;
      let ready = yield* waitUntilReady(currentName);

      const observedDisplay = parseOwnership(ready.displayName).text;
      const displayChanged = !sameText(observedDisplay, news.displayName);
      const scheduleChanged = !sameJson(
        scheduleOf(ready.actions),
        scheduleOf(actions),
      );
      const updateMask = updateMaskOf(
        displayChanged ? "display_name" : undefined,
        scheduleChanged ? "actions" : undefined,
      );

      if (updateMask.length > 0) {
        ready = yield* apihub.patchProjectsLocationsPluginsInstances({
          name: currentName,
          updateMask,
          body: {
            name: currentName,
            displayName,
            actions,
          },
        });
      }

      return toAttrs(ready, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apihub
        .deleteProjectsLocationsPluginsInstances({ name: output.name })
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
