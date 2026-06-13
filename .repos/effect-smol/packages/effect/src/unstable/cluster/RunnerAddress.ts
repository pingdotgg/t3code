/**
 * The `RunnerAddress` module defines the stable network identity used to locate
 * a cluster runner. A runner address is a host and port pair that can be
 * encoded with its schema, compared structurally, hashed, inspected, and used as
 * a primary key in runner registries and shard ownership data.
 *
 * **Mental model**
 *
 * `RunnerAddress` is identity data, not connection configuration. Equality,
 * hashing, and the primary key all use the host and port exactly as supplied,
 * so callers should normalize host names before constructing the value when the
 * surrounding routing layer requires a canonical form.
 *
 * **Common tasks**
 *
 * - Build runner endpoints with {@link make}.
 * - Persist or exchange runner endpoints through the {@link RunnerAddress}
 *   schema.
 * - Use addresses as stable keys in runner maps, registries, and shard ownership
 *   records.
 *
 * **Gotchas**
 *
 * - Identity is structural: two addresses are equal only when both host and port
 *   match.
 * - The primary key is formatted as `host:port`, so host strings should already
 *   be normalized for the routing layer using them.
 * - The constructor does not check whether the endpoint is reachable.
 *
 * **See also**
 *
 * - {@link RunnerAddress}
 * - {@link make}
 *
 * @since 4.0.0
 */
import * as Equal from "../../Equal.ts"
import * as Hash from "../../Hash.ts"
import { NodeInspectSymbol } from "../../Inspectable.ts"
import * as PrimaryKey from "../../PrimaryKey.ts"
import * as Schema from "../../Schema.ts"

const TypeId = "~effect/cluster/RunnerAddress"

/**
 * Represents the network address of a cluster runner, identified by host and
 * port.
 *
 * **When to use**
 *
 * Use to represent the host and port that identify a runner in cluster routing,
 * registration, and health checks.
 *
 * @category models
 * @since 4.0.0
 */
export class RunnerAddress extends Schema.Class<RunnerAddress>(TypeId)({
  host: Schema.String,
  port: Schema.Number
}) {
  /**
   * Marks this value as a cluster runner address for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId] = TypeId;

  /**
   * Compares runner addresses by host and port.
   *
   * @since 4.0.0
   */
  [Equal.symbol](that: RunnerAddress): boolean {
    return this.host === that.host && this.port === that.port
  }

  /**
   * Computes a structural hash from the host and port.
   *
   * @since 4.0.0
   */
  [Hash.symbol]() {
    return Hash.string(`${this.host}:${this.port}`)
  }

  /**
   * Stable primary key used to identify the runner address.
   *
   * @since 4.0.0
   */
  [PrimaryKey.symbol](): string {
    return `${this.host}:${this.port}`
  }

  /**
   * Formats the runner address with its host and port.
   *
   * @since 4.0.0
   */
  override toString(): string {
    return `RunnerAddress(${this.host}:${this.port})`
  }

  /**
   * Formats the runner address for Node.js inspection.
   *
   * @since 4.0.0
   */
  [NodeInspectSymbol](): string {
    return this.toString()
  }
}

/**
 * Constructs a `RunnerAddress` from a host and port.
 *
 * **When to use**
 *
 * Use to create the stable network identity for a cluster runner when
 * configuring sharding, registering runner metadata, or targeting a runner by
 * host and port.
 *
 * **Details**
 *
 * The returned `RunnerAddress` stores the supplied `host` and `port`. Equality,
 * hashing, and the primary key use both fields, with the primary key formatted
 * as `host:port`.
 *
 * **Gotchas**
 *
 * `make` does not normalize the host. Pass the host string exactly as the
 * cluster routing and storage layers should identify it.
 *
 * @see {@link RunnerAddress} for the constructed address type and its equality, hashing, primary-key, and formatting behavior
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (host: string, port: number): RunnerAddress =>
  new RunnerAddress({ host, port }, { disableChecks: true })
