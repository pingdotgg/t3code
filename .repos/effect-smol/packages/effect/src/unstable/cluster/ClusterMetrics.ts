/**
 * The `ClusterMetrics` module defines the standard metrics emitted by the
 * unstable cluster runtime. These gauges track the shape and health of a
 * running cluster from the perspective of runners, entities, singletons, and
 * shard ownership.
 *
 * **Common tasks**
 *
 * - Monitor how many entity instances and singleton processes are active on a
 *   runner
 * - Track registered runners and the subset currently considered healthy
 * - Observe shard distribution across runners during startup, rebalancing, and
 *   failover
 *
 * **Gotchas**
 *
 * - Runner-local gauges such as {@link entities}, {@link singletons}, and
 *   {@link shards} describe the current runner, so aggregate them carefully in
 *   dashboards
 * - Cluster-wide gauges such as {@link runners} and {@link runnersHealthy}
 *   reflect the runtime's current view, which may lag briefly during membership
 *   changes or failure detection
 *
 * @since 4.0.0
 */
import * as Metric from "../../Metric.ts"

/**
 * Creates a gauge tracking the number of active entity instances for each entity type on
 * the current runner.
 *
 * **Details**
 *
 * Bigint gauge named `effect_cluster_entities`, updated with the entity type as
 * a metric tag.
 *
 * **Gotchas**
 *
 * This gauge is runner-local and sampled by the entity manager loop. Aggregate
 * across runners and expect up to roughly one polling interval of lag.
 *
 * @see {@link singletons} for singleton process counts on the current runner
 * @see {@link shards} for shard ownership on the current runner
 *
 * @category metrics
 * @since 4.0.0
 */
export const entities = Metric.gauge("effect_cluster_entities", { bigint: true })

/**
 * Creates a gauge tracking the number of singleton processes currently running on the
 * current runner.
 *
 * @category metrics
 * @since 4.0.0
 */
export const singletons = Metric.gauge("effect_cluster_singletons", { bigint: true })

/**
 * Represents a gauge tracking the number of registered cluster runners.
 *
 * **When to use**
 *
 * Use to monitor the registered runners currently known to the cluster runtime.
 *
 * **Gotchas**
 *
 * The value can lag briefly during membership changes or failure detection.
 *
 * @see {@link runnersHealthy} for the healthy-runner subset
 *
 * @category metrics
 * @since 4.0.0
 */
export const runners = Metric.gauge("effect_cluster_runners", { bigint: true })

/**
 * Represents a gauge tracking the number of cluster runners currently considered healthy.
 *
 * **When to use**
 *
 * Use to monitor the healthy subset of registered cluster runners.
 *
 * **Details**
 *
 * Bigint gauge named `effect_cluster_runners_healthy`.
 *
 * **Gotchas**
 *
 * The value reflects the runtime's health-check view and can lag during
 * membership changes or failure detection.
 *
 * @see {@link runners} for the total registered-runner gauge
 *
 * @category metrics
 * @since 4.0.0
 */
export const runnersHealthy = Metric.gauge("effect_cluster_runners_healthy", { bigint: true })

/**
 * Represents a gauge tracking the number of shards currently acquired by the current runner.
 *
 * **When to use**
 *
 * Use to observe shard ownership held by the current runner during startup,
 * rebalancing, or failover.
 *
 * **Details**
 *
 * Bigint gauge named `effect_cluster_shards`, updated from the sharding
 * acquisition loop using the current acquired shard count.
 *
 * **Gotchas**
 *
 * This is runner-local, not a cluster-wide shard total. Aggregate per-runner
 * values carefully.
 *
 * @category metrics
 * @since 4.0.0
 */
export const shards = Metric.gauge("effect_cluster_shards", { bigint: true })
