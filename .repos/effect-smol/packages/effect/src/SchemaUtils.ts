/**
 * Focused schema helpers for patterns that are useful but too specialized for
 * the main `Schema` module. This module currently covers the case where a
 * native JavaScript or TypeScript class should decode from a plain struct and
 * still remain an instance of that class after decoding.
 *
 * **Mental model**
 *
 * - {@link getNativeClassSchema} starts from a constructor and a struct schema
 *   for the encoded shape.
 * - Decoding validates the struct, then calls the constructor with the decoded
 *   fields as one object.
 * - Encoding treats the instance as the encoded object, so instance properties
 *   must line up with the struct fields.
 * - The resulting schema preserves class identity through `Schema.instanceOf`
 *   while retaining a plain-object representation for encoded data.
 *
 * **Common tasks**
 *
 * - Add schema support to an existing native class without rewriting it as a
 *   `Schema.Class`.
 * - Decode structured data into a `Data.Error` subclass or another class whose
 *   constructor accepts a props object.
 * - Encode class instances back to the struct shape expected at API, storage,
 *   or transport boundaries.
 *
 * **Gotchas**
 *
 * - Constructors that expect positional arguments are not compatible unless
 *   they also accept the decoded props object.
 * - Private fields or computed getters are not enough for encoding; the
 *   instance must expose properties compatible with the provided struct schema.
 * - Prefer `Schema.Class` or `Schema.ErrorClass` when you control the class
 *   definition and do not need to adapt an existing constructor.
 *
 * @since 4.0.0
 */
import { identity } from "./Function.ts"
import * as Schema from "./Schema.ts"
import * as Transformation from "./SchemaTransformation.ts"

/**
 * Builds an experimental schema for instances of a native class using a struct
 * schema as the encoded representation.
 *
 * **When to use**
 *
 * Use when you need a schema for an existing native class while keeping a
 * `Struct` schema as its encoded representation.
 *
 * **Details**
 *
 * Decoding constructs `new constructor(props)` from the encoded fields.
 * Encoding uses the instance as the encoded shape, so the class should expose
 * properties compatible with the provided encoding schema.
 *
 * @see {@link Schema.instanceOf} for validating existing class instances without a struct encoding
 * @see {@link Schema.Class} for defining schema-backed classes directly
 * @see {@link Schema.ErrorClass} for defining schema-backed error classes
 *
 * @category schemas
 * @since 4.0.0
 */
export function getNativeClassSchema<C extends new(...args: any) => any, S extends Schema.Struct<Schema.Struct.Fields>>(
  constructor: C,
  options: {
    readonly encoding: S
    readonly annotations?: Schema.Annotations.Declaration<InstanceType<C>>
  }
): Schema.decodeTo<Schema.instanceOf<InstanceType<C>, S["Iso"]>, S> {
  const transformation = Transformation.transform<InstanceType<C>, S["Type"]>({
    decode: (props) => new constructor(props),
    encode: identity
  })
  return Schema.instanceOf(constructor, {
    toCodec: () => Schema.link<InstanceType<C>>()(options.encoding, transformation),
    ...options.annotations
  }).pipe(Schema.encodeTo(options.encoding, transformation))
}
