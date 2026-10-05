import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
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
  DEFAULT_GLOBAL,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  sameJson,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "wasmPlugins";

export type WasmPluginLogLevel =
  | networkservices.WasmPluginLogConfigMinLogLevelEnum
  | (string & {});

export type WasmPluginLogConfig = {
  /**
   * Whether plugin activity logs are exported to Cloud Logging.
   * @default false
   */
  enable?: boolean;
  /**
   * Sampling rate in `[0.0, 1.0]` when logging is enabled. `1.0` reports
   * every log statement.
   * @default 1
   */
  sampleRate?: number;
  /**
   * Lowest plugin log level exported to Cloud Logging. Only set when
   * logging is enabled.
   * @default "INFO"
   */
  minLogLevel?: WasmPluginLogLevel;
};

export type WasmPluginVersionInput = {
  /** Human-readable description of this version. */
  description?: string;
  /** User labels on this version. Alchemy ownership labels are merged in. */
  labels?: Record<string, string>;
  /**
   * Artifact Registry URI of the image that contains `plugin.wasm`.
   * Docker (`LOCATION-docker.pkg.dev/...`) or generic artifact
   * (`projects/{project}/locations/{location}/repositories/{repository}/genericArtifacts/{package}:{version}`)
   * forms are accepted. Immutable on the child version resource.
   */
  imageUri?: string;
  /**
   * Base64-encoded plugin configuration delivered through `ON_CONFIGURE`.
   * Mutually exclusive with `pluginConfigUri`.
   */
  pluginConfigData?: string;
  /**
   * Artifact Registry URI of an image that contains `plugin.config`.
   * Mutually exclusive with `pluginConfigData`.
   */
  pluginConfigUri?: string;
};

export type WasmPluginVersionDetails = {
  /** User-provided description. */
  description: string | undefined;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** Image URI that supplied the Wasm module. */
  imageUri: string | undefined;
  /** Resolved image digest. */
  imageDigest: string | undefined;
  /** Plugin-config Artifact Registry URI, if set. */
  pluginConfigUri: string | undefined;
  /** Digest of plugin configuration. */
  pluginConfigDigest: string | undefined;
  /** RFC3339 creation timestamp. */
  createTime: string | undefined;
  /** RFC3339 last-update timestamp. */
  updateTime: string | undefined;
};

export type WasmPluginProps = {
  /**
   * WasmPlugin id (the `{wasmPlugin}` segment of
   * `projects/{project}/locations/{location}/wasmPlugins/{wasmPlugin}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and not start with a number.
   * Immutable — changing it replaces the plugin.
   */
  wasmPluginId?: string;
  /**
   * Location. Wasm plugins live in `global`. Immutable — changing it
   * replaces the plugin. `GLOBAL` is accepted and normalized to `global`.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Id of the currently serving `WasmPluginVersion`. Must name a child
   * version of this plugin. Omit until a version exists; updating this
   * field does not replace the plugin.
   */
  mainVersionId?: string;
  /**
   * Logging options for statements emitted by the Wasm module.
   */
  logConfig?: WasmPluginLogConfig;
  /**
   * Inline versions keyed by version id. When set, this map is
   * authoritative on create and update — omitted keys are deleted.
   * Leave unset to manage versions through `WasmPluginsVersion` without
   * the plugin wiping them on reconcile.
   */
  versions?: Record<string, WasmPluginVersionInput>;
};

export type WasmPlugin = Resource<
  "GCP.NetworkServices.WasmPlugin",
  WasmPluginProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/wasmPlugins/{wasmPlugin}`. */
    name: string;
    /** WasmPlugin id (last path segment). */
    wasmPluginId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Currently serving version id, if set. */
    mainVersionId: string | undefined;
    /** Logging configuration, if set. */
    logConfig: WasmPluginLogConfig | undefined;
    /** Inline versions from a full-view get. */
    versions: Record<string, WasmPluginVersionDetails>;
    /** Extension resource names that reference this plugin. */
    usedBy: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Services WasmPlugin — a Service Extensions plugin that
 * runs a customer-provided Wasm module.
 *
 * Changing `wasmPluginId` or `location` replaces the plugin.
 * Description, labels, `mainVersionId`, `logConfig`, and an explicit
 * `versions` map update in place. Child `WasmPluginsVersion` resources
 * are preserved unless `versions` is set on this plugin.
 *
 * ### Creating a WasmPlugin
 * **Example:** Generated name
 * ```typescript
 * const plugin = yield* GCP.NetworkServices.WasmPlugin("Edge", {
 *   description: "edge plugin",
 * });
 * ```
 *
 * **Example:** Named plugin with logging
 * ```typescript
 * const plugin = yield* GCP.NetworkServices.WasmPlugin("Edge", {
 *   wasmPluginId: "app-edge",
 *   description: "prod edge",
 *   labels: { env: "prod" },
 *   logConfig: { enable: true, sampleRate: 1, minLogLevel: "WARN" },
 * });
 * ```
 *
 * ### Inline versions
 * **Example:** Plugin plus a serving version
 * ```typescript
 * const plugin = yield* GCP.NetworkServices.WasmPlugin("Edge", {
 *   mainVersionId: "v1",
 *   versions: {
 *     v1: {
 *       imageUri: "us-central1-docker.pkg.dev/my-project/plugins/edge:v1",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const WasmPlugin = Resource<WasmPlugin>(
  "GCP.NetworkServices.WasmPlugin",
);

const toLogConfig = (
  value: WasmPluginLogConfig | networkservices.WasmPluginLogConfig | undefined,
): WasmPluginLogConfig | undefined => {
  if (value === undefined) return undefined;
  if (
    value.enable === undefined &&
    value.sampleRate === undefined &&
    value.minLogLevel === undefined
  ) {
    return undefined;
  }
  return {
    enable: value.enable,
    sampleRate: value.sampleRate,
    minLogLevel: value.minLogLevel,
  };
};

const toVersionDetails = (
  details: networkservices.WasmPluginVersionDetails | undefined,
): WasmPluginVersionDetails => ({
  description: details?.description,
  labels: userLabels(details?.labels),
  imageUri: details?.imageUri,
  imageDigest: details?.imageDigest,
  pluginConfigUri: details?.pluginConfigUri,
  pluginConfigDigest: details?.pluginConfigDigest,
  createTime: details?.createTime,
  updateTime: details?.updateTime,
});

const toVersionMap = (
  versions: networkservices.WasmPluginVersionDetailsMap | undefined,
): Record<string, WasmPluginVersionDetails> =>
  Object.fromEntries(
    Object.entries(versions ?? {}).map(([id, details]) => [
      id,
      toVersionDetails(details),
    ]),
  );

const versionFingerprint = (
  versions: Record<string, WasmPluginVersionInput> | undefined,
  ownership: Record<string, string>,
) => {
  if (versions === undefined) return undefined;
  return Object.fromEntries(
    Object.keys(versions)
      .sort()
      .map((id) => {
        const version = versions[id] ?? {};
        return [
          id,
          {
            description: version.description ?? "",
            imageUri: version.imageUri ?? "",
            pluginConfigUri: version.pluginConfigUri ?? "",
            labels: {
              ...toLabels(version.labels),
              ...ownership,
            },
          },
        ];
      }),
  );
};

const observedVersionFingerprint = (
  versions: networkservices.WasmPluginVersionDetailsMap | undefined,
) =>
  Object.fromEntries(
    Object.keys(versions ?? {})
      .sort()
      .map((id) => {
        const version = versions?.[id] ?? {};
        return [
          id,
          {
            description: version.description ?? "",
            imageUri: version.imageUri ?? "",
            pluginConfigUri: version.pluginConfigUri ?? "",
            labels: tagRecord(version.labels),
          },
        ];
      }),
  );

const toVersionBodies = (
  versions: Record<string, WasmPluginVersionInput> | undefined,
  ownership: Record<string, string>,
): networkservices.WasmPluginVersionDetailsMap | undefined => {
  if (versions === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(versions).map(([id, version]) => [
      id,
      {
        description: version.description,
        labels: { ...toLabels(version.labels), ...ownership },
        imageUri: version.imageUri,
        pluginConfigData: version.pluginConfigData,
        pluginConfigUri: version.pluginConfigUri,
      } satisfies networkservices.WasmPluginVersionDetails,
    ]),
  );
};

const toAttrs = (plugin: networkservices.WasmPlugin, project: string) => {
  const name = plugin.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    wasmPluginId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    description: plugin.description,
    labels: userLabels(plugin.labels),
    mainVersionId: plugin.mainVersionId,
    logConfig: toLogConfig(plugin.logConfig),
    versions: toVersionMap(plugin.versions),
    usedBy: (plugin.usedBy ?? [])
      .map((entry) => entry.name)
      .filter((value): value is string => typeof value === "string"),
    createTime: plugin.createTime,
    updateTime: plugin.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsWasmPlugins({
      name,
      view: "WASM_PLUGIN_VIEW_FULL",
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const WasmPluginProvider = () =>
  Provider.succeed(WasmPlugin, {
    stables: ["name", "wasmPluginId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.wasmPluginId ?? output?.wasmPluginId;
      const nextId = news.wasmPluginId
        ? rfc1035(news.wasmPluginId, "wasm-plugin")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const wasmPluginId = yield* toPhysicalId(
        id,
        olds?.wasmPluginId,
        output?.wasmPluginId,
        "wasm-plugin",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, wasmPluginId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          networkservices.listProjectsLocationsWasmPlugins.pages({
            parent: parentOf(env.project, DEFAULT_GLOBAL),
            pageSize: 1000,
          }),
          (page) => page.wasmPlugins,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const wasmPluginId = yield* toPhysicalId(
        id,
        news.wasmPluginId,
        output?.wasmPluginId,
        "wasm-plugin",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        wasmPluginId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredLogConfig = toLogConfig(news.logConfig);
      const desiredVersions = toVersionBodies(news.versions, desiredLabels);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsWasmPlugins({
            parent: parentOf(env.project, location),
            wasmPluginId,
            body: {
              labels: desiredLabels,
              description: news.description,
              mainVersionId: news.mainVersionId,
              logConfig: desiredLogConfig,
              versions: desiredVersions,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const mainVersionChanged =
        news.mainVersionId !== undefined &&
        (current.mainVersionId ?? "") !== news.mainVersionId;
      const logConfigChanged =
        news.logConfig !== undefined &&
        !sameJson(toLogConfig(current.logConfig), desiredLogConfig);
      const versionsChanged =
        news.versions !== undefined &&
        !sameJson(
          observedVersionFingerprint(current.versions),
          versionFingerprint(news.versions, desiredLabels),
        );

      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["mainVersionId", mainVersionChanged],
        ["logConfig", logConfigChanged],
        ["versions", versionsChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsWasmPlugins({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              mainVersionId: news.mainVersionId,
              logConfig: desiredLogConfig,
              versions: versionsChanged ? desiredVersions : undefined,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* Effect.gen(function* () {
        const operation = yield* networkservices
          .deleteProjectsLocationsWasmPlugins({ name: output.name })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (operation !== undefined) {
          yield* waitForOperation(operation, { notFoundOk: true });
        }
      }).pipe(
        Effect.retry({
          while: (error) =>
            error._tag === "Conflict" ||
            // FAILED_PRECONDITION: still referenced by a route/extension.
            (error._tag === "GCP.OperationFailed" && error.code === 9),
          times: 8,
          schedule: Schedule.spaced("2 seconds"),
        }),
      );
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
