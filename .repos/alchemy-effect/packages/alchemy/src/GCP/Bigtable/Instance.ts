import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as Data from "effect/Data";
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
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  clusterLocation,
  DEFAULT_CLUSTER_ID,
  DEFAULT_EDITION,
  DEFAULT_INSTANCE_TYPE,
  DEFAULT_SERVE_NODES,
  DEFAULT_STORAGE,
  DEFAULT_ZONE,
  getInstanceByName,
  instanceName,
  lastSegment,
  listAlchemyInstances,
  MAX_INSTANCE_ID_LENGTH,
  MIN_INSTANCE_ID_LENGTH,
  parseResourceName,
  toPhysicalId,
  waitForOperation,
} from "./operations.ts";

export type ClusterAutoscalingLimits = {
  /** Minimum nodes the autoscaler can scale down to. */
  minServeNodes?: number;
  /** Maximum nodes the autoscaler can scale up to. */
  maxServeNodes?: number;
};

export type ClusterAutoscalingTargets = {
  /** Target CPU utilization percent (`10`–`80`). */
  cpuUtilizationPercent?: number;
  /** Target storage utilization in GiB per node. */
  storageUtilizationGibPerNode?: number;
};

export type InstanceClusterSpec = {
  /**
   * Zone (`us-central1-b`) or full location
   * (`projects/{project}/locations/{zone}`). Immutable after create.
   * @default "us-central1-b"
   */
  location?: string;
  /**
   * Manual node count. Mutually exclusive with autoscaling.
   * @default 1
   */
  serveNodes?: number;
  /**
   * Storage type. Immutable after create.
   * @default "HDD"
   */
  defaultStorageType?: bigtable.ClusterDefaultStorageTypeEnum | (string & {});
  /**
   * Customer-managed KMS key
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   * Immutable.
   */
  kmsKeyName?: string;
  /**
   * Node scaling factor. Immutable.
   */
  nodeScalingFactor?: bigtable.ClusterNodeScalingFactorEnum | (string & {});
  /** Autoscaling limits. Mutually exclusive with `serveNodes`. */
  autoscalingLimits?: ClusterAutoscalingLimits;
  /** Autoscaling targets. Used with `autoscalingLimits`. */
  autoscalingTargets?: ClusterAutoscalingTargets;
};

export type InstanceProps = {
  /**
   * Instance id (the `{instance}` segment of
   * `projects/{project}/instances/{instance}`). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Must be 6-33
   * characters, start with a letter, and contain only lowercase letters,
   * numbers, and hyphens. Immutable — changing it replaces the instance.
   */
  instanceId?: string;
  /**
   * User-facing display name. Defaults to the instance id.
   */
  displayName?: string;
  /**
   * Instance type. `DEVELOPMENT` is deprecated; new instances should use
   * `PRODUCTION`.
   * @default "PRODUCTION"
   */
  type?: bigtable.InstanceTypeEnum | (string & {});
  /**
   * Instance edition.
   * @default "ENTERPRISE"
   */
  edition?: bigtable.InstanceEditionEnum | (string & {});
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Clusters created with the instance. At least one is required by the
   * API. Subsequent cluster changes belong on {@link Cluster}. Keys are
   * cluster ids.
   * @default { cluster: { location: "us-central1-b", serveNodes: 1, defaultStorageType: "HDD" } }
   */
  clusters?: Record<string, InstanceClusterSpec>;
};

export type Instance = Resource<
  "GCP.Bigtable.Instance",
  InstanceProps,
  {
    /** Full resource name `projects/{project}/instances/{instance}`. */
    name: string;
    /** Instance id (last path segment). */
    instanceId: string;
    /** Project id. */
    project: string;
    /** User-facing display name. */
    displayName: string | undefined;
    /** Instance type (`PRODUCTION`, `DEVELOPMENT`). */
    type: string;
    /** Instance edition (`ENTERPRISE`, `ENTERPRISE_PLUS`). */
    edition: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state (`READY`, `CREATING`, …). */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Bigtable instance — a container for clusters, tables, and app
 * profiles.
 *
 * Create requires at least one cluster. The default is a single 1-node
 * HDD cluster in `us-central1-b`. Changing `instanceId` replaces the
 * instance. `displayName`, `type`, `edition`, and `labels` update in
 * place. Cluster create-time fields (`location`, storage type, CMEK) are
 * immutable; manage clusters after create with GCP.Bigtable.Cluster.
 *
 * Provisioning typically takes one to two minutes.
 *
 * ### Creating an Instance
 * **Example:** Generated name, 1-node HDD cluster
 * ```typescript
 * const instance = yield* GCP.Bigtable.Instance("Data", {});
 * ```
 *
 * **Example:** Explicit id, labels, and cluster
 * ```typescript
 * const instance = yield* GCP.Bigtable.Instance("Data", {
 *   instanceId: "app-bt",
 *   displayName: "app bigtable",
 *   type: "PRODUCTION",
 *   labels: { env: "prod" },
 *   clusters: {
 *     cluster: {
 *       location: "us-central1-b",
 *       serveNodes: 1,
 *       defaultStorageType: "HDD",
 *     },
 *   },
 * });
 * ```
 *
 * ### Observing Instances
 * **Example:** Read the bound instance
 * ```typescript
 * const getInstance = yield* GCP.Bigtable.GetInstance(instance);
 * const live = yield* getInstance();
 * ```
 *
 * @resource
 * @category Bigtable
 */
export const Instance = Resource<Instance>("GCP.Bigtable.Instance");

export class InstanceNotResolved extends Data.TaggedError(
  "GCP.Bigtable.InstanceNotResolved",
)<{
  name: string;
}> {}

export class InstanceNotReady extends Data.TaggedError(
  "GCP.Bigtable.InstanceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class InstanceStillExists extends Data.TaggedError(
  "GCP.Bigtable.InstanceStillExists",
)<{
  name: string;
}> {}

const normalizeType = (type: string | undefined) => {
  const value = (type ?? DEFAULT_INSTANCE_TYPE).toUpperCase();
  return value === "TYPE_UNSPECIFIED" ? DEFAULT_INSTANCE_TYPE : value;
};

const normalizeEdition = (edition: string | undefined) => {
  const value = (edition ?? DEFAULT_EDITION).toUpperCase();
  return value === "EDITION_UNSPECIFIED" ? DEFAULT_EDITION : value;
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, instanceId: string | undefined, existing?: string) =>
  toPhysicalId(
    id,
    instanceId,
    existing,
    MAX_INSTANCE_ID_LENGTH,
    MIN_INSTANCE_ID_LENGTH,
  );

const defaultClusters = (): Record<string, InstanceClusterSpec> => ({
  [DEFAULT_CLUSTER_ID]: {
    location: DEFAULT_ZONE,
    serveNodes: DEFAULT_SERVE_NODES,
    defaultStorageType: DEFAULT_STORAGE,
  },
});

const toClusterBody = (
  project: string,
  spec: InstanceClusterSpec,
): bigtable.Cluster => {
  const location = clusterLocation(project, spec.location ?? DEFAULT_ZONE);
  const storage = (spec.defaultStorageType ?? DEFAULT_STORAGE).toUpperCase();
  const body: bigtable.Cluster = {
    location,
    defaultStorageType: storage,
    nodeScalingFactor: spec.nodeScalingFactor,
    encryptionConfig: spec.kmsKeyName
      ? { kmsKeyName: spec.kmsKeyName }
      : undefined,
  };
  if (spec.autoscalingLimits !== undefined) {
    body.clusterConfig = {
      clusterAutoscalingConfig: {
        autoscalingLimits: spec.autoscalingLimits,
        autoscalingTargets: spec.autoscalingTargets,
      },
    };
  } else {
    body.serveNodes = spec.serveNodes ?? DEFAULT_SERVE_NODES;
  }
  return body;
};

const toAttrs = (instance: bigtable.Instance, project: string) => {
  const name = instance.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    instanceId: parsed.instanceId || lastSegment(name),
    project: parsed.project || project,
    displayName: instance.displayName,
    type: normalizeType(instance.type),
    edition: instance.edition,
    labels: userLabels(instance.labels),
    state: instance.state,
    createTime: instance.createTime,
  };
};

const waitUntilExists = (name: string) =>
  getInstanceByName(name).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance)
        : Effect.fail(new InstanceNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Bigtable.InstanceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilReady = (name: string) =>
  getInstanceByName(name).pipe(
    Effect.filterOrFail(
      (instance): instance is bigtable.Instance => instance !== undefined,
      () => new InstanceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (instance) => (instance.state ?? "STATE_NOT_KNOWN") === "READY",
      (instance) =>
        new InstanceNotReady({
          name,
          state: instance.state ?? "STATE_NOT_KNOWN",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Bigtable.InstanceNotReady" ||
        error._tag === "GCP.Bigtable.InstanceNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getInstanceByName(name).pipe(
    Effect.flatMap((instance) =>
      instance === undefined
        ? Effect.void
        : Effect.fail(new InstanceStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Bigtable.InstanceStillExists",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["name", "instanceId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.instanceId ?? output?.instanceId;
      const nextId = news.instanceId ?? previousId;
      if (
        previousId !== undefined &&
        nextId !== undefined &&
        previousId !== nextId
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = yield* toId(id, olds?.instanceId, output?.instanceId);
      const name = output?.name ?? instanceName(env.project, instanceId);
      const existing = yield* getInstanceByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const instances = yield* listAlchemyInstances(env.project);
        return instances.map((instance) => toAttrs(instance, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const instanceId = yield* toId(id, news.instanceId, output?.instanceId);
      const name = instanceName(env.project, instanceId);
      const type = normalizeType(news.type ?? output?.type);
      const edition = normalizeEdition(news.edition ?? output?.edition);
      // Bigtable display names must be 4-30 characters.
      const displayName = news.displayName ?? instanceId.slice(0, 30);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const clusters = news.clusters ?? defaultClusters();

      let current = yield* getInstanceByName(name);

      if (current === undefined) {
        const clusterMap: bigtable.ClusterMap = {};
        for (const [clusterId, spec] of Object.entries(clusters)) {
          clusterMap[clusterId] = toClusterBody(env.project, spec);
        }
        const created = yield* bigtable
          .createProjectsInstances({
            parent: `projects/${env.project}`,
            body: {
              instanceId,
              instance: {
                displayName,
                type,
                edition,
                labels: desiredLabels,
              },
              clusters: clusterMap,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new InstanceNotResolved({ name });
      }

      if ((current.state ?? "STATE_NOT_KNOWN") !== "READY") {
        current = yield* waitUntilReady(name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const typeChanged = normalizeType(current.type) !== type;
      const editionChanged =
        normalizeEdition(current.edition) !== edition &&
        news.edition !== undefined;

      if (labelsChanged || displayChanged || typeChanged || editionChanged) {
        const mask = [
          labelsChanged ? "labels" : undefined,
          displayChanged ? "display_name" : undefined,
          typeChanged ? "type" : undefined,
          editionChanged ? "edition" : undefined,
        ].filter((field): field is string => field !== undefined);
        const patched = yield* bigtable.partialUpdateInstanceProjectsInstances({
          name,
          updateMask: mask.join(","),
          body: {
            displayName,
            type,
            edition,
            labels: desiredLabels,
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* bigtable
        .deleteProjectsInstances({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(output.name);
    }),
  });
