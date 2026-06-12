/**
 * The `ShardingRegistrationEvent` module models the live notifications emitted
 * by `Sharding` when the local runner registers an entity handler or singleton.
 * Consumers can use these events to wait for registrations during startup,
 * inspect which capabilities a runner made available, or assert registration
 * behavior in tests.
 *
 * **Mental model**
 *
 * Registration is local capability discovery. An `EntityRegistered` event means
 * this runner has installed handlers for an entity type; a `SingletonRegistered`
 * event carries the `SingletonAddress` computed for the singleton name and shard
 * group. Neither event means the runner currently owns the relevant shard or has
 * started processing stored messages.
 *
 * **Common tasks**
 *
 * - Consume `Sharding.getRegistrationEvents` in tests or startup coordination
 * - Match on entity and singleton registrations with the generated `match`
 *   helper
 * - Record registered entity types and singleton addresses for diagnostics
 *
 * **Gotchas**
 *
 * - Events are live in-memory notifications; they are not stored or replayed for
 *   later subscribers
 * - Shard acquisition, singleton execution, and persisted mailbox polling happen
 *   after registration and may move as runner membership changes
 *
 * @since 4.0.0
 */
import * as Data from "../../Data.ts"
import type { Entity } from "./Entity.ts"
import type { SingletonAddress } from "./SingletonAddress.ts"

/**
 * Represents events that can occur when a runner registers entities or singletons.
 *
 * @category models
 * @since 4.0.0
 */
export type ShardingRegistrationEvent =
  | EntityRegistered
  | SingletonRegistered

/**
 * Represents an event that occurs when a new entity is registered with a runner.
 *
 * @category models
 * @since 4.0.0
 */
export interface EntityRegistered {
  readonly _tag: "EntityRegistered"
  readonly entity: Entity<any, any>
}

/**
 * Represents an event that occurs when a new singleton is registered with a
 * runner.
 *
 * @category models
 * @since 4.0.0
 */
export interface SingletonRegistered {
  readonly _tag: "SingletonRegistered"
  readonly address: SingletonAddress
}

/**
 * Constructors and matchers for sharding registration events.
 *
 * @category pattern matching
 * @since 4.0.0
 */
export const {
  /**
   * Pattern matches on a sharding registration event and dispatches to the
   * matching variant handler.
   *
   * @category pattern matching
   * @since 4.0.0
   */
  $match: match,
  /**
   * Creates an event for an entity registered by the local runner.
   *
   * @category constructors
   * @since 4.0.0
   */
  EntityRegistered,
  /**
   * Creates an event for a singleton registered by the local runner.
   *
   * @category constructors
   * @since 4.0.0
   */
  SingletonRegistered
} = Data.taggedEnum<ShardingRegistrationEvent>()
