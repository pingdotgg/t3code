/**
 * The `EntityId` module defines the branded string used to identify one entity
 * instance within an entity type. The value is the routing key that sharding
 * hashes, stores in entity addresses, and uses when sending messages to a
 * running entity.
 *
 * **Mental model**
 *
 * - An entity id is a stable string with a brand; at runtime it is still the
 *   original string
 * - Uniqueness is scoped by entity type, so two different entity types may use
 *   the same id without addressing the same entity
 * - Routing depends on the exact string value, including casing and
 *   normalization
 *
 * **Common tasks**
 *
 * - Brand trusted ids with {@link make} before passing them to cluster APIs
 * - Use the {@link EntityId} schema when decoding or encoding ids at
 *   boundaries
 * - Store ids alongside entity type and shard id when building entity
 *   addresses
 *
 * **Gotchas**
 *
 * - {@link make} does not validate, normalize, or ensure uniqueness
 * - Avoid display names, emails that may change, or values with inconsistent
 *   casing or whitespace
 * - Changing an id changes the shard routing target for that entity
 *
 * @since 4.0.0
 */
import * as Schema from "../../Schema.ts"

/**
 * Schema for branded string entity identifiers used inside the cluster.
 *
 * @category constructors
 * @since 4.0.0
 */
export const EntityId = Schema.String.pipe(Schema.brand("~effect/cluster/EntityId"))

/**
 * Branded string type representing the ID of an entity instance.
 *
 * @category models
 * @since 4.0.0
 */
export type EntityId = typeof EntityId.Type

/**
 * Brands a string as an `EntityId`.
 *
 * **When to use**
 *
 * Use to turn a trusted, stable entity routing key into an `EntityId` before
 * passing it to cluster APIs.
 *
 * **Details**
 *
 * The branded value is the original string at runtime.
 *
 * **Gotchas**
 *
 * `make` does not validate, normalize, or make the value unique. Choose
 * deterministic strings because cluster routing hashes the exact entity id
 * value.
 *
 * @see {@link EntityId} for the schema that validates and encodes branded entity identifiers
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (id: string): EntityId => id as EntityId
