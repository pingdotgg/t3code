import * as apihub from "@distilled.cloud/gcp/apihub_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  ApihubNotResolved,
  MAX_INSTANCE_ID_LENGTH,
  encodeOwnership,
  hasAlchemyLabelMap,
  hasOwnershipMarker,
  locationParent,
  normalizeLocation,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  sameText,
  toPhysicalId,
  updateMaskOf,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type ApiHubInstanceConfig = {
  /** Disable search for the instance. */
  disableSearch?: boolean;
  /**
   * Customer-managed encryption key
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   * Immutable — changing it replaces the instance.
   */
  cmekKeyName?: string;
  /**
   * Encryption type. Immutable — changing it replaces the instance.
   * @default "GMEK"
   */
  encryptionType?:
    | "ENCRYPTION_TYPE_UNSPECIFIED"
    | "GMEK"
    | "CMEK"
    | (string & {});
  /** Vertex AI location used for the data store. */
  vertexLocation?: string;
  /** When true, MCP data is not synced to Agent Registry. */
  agentRegistrySyncDisabled?: boolean;
};

export type ApiHubInstanceProps = {
  /**
   * ApiHub instance id (the `{apiHubInstance}` segment of
   * `projects/{project}/locations/{location}/apiHubInstances/{apiHubInstance}`).
   * If omitted, a unique id is generated. Must be 4-40 characters matching
   * `[a-z0-9-_]+`. Immutable — changing it replaces the instance.
   */
  apiHubInstanceId?: string;
  /**
   * Location (`us-central1`, …). Only one ApiHub instance is allowed per
   * project. Immutable — changing it replaces the instance.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description. Ownership is stored in labels; the
   * description is also stamped with `[alchemy …]` so `list` / nuke can
   * find instances that predate label updates.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Provisioning config. `cmekKeyName` and `encryptionType` are immutable.
   * Search, Vertex location, and Agent Registry sync update in place.
   */
  config?: ApiHubInstanceConfig;
};

export type ApiHubInstance = Resource<
  "GCP.ApiHub.ApiHubInstance",
  ApiHubInstanceProps,
  {
    /** Full resource name. */
    name: string;
    /** Instance id (last path segment). */
    apiHubInstanceId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported instance state. */
    state: string | undefined;
    /** Extra information when `state` is `FAILED`. */
    stateMessage: string | undefined;
    /** Whether search is disabled. */
    disableSearch: boolean;
    /** Customer-managed encryption key, if any. */
    cmekKeyName: string | undefined;
    /** Encryption type. */
    encryptionType: string | undefined;
    /** Vertex AI location. */
    vertexLocation: string | undefined;
    /** Whether Agent Registry sync is disabled. */
    agentRegistrySyncDisabled: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud API Hub instance. One instance is allowed per project.
 *
 * Location, instance id, CMEK, and encryption type are immutable. Search,
 * Vertex location, and Agent Registry sync update in place.
 *
 * ### Creating an ApiHub Instance
 * **Example:** Generated id in us-central1
 * ```typescript
 * const hub = yield* GCP.ApiHub.ApiHubInstance("Hub", {
 *   labels: { env: "test" },
 *   config: { disableSearch: false },
 * });
 * ```
 *
 * **Example:** Named instance with Vertex location
 * ```typescript
 * const hub = yield* GCP.ApiHub.ApiHubInstance("Hub", {
 *   apiHubInstanceId: "alchemy-hub",
 *   location: "us-central1",
 *   config: { vertexLocation: "us-central1" },
 * });
 * ```
 *
 * @resource
 * @category ApiHub
 */
export const ApiHubInstance = Resource<ApiHubInstance>(
  "GCP.ApiHub.ApiHubInstance",
);

const resourceName = (
  project: string,
  location: string,
  apiHubInstanceId: string,
) => `${locationParent(project, location)}/apiHubInstances/${apiHubInstanceId}`;

const toAttrs = (
  instance: apihub.GoogleCloudApihubV1ApiHubInstance,
  project: string,
  region: string,
) => {
  const name = instance.name ?? "";
  const parsed = parseResourceName(name, "apiHubInstances", region);
  const description = parseOwnership(instance.description).text;
  return {
    name,
    apiHubInstanceId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description,
    labels: userLabels(instance.labels),
    state: instance.state,
    stateMessage: instance.stateMessage,
    disableSearch: instance.config?.disableSearch === true,
    cmekKeyName: instance.config?.cmekKeyName,
    encryptionType: instance.config?.encryptionType,
    vertexLocation: instance.config?.vertexLocation,
    agentRegistrySyncDisabled:
      instance.config?.agentRegistrySyncConfig?.disabled === true,
    createTime: instance.createTime,
    updateTime: instance.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apihub
        .getProjectsLocationsApiHubInstances({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const lookupAt = (parent: string) =>
  apihub.lookupProjectsLocationsApiHubInstances({ parent }).pipe(
    Effect.map((response) => response.apiHubInstance),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const configOf = (
  news: ApiHubInstanceProps,
): apihub.GoogleCloudApihubV1Config => ({
  disableSearch: news.config?.disableSearch,
  cmekKeyName: news.config?.cmekKeyName,
  encryptionType: news.config?.encryptionType,
  vertexLocation: news.config?.vertexLocation,
  agentRegistrySyncConfig:
    news.config?.agentRegistrySyncDisabled === undefined
      ? undefined
      : { disabled: news.config.agentRegistrySyncDisabled },
});

export const ApiHubInstanceProvider = () =>
  Provider.succeed(ApiHubInstance, {
    stables: ["name", "apiHubInstanceId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.apiHubInstanceId ?? output?.apiHubInstanceId,
        nextId:
          news.apiHubInstanceId ??
          olds?.apiHubInstanceId ??
          output?.apiHubInstanceId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (news.config?.cmekKeyName ?? olds?.config?.cmekKeyName) !==
            (olds?.config?.cmekKeyName ?? output?.cmekKeyName) ||
          (news.config?.encryptionType ?? olds?.config?.encryptionType) !==
            (olds?.config?.encryptionType ?? output?.encryptionType),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const apiHubInstanceId = yield* toPhysicalId(
        id,
        olds?.apiHubInstanceId,
        output?.apiHubInstanceId,
        MAX_INSTANCE_ID_LENGTH,
      );
      const name =
        output?.name ?? resourceName(env.project, location, apiHubInstanceId);
      let existing = yield* getByName(name);
      if (existing === undefined) {
        existing = yield* lookupAt(locationParent(env.project, location));
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const labeled = yield* hasAlchemyLabels(id, tagRecord(existing.labels));
      const described = yield* ownedByLabelsOrDescription(
        id,
        existing.labels,
        existing.description,
      );
      return labeled || described ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const existing = yield* lookupAt(
          locationParent(env.project, env.region),
        );
        if (existing === undefined) return [];
        if (
          !hasAlchemyLabelMap(existing.labels) &&
          !hasOwnershipMarker(existing.description)
        ) {
          return [];
        }
        return [toAttrs(existing, env.project, env.region)];
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = locationParent(env.project, location);
      const apiHubInstanceId = yield* toPhysicalId(
        id,
        news.apiHubInstanceId,
        output?.apiHubInstanceId,
        MAX_INSTANCE_ID_LENGTH,
      );
      const name = resourceName(env.project, location, apiHubInstanceId);
      const ownership = yield* createInternalLabels(id);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...ownership,
      };
      const description = encodeOwnership(ownership, news.description);
      const config = configOf(news);

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* lookupAt(parent);
      }

      if (current === undefined) {
        const created = yield* apihub
          .createProjectsLocationsApiHubInstances({
            parent,
            apiHubInstanceId,
            body: {
              description,
              labels: desiredLabels,
              config,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current =
          (yield* lookupAt(parent)) ??
          (yield* waitUntilExists(getByName(name), name));
      }

      if (current === undefined) {
        return yield* new ApihubNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const disableChanged =
        (current.config?.disableSearch === true) !==
        (news.config?.disableSearch === true);
      const vertexChanged = !sameText(
        current.config?.vertexLocation,
        news.config?.vertexLocation,
      );
      const syncChanged =
        (current.config?.agentRegistrySyncConfig?.disabled === true) !==
        (news.config?.agentRegistrySyncDisabled === true);

      if (disableChanged || vertexChanged || syncChanged) {
        const operation = yield* apihub.patchProjectsLocationsApiHubInstances({
          name: currentName,
          updateMask: updateMaskOf(
            disableChanged ? "config.disable_search" : undefined,
            vertexChanged ? "config.vertex_location" : undefined,
            syncChanged ? "config.agent_registry_sync_config" : undefined,
          ),
          body: {
            name: currentName,
            config,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(getByName(currentName), currentName);
      }

      if (current === undefined) {
        return yield* new ApihubNotResolved({ name: currentName });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apihub
        .deleteProjectsLocationsApiHubInstances({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });

const ownedByLabelsOrDescription = (
  id: string,
  labels: Record<string, string | undefined> | null | undefined,
  description: string | undefined,
) =>
  Effect.gen(function* () {
    if (yield* hasAlchemyLabels(id, tagRecord(labels))) return true;
    const parsed = parseOwnership(description);
    return yield* hasAlchemyLabels(id, parsed.labels);
  });
