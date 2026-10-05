import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  expandParent,
  fieldMask,
  fingerprint,
  getConnector,
  listAlchemyConnectClusters,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  retryTransient,
  rfc1035,
  stringMapOf,
  toPhysicalId,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type TaskRetryPolicy = {
  /** Minimum backoff before retrying a failed task (e.g. `"60s"`). */
  minimumBackoff?: string;
  /** Maximum backoff before retrying a failed task (e.g. `"43200s"`). */
  maximumBackoff?: string;
  /**
   * Disable task retry.
   * @default false
   */
  taskRetryDisabled?: boolean;
};

export type ConnectClustersConnectorProps = {
  /**
   * Parent Connect cluster. Full name
   * `projects/{project}/locations/{location}/connectClusters/{id}` or
   * the Connect cluster id (combined with `location`). Immutable —
   * changing it replaces the connector.
   */
  connectCluster: string;
  /**
   * Region used when `connectCluster` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Connector id. If omitted, a unique RFC1035 name is generated.
   * Immutable — changing it replaces the connector.
   */
  connectorId?: string;
  /**
   * Connector config (`connector.class`, `tasks.max`, converters, …).
   */
  configs?: Record<string, string>;
  /**
   * Task restart policy.
   */
  taskRestartPolicy?: TaskRetryPolicy;
};

export type ConnectClustersConnector = Resource<
  "GCP.ManagedKafka.ConnectClustersConnector",
  ConnectClustersConnectorProps,
  {
    /** Full resource name `.../connectClusters/{id}/connectors/{connector}`. */
    name: string;
    /** Connector id. */
    connectorId: string;
    /** Parent Connect cluster resource name. */
    connectCluster: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Connector configs. */
    configs: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** Task restart policy currently applied. */
    taskRestartPolicy: TaskRetryPolicy | undefined;
  },
  never,
  Providers
>;

/**
 * A Kafka Connect connector on a Managed Kafka Connect cluster.
 *
 * Changing `connectorId`, `connectCluster`, or `location` replaces the
 * connector. Configs and the task restart policy update in place.
 *
 * ### Creating a Connector
 * **Example:** Pub/Sub sink
 * ```typescript
 * const connector = yield* GCP.ManagedKafka.ConnectClustersConnector(
 *   "Sink",
 *   {
 *     connectCluster: connect.name,
 *     configs: {
 *       "connector.class":
 *         "com.google.pubsub.kafka.sink.CloudPubSubSinkConnector",
 *       "tasks.max": "1",
 *       topics: "orders",
 *       "cps.project": "my-project",
 *       "cps.topic": "orders-sink",
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category ManagedKafka
 */
export const ConnectClustersConnector = Resource<ConnectClustersConnector>(
  "GCP.ManagedKafka.ConnectClustersConnector",
);

export class ConnectClustersConnectorNotResolved extends Data.TaggedError(
  "GCP.ManagedKafka.ConnectClustersConnectorNotResolved",
)<{
  name: string;
}> {}

const connectClusterOf = (value: string, project: string, location: string) =>
  expandParent(value, project, location, "connectClusters");

const resourceName = (connectCluster: string, connectorId: string) =>
  `${connectCluster}/connectors/${connectorId}`;

const policyOf = (
  policy: kafka.TaskRetryPolicy | TaskRetryPolicy | undefined,
): TaskRetryPolicy | undefined => {
  if (policy === undefined) return undefined;
  return {
    minimumBackoff: policy.minimumBackoff,
    maximumBackoff: policy.maximumBackoff,
    taskRetryDisabled: policy.taskRetryDisabled === true,
  };
};

const toAttrs = (connector: kafka.Connector, project: string) => {
  const name = connector.name ?? "";
  const parsed = parseName(name, "connectors");
  return {
    name,
    connectorId: parsed.id,
    connectCluster: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    configs: stringMapOf(connector.configs),
    state: connector.state,
    taskRestartPolicy: policyOf(connector.taskRestartPolicy),
  };
};

export const ConnectClustersConnectorProvider = () =>
  Provider.succeed(ConnectClustersConnector, {
    stables: ["name", "connectorId", "connectCluster", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      return replaceOnIdentity({
        previousId: olds?.connectorId ?? output?.connectorId,
        nextId: news.connectorId
          ? rfc1035(news.connectorId, "connector")
          : (olds?.connectorId ?? output?.connectorId),
        previousParent: olds?.connectCluster ?? output?.connectCluster,
        nextParent: connectClusterOf(
          news.connectCluster,
          env.project,
          location,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const connectorId = yield* toPhysicalId(
        id,
        olds?.connectorId,
        output?.connectorId,
        "connector",
      );
      const connectCluster =
        olds?.connectCluster !== undefined
          ? connectClusterOf(olds.connectCluster, env.project, location)
          : (output?.connectCluster ?? "");
      const name =
        output?.name ??
        (connectCluster.length > 0
          ? resourceName(connectCluster, connectorId)
          : "");
      const existing = yield* getConnector(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return output !== undefined || olds !== undefined
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
        const connectors = yield* Effect.forEach(
          clusters.filter((cluster) => (cluster.name ?? "").length > 0),
          (cluster: kafka.ConnectCluster) =>
            collectPages(
              kafka.listProjectsLocationsConnectClustersConnectors.pages({
                parent: cluster.name!,
                pageSize: 1000,
              }),
              (page) => page.connectors,
            ).pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as kafka.Connector[]),
              ),
            ),
          { concurrency: 4 },
        );
        return connectors
          .flat()
          .map((connector) => toAttrs(connector, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const connectCluster = connectClusterOf(
        news.connectCluster,
        env.project,
        location,
      );
      const connectorId = yield* toPhysicalId(
        id,
        news.connectorId,
        output?.connectorId,
        "connector",
      );
      const name = output?.name ?? resourceName(connectCluster, connectorId);
      const configs = news.configs;
      const taskRestartPolicy = news.taskRestartPolicy;

      let current = yield* getConnector(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          kafka
            .createProjectsLocationsConnectClustersConnectors({
              parent: connectCluster,
              connectorId,
              body: {
                configs,
                taskRestartPolicy,
              },
            })
            .pipe(Effect.catchTag("Conflict", () => getConnector(name))),
        );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ConnectClustersConnectorNotResolved({ name });
      }

      const configsChanged =
        fingerprint(stringMapOf(current.configs)) !==
        fingerprint(stringMapOf(configs));
      const policyChanged =
        fingerprint(policyOf(current.taskRestartPolicy)) !==
        fingerprint(policyOf(taskRestartPolicy));

      if (configsChanged || policyChanged) {
        current = yield* kafka.patchProjectsLocationsConnectClustersConnectors({
          name,
          updateMask: fieldMask([
            configsChanged && "configs",
            policyChanged && "task_restart_policy",
          ]),
          body: {
            configs,
            taskRestartPolicy,
          },
        });
      }

      current = yield* waitUntilReady(
        getConnector(current.name ?? name),
        current.name ?? name,
        (connector) => connector.state,
      );
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* kafka
        .deleteProjectsLocationsConnectClustersConnectors({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getConnector(output.name), output.name);
    }),
  });
