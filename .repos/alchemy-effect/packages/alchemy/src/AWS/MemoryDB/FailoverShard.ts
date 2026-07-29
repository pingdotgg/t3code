import type * as memorydb from "@distilled.cloud/aws/memorydb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `FailoverShard` operation (IAM action
 * `memorydb:FailoverShard`), scoped to one {@link Cluster}.
 *
 * Fails over a shard's primary node to a replica — designed for testing how
 * your application behaves during a MemoryDB failover (chaos testing), not
 * as a production remediation tool. Provide the implementation with
 * `Effect.provide(AWS.MemoryDB.FailoverShardHttp)`.
 * @binding
 * @section Testing Failover
 * @example Fail Over a Shard
 * ```typescript
 * const failoverShard = yield* MemoryDB.FailoverShard(cluster);
 *
 * const result = yield* failoverShard({ ShardName: "0001" });
 * // result.Cluster.Status → "updating"
 * ```
 */
export interface FailoverShard extends Binding.Service<
  FailoverShard,
  "AWS.MemoryDB.FailoverShard",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<memorydb.FailoverShardRequest, "ClusterName">,
    ) => Effect.Effect<
      memorydb.FailoverShardResponse,
      memorydb.FailoverShardError
    >
  >
> {}
export const FailoverShard = Binding.Service<FailoverShard>(
  "AWS.MemoryDB.FailoverShard",
);
