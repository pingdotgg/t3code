import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
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
  NetworkConnectivityNotResolved,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  rfc1035,
  sameJson,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "multicloudDataTransferConfigs";

export type StateMetadata = {
  /** Transient or rest state (`ADDING`, `ACTIVE`, `DELETING`, …). */
  state?: string;
  /** RFC3339 time when a transient state becomes effective. */
  effectiveTime?: string;
};

export type StateTimeline = {
  /** Ordered state/activation entries. */
  states?: StateMetadata[];
};

export type MulticloudDataTransferConfigProps = {
  /**
   * Config id (the `{multicloud_data_transfer_config}` segment of
   * `projects/{project}/locations/{location}/multicloudDataTransferConfigs/{multicloud_data_transfer_config}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the config.
   */
  multicloudDataTransferConfigId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * config. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * Map of Data Transfer Essentials service names to their desired
   * timeline. Keys are service ids such as `"google-cloud-storage"`.
   */
  services?: Record<string, StateTimeline>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type MulticloudDataTransferConfig = Resource<
  "GCP.NetworkConnectivity.MulticloudDataTransferConfig",
  MulticloudDataTransferConfigProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/multicloudDataTransferConfigs/{id}`. */
    name: string;
    /** Config id (last path segment). */
    multicloudDataTransferConfigId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** Service timelines currently configured. */
    services: Record<string, StateTimeline>;
    /** Number of Destination resources configured. */
    destinationsCount: number | undefined;
    /** Number of Destination resources in use. */
    destinationsActiveCount: number | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Google-generated unique id. */
    uid: string | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Data Transfer Essentials `MulticloudDataTransferConfig` — the
 * billing/metering configuration for services whose traffic is billed
 * through DTE.
 *
 * Changing `multicloudDataTransferConfigId` or `location` replaces the
 * config. Description, labels, and `services` update in place.
 *
 * ### Creating a Config
 * **Example:** Generated name
 * ```typescript
 * const config = yield* GCP.NetworkConnectivity.MulticloudDataTransferConfig(
 *   "Dte",
 *   { description: "dte metering", labels: { env: "prod" } },
 * );
 * ```
 *
 * **Example:** Named config with a service
 * ```typescript
 * const config = yield* GCP.NetworkConnectivity.MulticloudDataTransferConfig(
 *   "Dte",
 *   {
 *     multicloudDataTransferConfigId: "app-dte",
 *     location: "us-central1",
 *     services: { "google-cloud-storage": {} },
 *   },
 * );
 * ```
 *
 * ### Updating a Config
 * **Example:** Description and labels
 * ```typescript
 * const config = yield* GCP.NetworkConnectivity.MulticloudDataTransferConfig(
 *   "Dte",
 *   {
 *     multicloudDataTransferConfigId: "app-dte",
 *     location: "us-central1",
 *     description: "dte metering v2",
 *     labels: { env: "prod", role: "dte" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkConnectivity
 */
export const MulticloudDataTransferConfig =
  Resource<MulticloudDataTransferConfig>(
    "GCP.NetworkConnectivity.MulticloudDataTransferConfig",
  );

const resourceName = (project: string, location: string, configId: string) =>
  `projects/${project}/locations/${location}/multicloudDataTransferConfigs/${configId}`;

const toTimeline = (
  timeline: StateTimeline | networkconnectivity.StateTimeline | undefined,
): StateTimeline => ({
  states: (timeline?.states ?? []).map((entry) => ({
    state: entry.state,
    effectiveTime: entry.effectiveTime,
  })),
});

const toServices = (
  services:
    | Record<string, StateTimeline | undefined>
    | networkconnectivity.StateTimelineMap
    | undefined,
): Record<string, StateTimeline> => {
  const result: Record<string, StateTimeline> = {};
  for (const [key, value] of Object.entries(services ?? {})) {
    if (value !== undefined) {
      result[key] = toTimeline(value);
    }
  }
  return result;
};

const toAttrs = (
  config: networkconnectivity.MulticloudDataTransferConfig,
  project: string,
  region: string,
) => {
  const name = config.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    multicloudDataTransferConfigId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    description: config.description,
    services: toServices(config.services),
    destinationsCount: config.destinationsCount,
    destinationsActiveCount: config.destinationsActiveCount,
    labels: userLabels(config.labels),
    uid: config.uid,
    etag: config.etag,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const getByName = (name: string) =>
  networkconnectivity
    .getProjectsLocationsMulticloudDataTransferConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const MulticloudDataTransferConfigProvider = () =>
  Provider.succeed(MulticloudDataTransferConfig, {
    stables: [
      "name",
      "multicloudDataTransferConfigId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId =
        olds?.multicloudDataTransferConfigId ??
        output?.multicloudDataTransferConfigId;
      const nextId = news.multicloudDataTransferConfigId
        ? rfc1035(
            news.multicloudDataTransferConfigId,
            "multicloud-data-transfer-config",
          )
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
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
      const configId = yield* toPhysicalId(
        id,
        olds?.multicloudDataTransferConfigId,
        output?.multicloudDataTransferConfigId,
        "multicloud-data-transfer-config",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, configId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          networkconnectivity.listProjectsLocationsMulticloudDataTransferConfigs.pages(
            {
              parent: parentOf(env.project, "-"),
              pageSize: 1000,
              returnPartialSuccess: true,
            },
          ),
          (page) => page.multicloudDataTransferConfigs,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const configId = yield* toPhysicalId(
        id,
        news.multicloudDataTransferConfigId,
        output?.multicloudDataTransferConfigId,
        "multicloud-data-transfer-config",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, configId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredServices = toServices(news.services);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkconnectivity
          .createProjectsLocationsMulticloudDataTransferConfigs({
            parent: parentOf(env.project, location),
            multicloudDataTransferConfigId: configId,
            body: {
              description: news.description,
              labels: desiredLabels,
              services: desiredServices,
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

      if (current === undefined) {
        return yield* new NetworkConnectivityNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const servicesChanged = !sameJson(
        toServices(current.services),
        desiredServices,
      );
      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["services", servicesChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkconnectivity.patchProjectsLocationsMulticloudDataTransferConfigs(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                labels: desiredLabels,
                description: news.description,
                services: desiredServices,
                etag: current.etag,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkconnectivity
        .deleteProjectsLocationsMulticloudDataTransferConfigs({
          name: output.name,
          etag: output.etag,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
