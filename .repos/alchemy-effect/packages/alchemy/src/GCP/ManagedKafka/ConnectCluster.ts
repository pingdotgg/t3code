import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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
  asCountString,
  DEFAULT_MEMORY_BYTES,
  DEFAULT_VCPU_COUNT,
  defaultSubnet,
  expandParent,
  fieldMask,
  fingerprint,
  getConnectCluster,
  listAlchemyConnectClusters,
  locationParent,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  retryCreateQuota,
  ResourceNotResolved,
  rfc1035,
  stringMapOf,
  MAX_CLUSTER_ID_LENGTH,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type ConnectNetworkConfig = {
  /**
   * Primary VPC subnet for Connect workers. Must be RFC1918 and at least
   * `/22`. Defaults to the project's `default` subnet.
   */
  primarySubnet?: string;
  /** Additional subnets. Deprecated — Connect can reach any endpoint. */
  additionalSubnets?: string[];
  /** Extra DNS domain names visible to workers. */
  dnsDomainNames?: string[];
};

export type ConnectAccessConfig = {
  /** VPC networks granted access. At least one is required. */
  networkConfigs?: ConnectNetworkConfig[];
};

export type ConnectGcpConfig = {
  /** Access configuration. */
  accessConfig?: ConnectAccessConfig;
  /** Secret Manager versions loaded into workers. Maximum 32. */
  secretPaths?: string[];
};

export type ConnectCapacityConfig = {
  /**
   * vCPUs to provision. Minimum 3.
   * @default 3
   */
  vcpuCount?: number | string;
  /**
   * Memory in bytes. Minimum 3221225472 (3 GiB).
   * @default 3221225472
   */
  memoryBytes?: number | string;
};

export type ConnectClusterProps = {
  /**
   * Connect cluster id. Lowercase letters, digits, and hyphens; max 53
   * characters (longer values are truncated). If omitted, a unique RFC1035
   * name of at most 53 characters is generated. Immutable — changing it
   * replaces the cluster.
   */
  connectClusterId?: string;
  /**
   * Region (`us-central1`, …). Immutable.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Kafka cluster this Connect cluster attaches to
   * (`projects/{project}/locations/{location}/clusters/{cluster}`).
   * Immutable — changing it replaces the Connect cluster.
   */
  kafkaCluster: string;
  /**
   * Primary subnet for workers. Defaults to the project's `default`
   * subnet in `location`. Immutable.
   */
  primarySubnet?: string;
  /** Additional subnets. */
  additionalSubnets?: string[];
  /** Extra DNS domain names. */
  dnsDomainNames?: string[];
  /** Full GCP config. Flattened fields win when both are set. */
  gcpConfig?: ConnectGcpConfig;
  /** Capacity. Defaults to 3 vCPU / 3 GiB. */
  capacityConfig?: ConnectCapacityConfig;
  /** Worker config overrides. Currently unused by the API. */
  config?: Record<string, string>;
  /** Secret Manager versions loaded into workers. */
  secretPaths?: string[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ConnectCluster = Resource<
  "GCP.ManagedKafka.ConnectCluster",
  ConnectClusterProps,
  {
    /** Full resource name `.../connectClusters/{connectCluster}`. */
    name: string;
    /** Connect cluster id. */
    connectClusterId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Attached Kafka cluster. */
    kafkaCluster: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** vCPU count. */
    vcpuCount: string | undefined;
    /** Memory in bytes. */
    memoryBytes: string | undefined;
    /** Primary subnet. */
    primarySubnet: string | undefined;
    /** Worker config. */
    config: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Managed Service for Apache Kafka Connect cluster.
 *
 * Changing `connectClusterId`, `location`, `kafkaCluster`, or the primary
 * subnet replaces the cluster. Capacity, labels, and worker config update
 * in place. Provisioning typically takes more than a minute.
 *
 * ### Creating a Connect Cluster
 * **Example:** Attach to a Kafka cluster
 * ```typescript
 * const connect = yield* GCP.ManagedKafka.ConnectCluster("Connect", {
 *   kafkaCluster: cluster.name,
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const connect = yield* GCP.ManagedKafka.ConnectCluster("Connect", {
 *   connectClusterId: "app-connect",
 *   kafkaCluster: cluster.name,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category ManagedKafka
 */
export const ConnectCluster = Resource<ConnectCluster>(
  "GCP.ManagedKafka.ConnectCluster",
);

export class ConnectClusterNotResolved extends Data.TaggedError(
  "GCP.ManagedKafka.ConnectClusterNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  connectClusterId: string,
) =>
  `projects/${project}/locations/${location}/connectClusters/${connectClusterId}`;

const kafkaClusterOf = (value: string, project: string, location: string) =>
  expandParent(value, project, location, "clusters");

const primarySubnetOf = (
  news: ConnectClusterProps,
  project: string,
  location: string,
) =>
  news.primarySubnet ??
  news.gcpConfig?.accessConfig?.networkConfigs?.[0]?.primarySubnet ??
  defaultSubnet(project, location);

const desiredGcpConfig = (
  news: ConnectClusterProps,
  project: string,
  location: string,
): kafka.ConnectGcpConfig => ({
  accessConfig: {
    networkConfigs: [
      {
        primarySubnet: primarySubnetOf(news, project, location),
        additionalSubnets:
          news.additionalSubnets ??
          news.gcpConfig?.accessConfig?.networkConfigs?.[0]?.additionalSubnets,
        dnsDomainNames:
          news.dnsDomainNames ??
          news.gcpConfig?.accessConfig?.networkConfigs?.[0]?.dnsDomainNames,
      },
    ],
  },
  secretPaths: news.secretPaths ?? news.gcpConfig?.secretPaths,
});

const toAttrs = (cluster: kafka.ConnectCluster, project: string) => {
  const name = cluster.name ?? "";
  const parsed = parseName(name, "connectClusters");
  return {
    name,
    connectClusterId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    kafkaCluster: cluster.kafkaCluster ?? "",
    labels: userLabels(cluster.labels),
    state: cluster.state,
    vcpuCount: cluster.capacityConfig?.vcpuCount,
    memoryBytes: cluster.capacityConfig?.memoryBytes,
    primarySubnet:
      cluster.gcpConfig?.accessConfig?.networkConfigs?.[0]?.primarySubnet,
    config: stringMapOf(cluster.config),
    createTime: cluster.createTime,
    updateTime: cluster.updateTime,
  };
};

export const ConnectClusterProvider = () =>
  Provider.succeed(ConnectCluster, {
    stables: [
      "name",
      "connectClusterId",
      "project",
      "location",
      "kafkaCluster",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const previousKafka = olds?.kafkaCluster ?? output?.kafkaCluster ?? "";
      const nextKafka = kafkaClusterOf(
        news.kafkaCluster,
        env.project,
        location,
      );
      const previousSubnet = olds?.primarySubnet ?? output?.primarySubnet ?? "";
      const nextSubnet = primarySubnetOf(news, env.project, location);
      return replaceOnIdentity({
        previousId: olds?.connectClusterId ?? output?.connectClusterId,
        nextId: news.connectClusterId
          ? rfc1035(news.connectClusterId, "connect", MAX_CLUSTER_ID_LENGTH)
          : (olds?.connectClusterId ?? output?.connectClusterId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: location,
        extra: previousKafka !== nextKafka || previousSubnet !== nextSubnet,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const connectClusterId = yield* toPhysicalId(
        id,
        olds?.connectClusterId,
        output?.connectClusterId,
        "connect",
        MAX_CLUSTER_ID_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, connectClusterId);
      const existing = yield* getConnectCluster(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const clusters = yield* listAlchemyConnectClusters(
          env.project,
          env.region,
        );
        return clusters.map((cluster) => toAttrs(cluster, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const connectClusterId = yield* toPhysicalId(
        id,
        news.connectClusterId,
        output?.connectClusterId,
        "connect",
        MAX_CLUSTER_ID_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, connectClusterId);
      const kafkaCluster = kafkaClusterOf(
        news.kafkaCluster,
        env.project,
        location,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const capacity = {
        vcpuCount: asCountString(
          news.capacityConfig?.vcpuCount,
          DEFAULT_VCPU_COUNT,
        ),
        memoryBytes: asCountString(
          news.capacityConfig?.memoryBytes,
          DEFAULT_MEMORY_BYTES,
        ),
      };
      const gcpConfig = desiredGcpConfig(news, env.project, location);

      let current = yield* getConnectCluster(name);

      if (current === undefined) {
        const created = yield* kafka
          .createProjectsLocationsConnectClusters({
            parent: locationParent(env.project, location),
            connectClusterId,
            body: {
              kafkaCluster,
              gcpConfig,
              capacityConfig: capacity,
              config: news.config,
              labels: desiredLabels,
            },
          })
          .pipe(
            retryCreateQuota,
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getConnectCluster(name), name);
      }

      if (current === undefined) {
        return yield* new ConnectClusterNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getConnectCluster(name),
        name,
        (cluster) => cluster.state,
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const capacityChanged =
        (current.capacityConfig?.vcpuCount ?? "") !==
          (capacity.vcpuCount ?? "") ||
        (current.capacityConfig?.memoryBytes ?? "") !==
          (capacity.memoryBytes ?? "");
      const configChanged =
        fingerprint(stringMapOf(current.config)) !==
        fingerprint(stringMapOf(news.config));
      const secretsChanged =
        fingerprint(current.gcpConfig?.secretPaths ?? []) !==
        fingerprint(gcpConfig.secretPaths ?? []);

      if (labelsChanged || capacityChanged || configChanged || secretsChanged) {
        const op = yield* kafka.patchProjectsLocationsConnectClusters({
          name,
          updateMask: fieldMask([
            labelsChanged && "labels",
            capacityChanged && "capacity_config",
            configChanged && "config",
            secretsChanged && "gcp_config.secret_paths",
          ]),
          body: {
            labels: desiredLabels,
            capacityConfig: capacity,
            config: news.config,
            gcpConfig,
          },
        });
        yield* waitForOperation(op);
        current = yield* waitUntilReady(
          getConnectCluster(name),
          name,
          (cluster) => cluster.state,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const op = yield* kafka
        .deleteProjectsLocationsConnectClusters({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (op !== undefined) {
        yield* waitForOperation(op, { notFoundOk: true });
      }
      yield* waitUntilGone(getConnectCluster(output.name), output.name);
    }),
  });
