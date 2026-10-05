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
  fieldMask,
  fingerprint,
  getCluster,
  listAlchemyClusters,
  locationParent,
  MAX_CLUSTER_ID_LENGTH,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  retryCreateQuota,
  ResourceNotResolved,
  rfc1035,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type NetworkConfig = {
  /** VPC subnet `projects/{project}/regions/{region}/subnetworks/{subnet}`. */
  subnet?: string;
};

export type AccessConfig = {
  /** VPC networks granted access. At least one subnet is required. */
  networkConfigs?: NetworkConfig[];
};

export type GcpConfig = {
  /** Access configuration for the Kafka cluster. */
  accessConfig?: AccessConfig;
  /**
   * Cloud KMS key for encryption. Immutable.
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{key}`.
   */
  kmsKey?: string;
};

export type CapacityConfig = {
  /**
   * vCPUs to provision. Minimum 3.
   * @default 3
   */
  vcpuCount?: number | string;
  /**
   * Memory in bytes. Minimum 3221225472 (3 GiB). CPU:memory GiB ratio
   * must be between 1:1 and 1:8.
   * @default 3221225472
   */
  memoryBytes?: number | string;
};

export type RebalanceConfig = {
  /**
   * Rebalance mode (`NO_REBALANCE`, `AUTO_REBALANCE_ON_SCALE_UP`).
   * @default "NO_REBALANCE"
   */
  mode?: kafka.RebalanceConfigModeEnum | (string & {});
};

export type TrustConfig = {
  /** Certificate Authority Service CA pools. Maximum 10. */
  casConfigs?: Array<{ caPool?: string }>;
};

export type TlsConfig = {
  /** Kafka `ssl.principal.mapping.rules`. Empty string clears rules. */
  sslPrincipalMappingRules?: string;
  /** Broker truststore. Enables mTLS when set. */
  trustConfig?: TrustConfig;
};

export type UpdateOptions = {
  /**
   * Allow an upscale that shrinks per-broker size below 90% of current.
   * @default false
   */
  allowBrokerDownscaleOnClusterUpscale?: boolean;
};

export type ClusterProps = {
  /**
   * Cluster id (the `{cluster}` segment of
   * `projects/{project}/locations/{location}/clusters/{cluster}`).
   * Lowercase letters, digits, and hyphens; max 53 characters (longer
   * values are truncated). If omitted, a unique RFC1035 name of at most
   * 53 characters is generated. Immutable — changing it replaces the
   * cluster.
   */
  clusterId?: string;
  /**
   * Region (`us-central1`, …). Immutable. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Subnets for broker PSC endpoints. Each is
   * `projects/{project}/regions/{region}/subnetworks/{subnet}`. Defaults
   * to the project's `default` subnet in `location`. Immutable — changing
   * them replaces the cluster.
   */
  subnets?: string[];
  /**
   * Full GCP config. `subnets` / `kmsKey` win when both are set.
   */
  gcpConfig?: GcpConfig;
  /**
   * Customer-managed KMS key. Immutable.
   */
  kmsKey?: string;
  /**
   * Capacity. Defaults to 3 vCPU / 3 GiB.
   */
  capacityConfig?: CapacityConfig;
  /**
   * Rebalance behavior.
   */
  rebalanceConfig?: RebalanceConfig;
  /**
   * TLS / mTLS configuration.
   */
  tlsConfig?: TlsConfig;
  /**
   * Options that control how updates are applied.
   */
  updateOptions?: UpdateOptions;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Cluster = Resource<
  "GCP.ManagedKafka.Cluster",
  ClusterProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/clusters/{cluster}`. */
    name: string;
    /** Cluster id (last path segment). */
    clusterId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state (`CREATING`, `ACTIVE`, …). */
    state: string | undefined;
    /** vCPU count currently provisioned. */
    vcpuCount: string | undefined;
    /** Memory in bytes currently provisioned. */
    memoryBytes: string | undefined;
    /** Subnets currently attached. */
    subnets: string[];
    /** CMEK key, if any. */
    kmsKey: string | undefined;
    /** Rebalance mode. */
    rebalanceMode: string | undefined;
    /** Kafka software version. */
    kafkaVersion: string | undefined;
    /** Broker details when requested with FULL view. */
    brokerDetails: kafka.BrokerDetails[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Managed Service for Apache Kafka cluster.
 *
 * Changing `clusterId`, `location`, `subnets`, or `kmsKey` replaces the
 * cluster. Capacity, rebalance mode, TLS config, and labels update in
 * place. Provisioning typically takes more than a minute.
 *
 * ### Creating a Cluster
 * **Example:** Generated name, 3 vCPU / 3 GiB
 * ```typescript
 * const cluster = yield* GCP.ManagedKafka.Cluster("Brokers", {});
 * ```
 *
 * **Example:** Explicit id, subnet, and labels
 * ```typescript
 * const cluster = yield* GCP.ManagedKafka.Cluster("Brokers", {
 *   clusterId: "app-kafka",
 *   location: "us-central1",
 *   subnets: [
 *     "projects/my-project/regions/us-central1/subnetworks/default",
 *   ],
 *   capacityConfig: { vcpuCount: 3, memoryBytes: 3221225472 },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category ManagedKafka
 */
export const Cluster = Resource<Cluster>("GCP.ManagedKafka.Cluster");

export class ClusterNotResolved extends Data.TaggedError(
  "GCP.ManagedKafka.ClusterNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, clusterId: string) =>
  `projects/${project}/locations/${location}/clusters/${clusterId}`;

const subnetsOf = (
  cluster: kafka.Cluster | ClusterProps,
  project: string,
  location: string,
): string[] => {
  const fromConfig = (cluster.gcpConfig?.accessConfig?.networkConfigs ?? [])
    .map((config) => config.subnet)
    .filter((subnet): subnet is string => subnet !== undefined);
  if ("subnets" in cluster && cluster.subnets && cluster.subnets.length > 0) {
    return cluster.subnets;
  }
  if (fromConfig.length > 0) return fromConfig;
  return [defaultSubnet(project, location)];
};

const kmsOf = (cluster: kafka.Cluster | ClusterProps) =>
  ("kmsKey" in cluster ? cluster.kmsKey : undefined) ??
  cluster.gcpConfig?.kmsKey;

const toAttrs = (cluster: kafka.Cluster, project: string) => {
  const name = cluster.name ?? "";
  const parsed = parseName(name, "clusters");
  return {
    name,
    clusterId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(cluster.labels),
    state: cluster.state,
    vcpuCount: cluster.capacityConfig?.vcpuCount,
    memoryBytes: cluster.capacityConfig?.memoryBytes,
    subnets: subnetsOf(cluster, parsed.project || project, parsed.location),
    kmsKey: cluster.gcpConfig?.kmsKey,
    rebalanceMode: cluster.rebalanceConfig?.mode,
    kafkaVersion: cluster.kafkaVersion,
    brokerDetails: cluster.brokerDetails ?? [],
    createTime: cluster.createTime,
    updateTime: cluster.updateTime,
  };
};

const desiredCapacity = (news: ClusterProps): kafka.CapacityConfig => ({
  vcpuCount: asCountString(news.capacityConfig?.vcpuCount, DEFAULT_VCPU_COUNT),
  memoryBytes: asCountString(
    news.capacityConfig?.memoryBytes,
    DEFAULT_MEMORY_BYTES,
  ),
});

const desiredGcpConfig = (
  news: ClusterProps,
  project: string,
  location: string,
): kafka.GcpConfig => ({
  accessConfig: {
    networkConfigs: subnetsOf(news, project, location).map((subnet) => ({
      subnet,
    })),
  },
  kmsKey: kmsOf(news),
});

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["name", "clusterId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const previousSubnets = fingerprint(
        [...(olds?.subnets ?? output?.subnets ?? [])].sort(),
      );
      const nextSubnets = fingerprint(
        [...subnetsOf(news, env.project, location)].sort(),
      );
      return replaceOnIdentity({
        previousId: olds?.clusterId ?? output?.clusterId,
        nextId: news.clusterId
          ? rfc1035(news.clusterId, "kafka", MAX_CLUSTER_ID_LENGTH)
          : (olds?.clusterId ?? output?.clusterId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: location,
        extra:
          previousSubnets !== nextSubnets ||
          (kmsOf(news) ?? "") !== (olds?.kmsKey ?? output?.kmsKey ?? ""),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const clusterId = yield* toPhysicalId(
        id,
        olds?.clusterId,
        output?.clusterId,
        "kafka",
        MAX_CLUSTER_ID_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, clusterId);
      const existing = yield* getCluster(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const clusters = yield* listAlchemyClusters(env.project, env.region);
        return clusters.map((cluster) => toAttrs(cluster, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const clusterId = yield* toPhysicalId(
        id,
        news.clusterId,
        output?.clusterId,
        "kafka",
        MAX_CLUSTER_ID_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, clusterId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const capacity = desiredCapacity(news);
      const gcpConfig = desiredGcpConfig(news, env.project, location);
      const rebalanceConfig = news.rebalanceConfig;

      let current = yield* getCluster(name);

      if (current === undefined) {
        const created = yield* kafka
          .createProjectsLocationsClusters({
            parent: locationParent(env.project, location),
            clusterId,
            body: {
              gcpConfig,
              capacityConfig: capacity,
              rebalanceConfig,
              tlsConfig: news.tlsConfig,
              updateOptions: news.updateOptions,
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
        current = yield* waitUntilExists(getCluster(name), name);
      }

      if (current === undefined) {
        return yield* new ClusterNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getCluster(name),
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
      const rebalanceChanged =
        (current.rebalanceConfig?.mode ?? "") !== (rebalanceConfig?.mode ?? "");
      const tlsChanged =
        fingerprint(current.tlsConfig) !== fingerprint(news.tlsConfig);
      const updateOptionsChanged =
        fingerprint(current.updateOptions) !== fingerprint(news.updateOptions);

      if (
        labelsChanged ||
        capacityChanged ||
        rebalanceChanged ||
        tlsChanged ||
        updateOptionsChanged
      ) {
        const op = yield* kafka.patchProjectsLocationsClusters({
          name,
          updateMask: fieldMask([
            labelsChanged && "labels",
            capacityChanged && "capacity_config",
            rebalanceChanged && "rebalance_config",
            tlsChanged && "tls_config",
            updateOptionsChanged && "update_options",
          ]),
          body: {
            labels: desiredLabels,
            capacityConfig: capacity,
            rebalanceConfig,
            tlsConfig: news.tlsConfig,
            updateOptions: news.updateOptions,
          },
        });
        yield* waitForOperation(op);
        current = yield* waitUntilReady(
          getCluster(name),
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
        .deleteProjectsLocationsClusters({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (op !== undefined) {
        yield* waitForOperation(op, { notFoundOk: true });
      }
      yield* waitUntilGone(getCluster(output.name), output.name);
    }),
  });
