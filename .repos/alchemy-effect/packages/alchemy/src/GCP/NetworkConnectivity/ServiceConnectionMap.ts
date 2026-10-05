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
  toNetworkResource,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "serviceConnectionMaps";

export type AutomatedDnsCreationSpec = {
  /** DNS suffix with trailing dot, e.g. `"internal."`. */
  dnsSuffix?: string;
  /** Hostname (first label of the FQDN). */
  hostname?: string;
  /** TTL as a duration string, e.g. `"30s"`. */
  ttl?: string;
};

export type ProducerPscConfig = {
  /** Service attachment URI. */
  serviceAttachmentUri?: string;
  /** Optional spec for automatically creating a DNS record. */
  automatedDnsCreationSpec?: AutomatedDnsCreationSpec;
};

export type ConsumerPscConfig = {
  /** Consumer project id or number. */
  project?: string;
  /** Consumer instance project path (`projects/{project}`). */
  consumerInstanceProject?: string;
  /** Consumer VPC (`projects/{project}/global/networks/{network}`). */
  network?: string;
  /** Disable global access on the PSC endpoint. */
  disableGlobalAccess?: boolean;
  /** Requested IP version (`IPV4` or `IPV6`). */
  ipVersion?: string;
  /** Static IP map from VIP to service attachment. */
  serviceAttachmentIpAddressMap?: Record<string, string>;
  /** Producer instance metadata. Immutable on the producer. */
  producerInstanceMetadata?: Record<string, string>;
  /** Deprecated producer instance id. */
  producerInstanceId?: string;
  /** Output-only overall state. */
  state?: string;
};

export type ServiceConnectionMapProps = {
  /**
   * Map id (the `{service_connection_map}` segment). If omitted, a unique
   * name is generated. Immutable — changing it replaces the map.
   */
  serviceConnectionMapId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * map. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Service class identifier this map is for. Callers need
   * `networkconnectivity.serviceClasses.use`.
   */
  serviceClass?: string;
  /**
   * Consumer-provided token that authenticates PSC connection creation.
   */
  token?: string;
  /**
   * Producer-side PSC configurations (service attachments).
   */
  producerPscConfigs?: ProducerPscConfig[];
  /**
   * Consumer-side PSC configurations (allowed networks/projects).
   */
  consumerPscConfigs?: ConsumerPscConfig[];
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ServiceConnectionMap = Resource<
  "GCP.NetworkConnectivity.ServiceConnectionMap",
  ServiceConnectionMapProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/serviceConnectionMaps/{id}`. */
    name: string;
    /** Map id (last path segment). */
    serviceConnectionMapId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Service class identifier. */
    serviceClass: string | undefined;
    /** Service class URI (output-only). */
    serviceClassUri: string | undefined;
    /** Consumer-provided token. */
    token: string | undefined;
    /** Producer PSC configs. */
    producerPscConfigs: ProducerPscConfig[];
    /** Consumer PSC configs. */
    consumerPscConfigs: ConsumerPscConfig[];
    /** Infrastructure used for connections (`PSC`, …). */
    infrastructure: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
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
 * A PSC Service Connection Map that pairs producer service attachments
 * with consumer networks for Cross-Cloud / producer-consumer
 * connectivity.
 *
 * Changing `serviceConnectionMapId` or `location` replaces the map.
 * Description, labels, token, and PSC configs update in place.
 *
 * ### Creating a ServiceConnectionMap
 * **Example:** Producer map for a service class
 * ```typescript
 * const map = yield* GCP.NetworkConnectivity.ServiceConnectionMap("Sql", {
 *   serviceClass: "gcp-cloud-sql",
 *   description: "sql psc map",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a ServiceConnectionMap
 * **Example:** Description and labels
 * ```typescript
 * const map = yield* GCP.NetworkConnectivity.ServiceConnectionMap("Sql", {
 *   serviceClass: "gcp-cloud-sql",
 *   description: "sql psc map v2",
 *   labels: { env: "prod", role: "psc" },
 * });
 * ```
 *
 * @resource
 * @category NetworkConnectivity
 */
export const ServiceConnectionMap = Resource<ServiceConnectionMap>(
  "GCP.NetworkConnectivity.ServiceConnectionMap",
);

const resourceName = (
  project: string,
  location: string,
  serviceConnectionMapId: string,
) =>
  `projects/${project}/locations/${location}/serviceConnectionMaps/${serviceConnectionMapId}`;

const toStringMap = (
  value: Record<string, string | undefined> | null | undefined,
): Record<string, string> | undefined => {
  if (value === undefined || value === null) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const toProducer = (
  config: ProducerPscConfig | networkconnectivity.ProducerPscConfig,
): ProducerPscConfig => ({
  serviceAttachmentUri: config.serviceAttachmentUri,
  automatedDnsCreationSpec: config.automatedDnsCreationSpec
    ? {
        dnsSuffix: config.automatedDnsCreationSpec.dnsSuffix,
        hostname: config.automatedDnsCreationSpec.hostname,
        ttl: config.automatedDnsCreationSpec.ttl,
      }
    : undefined,
});

const toConsumer = (
  config: ConsumerPscConfig | networkconnectivity.ConsumerPscConfig,
  project: string,
): ConsumerPscConfig => ({
  project: config.project,
  consumerInstanceProject: config.consumerInstanceProject,
  network:
    config.network !== undefined
      ? toNetworkResource(project, config.network)
      : undefined,
  disableGlobalAccess: config.disableGlobalAccess,
  ipVersion: config.ipVersion,
  serviceAttachmentIpAddressMap: toStringMap(
    config.serviceAttachmentIpAddressMap,
  ),
  producerInstanceMetadata: toStringMap(config.producerInstanceMetadata),
  producerInstanceId: config.producerInstanceId,
  state: config.state,
});

const desiredConsumer = (config: ConsumerPscConfig, project: string) => ({
  project: config.project,
  consumerInstanceProject: config.consumerInstanceProject,
  network:
    config.network !== undefined
      ? toNetworkResource(project, config.network)
      : undefined,
  disableGlobalAccess: config.disableGlobalAccess,
  ipVersion: config.ipVersion,
  serviceAttachmentIpAddressMap: toStringMap(
    config.serviceAttachmentIpAddressMap,
  ),
  producerInstanceMetadata: toStringMap(config.producerInstanceMetadata),
  producerInstanceId: config.producerInstanceId,
});

const toAttrs = (
  map: networkconnectivity.ServiceConnectionMap,
  project: string,
  region: string,
) => {
  const name = map.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    serviceConnectionMapId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    serviceClass: map.serviceClass,
    serviceClassUri: map.serviceClassUri,
    token: map.token,
    producerPscConfigs: (map.producerPscConfigs ?? []).map(toProducer),
    consumerPscConfigs: (map.consumerPscConfigs ?? []).map((config) =>
      toConsumer(config, parsed.project || project),
    ),
    infrastructure: map.infrastructure,
    description: map.description,
    labels: userLabels(map.labels),
    etag: map.etag,
    createTime: map.createTime,
    updateTime: map.updateTime,
  };
};

const getByName = (name: string) =>
  networkconnectivity
    .getProjectsLocationsServiceConnectionMaps({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ServiceConnectionMapProvider = () =>
  Provider.succeed(ServiceConnectionMap, {
    stables: [
      "name",
      "serviceConnectionMapId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId =
        olds?.serviceConnectionMapId ?? output?.serviceConnectionMapId;
      const nextId = news.serviceConnectionMapId
        ? rfc1035(news.serviceConnectionMapId, "service-connection-map")
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
      const serviceConnectionMapId = yield* toPhysicalId(
        id,
        olds?.serviceConnectionMapId,
        output?.serviceConnectionMapId,
        "service-connection-map",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, serviceConnectionMapId);
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
          networkconnectivity.listProjectsLocationsServiceConnectionMaps.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.serviceConnectionMaps,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceConnectionMapId = yield* toPhysicalId(
        id,
        news.serviceConnectionMapId,
        output?.serviceConnectionMapId,
        "service-connection-map",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, serviceConnectionMapId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const producerPscConfigs = (news.producerPscConfigs ?? []).map(
        toProducer,
      );
      const consumerPscConfigs = (news.consumerPscConfigs ?? []).map((config) =>
        desiredConsumer(config, env.project),
      );

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkconnectivity
          .createProjectsLocationsServiceConnectionMaps({
            parent: parentOf(env.project, location),
            serviceConnectionMapId,
            body: {
              serviceClass: news.serviceClass,
              token: news.token,
              producerPscConfigs,
              consumerPscConfigs,
              description: news.description,
              labels: desiredLabels,
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
      const tokenChanged = (current.token ?? "") !== (news.token ?? "");
      const producerChanged = !sameJson(
        (current.producerPscConfigs ?? []).map(toProducer),
        producerPscConfigs,
      );
      const consumerChanged = !sameJson(
        (current.consumerPscConfigs ?? []).map((config) =>
          desiredConsumer(toConsumer(config, env.project), env.project),
        ),
        consumerPscConfigs,
      );
      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["token", tokenChanged],
        ["producerPscConfigs", producerChanged],
        ["consumerPscConfigs", consumerChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkconnectivity.patchProjectsLocationsServiceConnectionMaps(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                labels: desiredLabels,
                description: news.description,
                token: news.token,
                producerPscConfigs,
                consumerPscConfigs,
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
        .deleteProjectsLocationsServiceConnectionMaps({
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
