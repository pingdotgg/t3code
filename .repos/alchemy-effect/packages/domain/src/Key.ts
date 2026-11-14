import type * as EffectSchema from "effect/Schema";
import * as Aggregate from "./Aggregate.ts";

/** A string Schema that keys instances by value, such as an org id. */
export type Schema = EffectSchema.Top & { readonly Type: string; readonly Encoded: string };

/**
 * What keys the instances of a view, policy, projection or stream: an
 * aggregate (one instance per aggregate ref), or a string Schema (one
 * instance per value, with no aggregate behind it).
 */
export type Any = Aggregate.Any | Schema;

/**
 * How one instance of a key is addressed: a ref for an aggregate key, the
 * value itself for a Schema key.
 */
export type RefOf<K> = K extends Aggregate.Any
  ? Aggregate.Ref<K>
  : K extends EffectSchema.Top
    ? K["Type"]
    : never;

/** The id of one instance of a key: the aggregate id, or the Schema key's value. */
export type IdOf<K> = K extends Aggregate.Any
  ? Aggregate.IdOf<K>
  : K extends EffectSchema.Top
    ? K["Type"]
    : never;

/** Is this key an aggregate (and not a Schema)? @internal */
export const isAggregate = (key: Any): key is Aggregate.Any =>
  (key as { readonly kind?: unknown }).kind === "Aggregate";

/** Address the instance `id` of a key. @internal */
export const refOf = (key: Any, id: string): RefOf<Any> =>
  isAggregate(key) ? Aggregate.makeRef(key, id) : id;

/** The Schema of a key's ids: an aggregate's id schema, or the Schema key itself. @internal */
export const idSchemaOf = (key: Any): Schema =>
  isAggregate(key) ? (key.definition.id as Schema) : key;

/** How a problem names a key: the aggregate's name, or "a key schema". @internal */
export const describe = (key: Any): string =>
  isAggregate(key) ? key.aggregateName : "a key schema";
