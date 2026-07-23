/**
 * The `EntityType` module defines the branded string used to identify a kind of
 * entity in an Effect cluster. Entity type names are part of the cluster routing
 * identity: they distinguish one family of entities from another before an
 * individual entity id is considered.
 *
 * **Common tasks**
 *
 * - Declare the stable name for an entity family handled by a cluster service
 * - Brand a string literal as an {@link EntityType} with {@link make}
 * - Validate or encode entity type names with the {@link EntityType} schema
 *
 * **Gotchas**
 *
 * - Entity type names should be stable and unique within the cluster because
 *   changing them changes where entity messages are routed
 * - The entity type name identifies the entity family, not a specific entity
 *   instance; combine it with the entity id at the call site that routes work
 *
 * @since 4.0.0
 */
import * as Schema from "../../Schema.ts"

/**
 * Schema for branded string names that identify entity types in the cluster.
 *
 * @category constructors
 * @since 4.0.0
 */
export const EntityType = Schema.String.pipe(Schema.brand("~effect/cluster/EntityType"))

/**
 * Branded string type representing an entity type name.
 *
 * @category models
 * @since 4.0.0
 */
export type EntityType = typeof EntityType.Type

/**
 * Brands a string as an `EntityType`.
 *
 * **When to use**
 *
 * Use to brand a stable entity family name before passing it to cluster APIs
 * that require an `EntityType`, such as entity addresses.
 *
 * **Details**
 *
 * The returned value is the same runtime string with the `EntityType` brand
 * applied by TypeScript.
 *
 * **Gotchas**
 *
 * `make` only applies the brand at the type level; it does not validate,
 * normalize, or check uniqueness. Use the `EntityType` schema when you need
 * schema-based decoding or validation, and keep names stable because the exact
 * string participates in routing identity.
 *
 * @see {@link EntityType} for schema-based decoding, validation, and encoding of entity type names
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (value: string): EntityType => value as EntityType
