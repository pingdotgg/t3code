/**
 * The `SingletonAddress` module models the runtime address assigned to a cluster
 * singleton registration. The address pairs the singleton `name` with the
 * `ShardId` selected from that name and its shard group, giving sharding one
 * stable value for registration events, equality, hashing, and local singleton
 * fiber tracking.
 *
 * **Mental model**
 *
 * A singleton does not have an entity id supplied by the caller. During
 * registration, `Sharding` hashes the singleton name within a shard group and
 * records the resulting shard id next to the name. When the local runner
 * acquires that shard, the singleton can run; when ownership moves away, the
 * address stays the same and the local singleton fiber is stopped.
 *
 * **Common tasks**
 *
 * - Read the address carried by singleton registration events
 * - Compare singleton registrations by both name and shard id
 * - Include the name and shard id in logs or diagnostics about singleton
 *   ownership changes
 *
 * **Gotchas**
 *
 * - The same singleton name in different shard groups produces different
 *   addresses
 * - An address identifies the shard responsible for a singleton, not the runner
 *   currently executing it
 *
 * @since 4.0.0
 */
import * as Equal from "../../Equal.ts"
import * as Hash from "../../Hash.ts"
import * as Schema from "../../Schema.ts"
import { ShardId } from "./ShardId.ts"

const TypeId = "~effect/cluster/SingletonAddress"

/**
 * Represents the unique address of an singleton within the cluster.
 *
 * @category Address
 * @since 4.0.0
 */
export class SingletonAddress extends Schema.Class<SingletonAddress>(TypeId)({
  shardId: ShardId,
  name: Schema.String
}) {
  /**
   * Marks this value as a cluster singleton address for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId;
  /**
   * Computes a structural hash from the singleton name and shard id.
   *
   * @since 4.0.0
   */
  [Hash.symbol]() {
    return Hash.string(`${this.name}:${this.shardId.toString()}`)
  }
  /**
   * Compares singleton addresses by name and shard id.
   *
   * @since 4.0.0
   */
  [Equal.symbol](that: SingletonAddress): boolean {
    return this.name === that.name && Equal.equals(this.shardId, that.shardId)
  }
}
