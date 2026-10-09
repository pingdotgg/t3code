import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_GLOBAL,
  canonicalizeLink,
  collectPages,
  hasAlchemyLabelKeys,
  lastSegment,

  normalizeLocation,
  parentOf,
  parseName,
  rfc1035,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "versions";

export type WasmPluginsVersionProps = {
  /**
   * Parent WasmPlugin. Full name
   * `projects/{project}/locations/{location}/wasmPlugins/{wasmPlugin}`
   * or the plugin id (combined with `location`). Immutable — changing
   * it replaces the version.
   */
  wasmPlugin: string;
  /**
   * Version id (the `{wasmPluginVersion}` segment of
   * `.../wasmPlugins/{wasmPlugin}/versions/{wasmPluginVersion}`). If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and not start with a number.
   * Immutable — changing it replaces the version.
   */
  wasmPluginVersionId?: string;
  /**
   * Location of the parent plugin. Used when `wasmPlugin` is a bare
   * id. Wasm plugins live in `global`. Immutable — changing it
   * replaces the version. `GLOBAL` is accepted and normalized to
   * `global`.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description. Versions have no update API, so
   * changing this field replaces the version.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Versions have no update API, so changing labels replaces the version.
   */
  labels?: Record<string, string>;
  /**
   * Artifact Registry URI of the image that contains `plugin.wasm`.
   * Docker (`LOCATION-docker.pkg.dev/...`) or generic artifact
   * (`projects/{project}/locations/{location}/repositories/{repository}/genericArtifacts/{package}:{version}`)
   * forms are accepted. Immutable — changing it replaces the version.
   */
  imageUri?: string;
  /**
   * Base64-encoded plugin configuration delivered through `ON_CONFIGURE`.
   * Mutually exclusive with `pluginConfigUri`. Immutable — changing it
   * replaces the version.
   */
  pluginConfigData?: string;
  /**
   * Artifact Registry URI of an image that contains `plugin.config`.
   * Mutually exclusive with `pluginConfigData`. Immutable — changing it
   * replaces the version.
   */
  pluginConfigUri?: string;
};

export type WasmPluginsVersion = Resource<
  "GCP.NetworkServices.WasmPluginsVersion",
  WasmPluginsVersionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/wasmPlugins/{wasmPlugin}/versions/{wasmPluginVersion}`. */
    name: string;
    /** Version id (last path segment). */
    wasmPluginVersionId: string;
    /** Parent WasmPlugin resource name. */
    wasmPlugin: string;
    /** Parent WasmPlugin id. */
    wasmPluginId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`). */
    location: string;
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
  },
  never,
  Providers
>;

/**
 * An immutable WasmPluginVersion nested under a WasmPlugin. Each
 * version points at a Wasm module in Artifact Registry and optionally
 * a runtime config.
 *
 * There is no patch API. Changing the parent plugin, version id,
 * location, image URI, or plugin config replaces the version.
 * Description and labels are applied at create time.
 *
 * ### Creating a WasmPluginsVersion
 * **Example:** Version from a Docker image
 * ```typescript
 * const version = yield* GCP.NetworkServices.WasmPluginsVersion("V1", {
 *   wasmPlugin: plugin.name,
 *   imageUri: "us-central1-docker.pkg.dev/my-project/plugins/edge:v1",
 * });
 * ```
 *
 * **Example:** Named version with config
 * ```typescript
 * const version = yield* GCP.NetworkServices.WasmPluginsVersion("V1", {
 *   wasmPlugin: plugin.name,
 *   wasmPluginVersionId: "v1",
 *   description: "prod edge v1",
 *   labels: { env: "prod" },
 *   imageUri:
 *     "projects/my-project/locations/us-central1/repositories/plugins/genericArtifacts/edge:v1",
 *   pluginConfigData: "e30=",
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const WasmPluginsVersion = Resource<WasmPluginsVersion>(
  "GCP.NetworkServices.WasmPluginsVersion",
);

const parentFromVersionName = (name: string) => {
  const index = name.lastIndexOf("/versions/");
  return index >= 0 ? name.slice(0, index) : name;
};

const locationFromParent = (wasmPlugin: string, fallback: string) => {
  const canonical = canonicalizeLink(wasmPlugin);
  if (!canonical.includes("/locations/")) return fallback;
  return parseName(canonical, "wasmPlugins", fallback).location;
};

const parentPluginName = (
  project: string,
  location: string,
  wasmPlugin: string,
) => {
  const canonical = canonicalizeLink(wasmPlugin);
  if (canonical.includes("/wasmPlugins/")) return canonical;
  const id = lastSegment(canonical);
  return `projects/${project}/locations/${location}/wasmPlugins/${id}`;
};

const resourceNameOf = (parent: string, versionId: string) =>
  `${parent}/versions/${versionId}`;

const linkKey = (value: string | undefined) =>
  lastSegment(canonicalizeLink(value)).toLowerCase();

const toAttrs = (
  version: networkservices.WasmPluginVersion,
  project: string,
) => {
  const name = version.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  const parent = parentFromVersionName(name);
  const pluginParsed = parseName(parent, "wasmPlugins", DEFAULT_GLOBAL);
  return {
    name,
    wasmPluginVersionId: parsed.id,
    wasmPlugin: parent,
    wasmPluginId: pluginParsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    description: version.description,
    labels: userLabels(version.labels),
    imageUri: version.imageUri,
    imageDigest: version.imageDigest,
    pluginConfigUri: version.pluginConfigUri,
    pluginConfigDigest: version.pluginConfigDigest,
    createTime: version.createTime,
    updateTime: version.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0 ||
  !name.includes("/wasmPlugins/") ||
  name.includes("/wasmPlugins//")
    ? Effect.succeed(undefined)
    : networkservices
        .getProjectsLocationsWasmPluginsVersions({ name })
        .pipe(Effect.catchTag(["NotFound"], () => Effect.succeed(undefined)));

const getPlugin = (name: string) =>
  networkservices
    .getProjectsLocationsWasmPlugins({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const replaceIfChanged = (
  previous: string | undefined,
  next: string | undefined,
) =>
  previous !== undefined &&
  next !== undefined &&
  previous.length > 0 &&
  next.length > 0 &&
  previous !== next;

export const WasmPluginsVersionProvider = () =>
  Provider.succeed(WasmPluginsVersion, {
    stables: [
      "name",
      "wasmPluginVersionId",
      "wasmPlugin",
      "wasmPluginId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.wasmPluginVersionId ?? output?.wasmPluginVersionId;
      const nextId = news.wasmPluginVersionId
        ? rfc1035(news.wasmPluginVersionId, "wasm-plugin-version")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? locationFromParent(news.wasmPlugin, previousLocation),
        DEFAULT_GLOBAL,
      );
      const previousParent = linkKey(olds?.wasmPlugin ?? output?.wasmPlugin);
      const nextParent = linkKey(news.wasmPlugin);
      if (
        replaceIfChanged(previousId, nextId) ||
        previousLocation !== nextLocation ||
        (previousParent.length > 0 && previousParent !== nextParent) ||
        replaceIfChanged(olds?.imageUri ?? output?.imageUri, news.imageUri) ||
        replaceIfChanged(
          olds?.pluginConfigUri ?? output?.pluginConfigUri,
          news.pluginConfigUri,
        ) ||
        replaceIfChanged(olds?.pluginConfigData, news.pluginConfigData)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ??
          output?.location ??
          (olds?.wasmPlugin
            ? locationFromParent(olds.wasmPlugin, DEFAULT_GLOBAL)
            : undefined),
        DEFAULT_GLOBAL,
      );
      const parent = parentPluginName(
        env.project,
        location,
        olds?.wasmPlugin ?? output?.wasmPlugin ?? "",
      );
      const versionId = yield* toPhysicalId(
        id,
        olds?.wasmPluginVersionId,
        output?.wasmPluginVersionId,
        "wasm-plugin-version",
      );
      const name = output?.name ?? resourceNameOf(parent, versionId);
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
        const plugins = yield* collectPages(
          networkservices.listProjectsLocationsWasmPlugins.pages({
            parent: parentOf(env.project, DEFAULT_GLOBAL),
            pageSize: 1000,
          }),
          (page) => page.wasmPlugins,
        );
        const nested = yield* Effect.forEach(
          plugins.filter((plugin) => (plugin.name ?? "").length > 0),
          (plugin) =>
            collectPages(
              networkservices.listProjectsLocationsWasmPluginsVersions.pages({
                parent: plugin.name ?? "",
                pageSize: 1000,
              }),
              (page) => page.wasmPluginVersions,
            ),
          { concurrency: 4 },
        );
        return nested
          .flat()
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ??
          output?.location ??
          locationFromParent(news.wasmPlugin, DEFAULT_GLOBAL),
        DEFAULT_GLOBAL,
      );
      const parent = parentPluginName(env.project, location, news.wasmPlugin);
      const versionId = yield* toPhysicalId(
        id,
        news.wasmPluginVersionId,
        output?.wasmPluginVersionId,
        "wasm-plugin-version",
      );
      const name = resourceNameOf(parent, versionId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsWasmPluginsVersions({
            parent,
            wasmPluginVersionId: versionId,
            body: {
              labels: desiredLabels,
              description: news.description,
              imageUri: news.imageUri,
              pluginConfigData: news.pluginConfigData,
              pluginConfigUri: news.pluginConfigUri,
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

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const plugin = yield* getPlugin(output.wasmPlugin);
      if (
        plugin !== undefined &&
        (plugin.mainVersionId ?? "") === output.wasmPluginVersionId
      ) {
        const siblings = yield* collectPages(
          networkservices.listProjectsLocationsWasmPluginsVersions.pages({
            parent: output.wasmPlugin,
            pageSize: 1000,
          }),
          (page) => page.wasmPluginVersions,
        );
        const other = siblings.find(
          (version) =>
            lastSegment(version.name ?? "") !== output.wasmPluginVersionId,
        );
        if (other !== undefined) {
          const nextMain = lastSegment(other.name ?? "");
          const switched = yield* networkservices
            .patchProjectsLocationsWasmPlugins({
              name: output.wasmPlugin,
              updateMask: "mainVersionId",
              body: {
                name: output.wasmPlugin,
                mainVersionId: nextMain,
              },
            })
            .pipe(
              Effect.catchTag(["NotFound"], () => Effect.succeed(undefined)),
            );
          if (switched !== undefined) {
            yield* waitForOperation(switched, { notFoundOk: true });
          }
        }
      }

      yield* Effect.gen(function* () {
        const operation = yield* networkservices
          .deleteProjectsLocationsWasmPluginsVersions({ name: output.name })
          .pipe(Effect.catchTag(["NotFound"], () => Effect.succeed(undefined)));
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
