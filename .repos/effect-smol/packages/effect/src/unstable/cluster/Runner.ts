/**
 * Cluster runner metadata for processes that can host entity shards.
 *
 * A {@link Runner} combines the stable {@link RunnerAddress} used to contact a
 * process, the shard groups that process participates in, and the relative
 * weight used when the sharding service distributes shards across healthy
 * runners.
 *
 * **Mental model**
 *
 * `Runner` is cluster membership data, not a running process handle. The value
 * is persisted, exchanged, encoded, and compared by cluster services so they can
 * decide where entity shards may live. The address identifies the runner, groups
 * limit the shard pools it can join, and weight changes how much ownership it
 * receives relative to the other healthy runners in the same group.
 *
 * **Common tasks**
 *
 * - Construct runner metadata with {@link make}.
 * - Encode and decode runner values at cluster transport or storage boundaries.
 * - Persist or exchange runner records through cluster runner storage.
 * - Tune shard distribution by adjusting the runner's group membership and
 *   relative weight.
 *
 * **Gotchas**
 *
 * - Runner addresses must be stable and unique while a runner is registered,
 *   because they identify the owner used for routing and shard locks.
 * - Weights are relative inside each shard group; changing a weight or group can
 *   rebalance shard ownership when the cluster refreshes its runner view.
 * - Equality and hashing use address and weight. Compare `groups` explicitly
 *   when group membership is the important distinction.
 *
 * **See also**
 *
 * - {@link Runner}
 * - {@link RunnerAddress}
 * - {@link make}
 *
 * @since 4.0.0
 */
import * as Equal from "../../Equal.ts"
import * as Hash from "../../Hash.ts"
import { NodeInspectSymbol } from "../../Inspectable.ts"
import * as Schema from "../../Schema.ts"
import { RunnerAddress } from "./RunnerAddress.ts"

const TypeId = "~effect/cluster/Runner"

/**
 * Represents a cluster runner that can host entities.
 *
 * **Details**
 *
 * Each runner has a unique network `address`, the shard `groups` it participates
 * in, and a relative `weight` used when assigning shards across runners.
 *
 * @category models
 * @since 4.0.0
 */
export class Runner extends Schema.Class<Runner>(TypeId)({
  address: RunnerAddress,
  groups: Schema.Array(Schema.String),
  weight: Schema.Number
}) {
  /**
   * Formatter for rendering runner values consistently.
   *
   * @since 4.0.0
   */
  static format = Schema.toFormatter(this)

  /**
   * Marks this value as a cluster runner for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId

  /**
   * Decodes a runner from its JSON string representation.
   *
   * @since 4.0.0
   */
  static readonly decodeSync = Schema.decodeSync(Schema.fromJsonString(Runner))

  /**
   * Encodes a runner to its JSON string representation.
   *
   * @since 4.0.0
   */
  static readonly encodeSync = Schema.encodeSync(Schema.fromJsonString(Runner))

  /**
   * Formats this runner as a string.
   *
   * @since 4.0.0
   */
  override toString(): string {
    return Runner.format(this)
  }

  /**
   * Formats this runner for Node.js inspection.
   *
   * @since 4.0.0
   */
  [NodeInspectSymbol](): string {
    return this.toString()
  }

  /**
   * Compares runners by address and shard-assignment weight.
   *
   * @since 4.0.0
   */
  [Equal.symbol](that: Runner): boolean {
    return this.address[Equal.symbol](that.address) && this.weight === that.weight
  }

  /**
   * Computes a structural hash from the runner address and shard-assignment weight.
   *
   * @since 4.0.0
   */
  [Hash.symbol](): number {
    return Hash.string(`${this.address.toString()}:${this.weight}`)
  }
}

/**
 * Constructs a `Runner` from its network address, shard groups, and relative
 * shard-assignment weight.
 *
 * **When to use**
 *
 * Use to build runner metadata from an existing `RunnerAddress`, shard groups,
 * and relative weight when registering or exchanging a cluster runner.
 *
 * **Details**
 *
 * The `groups` array lists the shard groups the runner can host. During shard
 * assignment, the runner's address is added to each group's hash ring with
 * `weight` as its relative weight.
 *
 * **Gotchas**
 *
 * This helper constructs the value without runtime schema validation, so only
 * pass trusted `RunnerAddress`, `groups`, and `weight` values.
 *
 * @see {@link Runner} for the value created by this helper
 * @see {@link RunnerAddress} for the network address accepted in `props.address`
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (props: {
  readonly address: RunnerAddress
  readonly groups: ReadonlyArray<string>
  readonly weight: number
}): Runner => new Runner(props, { disableChecks: true })
