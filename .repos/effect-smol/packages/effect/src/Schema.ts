/**
 * Define data shapes, validate unknown input, and transform values between formats.
 *
 * ## Mental model
 *
 * - **Schema** — a description of a data shape. Every schema carries a decoded
 *   *Type* (the value you work with) and an *Encoded* representation (the
 *   serialized form, e.g. JSON).
 * - **Decoding** — turning unknown external data (API responses, form
 *   submissions, config files) into typed, validated values.
 * - **Encoding** — turning typed values back into a serializable format.
 * - **Codec** — a schema that tracks both Type and Encoded, so it can decode
 *   *and* encode. Most concrete schemas are Codecs.
 * - **Check / Filter** — a constraint attached to a schema (e.g. `isMinLength`,
 *   `isGreaterThan`). Attach them with `.check(...)`.
 * - **Transformation** — a pair of functions (decode + encode) that convert
 *   values between two schemas. Created with {@link decodeTo} / {@link encodeTo}.
 * - **Annotation** — metadata attached to a schema (title, description, custom
 *   keys). Attach with `.annotate(...)`.
 *
 * ## Common tasks
 *
 * - Define a struct: {@link Struct}
 * - Define a union: {@link Union}, {@link TaggedUnion}, {@link Literals}
 * - Define an array: {@link ArraySchema}, {@link NonEmptyArray}
 * - Define a record: {@link Record}
 * - Define a tuple: {@link Tuple}, {@link TupleWithRest}
 * - Validate unknown data synchronously: {@link decodeUnknownSync}
 * - Validate unknown data (Effect): {@link decodeUnknownEffect}
 * - Encode a value: {@link encodeUnknownSync}, {@link encodeUnknownEffect}
 * - Type guard: {@link is}
 * - Assertion: {@link asserts}
 * - Add constraints: `.check(...)` with filters like {@link isMinLength},
 *   {@link isGreaterThan}, {@link isPattern}, {@link isUUID}
 * - Transform between schemas: {@link decodeTo}, {@link encodeTo}
 * - Add a default for missing keys: {@link withDecodingDefault}, {@link withDecodingDefaultKey}
 * - Create branded types: {@link brand}
 * - Define classes with validation: {@link Class}, {@link TaggedClass}
 * - Define error classes: {@link ErrorClass}, {@link TaggedErrorClass}
 * - Generate JSON Schema: {@link toJsonSchemaDocument}
 * - Generate test data: {@link toArbitrary}
 * - Derive equivalence: {@link toEquivalence}
 *
 * ## Gotchas
 *
 * - `Schema.optional` creates `T | undefined` (key can be missing *or*
 *   `undefined`). Use `Schema.optionalKey` for exact optional properties.
 * - `decodeTo` is curried: use `from.pipe(Schema.decodeTo(to, ...))`.
 * - `decodeUnknownSync` throws on failure. Use `decodeUnknownExit` or
 *   `decodeUnknownOption` for non-throwing alternatives.
 * - Filters do not change the TypeScript type. Use {@link refine} or
 *   {@link brand} to narrow the type.
 * - Recursive schemas require {@link suspend} to avoid infinite loops.
 *
 * ## Quickstart
 *
 * **Example** (Validate a user object)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const User = Schema.Struct({
 *   name: Schema.String.check(Schema.isMinLength(1)),
 *   age: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
 *   email: Schema.optionalKey(Schema.String)
 * })
 *
 * // Decode unknown input — throws on failure
 * const user = Schema.decodeUnknownSync(User)({
 *   name: "Alice",
 *   age: 30
 * })
 *
 * console.log(user)
 * // { name: "Alice", age: 30 }
 * ```
 *
 * @see {@link Schema} — type-level view tracking only the decoded Type
 * @see {@link Codec} — type-level view tracking both Type and Encoded
 * @see {@link Struct} — define object shapes
 * @see {@link decodeUnknownSync} — synchronous validation
 * @see {@link decodeTo} — schema transformations
 *
 * @since 4.0.0
 */

/** @effect-diagnostics schemaStructWithTag:skip-file */
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import * as Arr from "./Array.ts"
import * as BigDecimal_ from "./BigDecimal.ts"
import type * as Brand from "./Brand.ts"
import * as Cause_ from "./Cause.ts"
import * as Chunk_ from "./Chunk.ts"
import type * as Combiner from "./Combiner.ts"
import * as Data from "./Data.ts"
import * as DateTime from "./DateTime.ts"
import type { Differ } from "./Differ.ts"
import * as Duration_ from "./Duration.ts"
import * as Effect from "./Effect.ts"
import * as Encoding from "./Encoding.ts"
import * as Equal from "./Equal.ts"
import * as Equivalence from "./Equivalence.ts"
import * as Exit_ from "./Exit.ts"
import type { Formatter } from "./Formatter.ts"
import { format, formatPropertyKey } from "./Formatter.ts"
import { identity, memoize } from "./Function.ts"
import * as HashMap_ from "./HashMap.ts"
import * as HashSet_ from "./HashSet.ts"
import * as core from "./internal/core.ts"
import * as InternalAnnotations from "./internal/schema/annotations.ts"
import * as InternalArbitrary from "./internal/schema/arbitrary.ts"
import * as InternalEquivalence from "./internal/schema/equivalence.ts"
import * as InternalStandard from "./internal/schema/representation.ts"
import * as InternalSchema from "./internal/schema/schema.ts"
import { SchemaError } from "./internal/schema/schema.ts"
import * as JsonPatch from "./JsonPatch.ts"
import * as JsonSchema from "./JsonSchema.ts"
import { remainder } from "./Number.ts"
import * as Optic_ from "./Optic.ts"
import * as Option_ from "./Option.ts"
import * as Order from "./Order.ts"
import * as Pipeable from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"
import * as Record_ from "./Record.ts"
import * as Redacted_ from "./Redacted.ts"
import * as Result_ from "./Result.ts"
import * as Scheduler from "./Scheduler.ts"
import * as AST from "./SchemaAST.ts"
import * as Getter from "./SchemaGetter.ts"
import * as Issue from "./SchemaIssue.ts"
import * as Parser from "./SchemaParser.ts"
import type * as SchemaRepresentation from "./SchemaRepresentation.ts"
import * as Transformation from "./SchemaTransformation.ts"
import type { Assign, Lambda, Mutable, Simplify } from "./Struct.ts"
import * as Struct_ from "./Struct.ts"
import * as FastCheck from "./testing/FastCheck.ts"
import type { RequiredKeys, UnionToIntersection } from "./Types.ts"
import type { Unify } from "./Unify.ts"

const TypeId = InternalSchema.TypeId

/**
 * Whether a schema field is required or optional within a struct.
 *
 * @see {@link optionalKey} — mark a struct field as optional
 * @see {@link optional} — mark a struct field as optional with `| undefined`
 *
 * @category models
 * @since 4.0.0
 */
export type Optionality = "required" | "optional"

/**
 * Whether a schema field is readonly or mutable within a struct.
 *
 * @see {@link mutableKey} — mark a struct field as mutable
 *
 * @category models
 * @since 4.0.0
 */
export type Mutability = "readonly" | "mutable"

/**
 * Whether a schema field has a constructor default value.
 *
 * @see {@link withConstructorDefault} — add a default to a schema field
 * @see {@link tag} — creates a literal field with a constructor default
 *
 * @category models
 * @since 4.0.0
 */
export type ConstructorDefault = "no-default" | "with-default"

/**
 * Options for `makeEffect`, `make`, and Class constructors.
 *
 * **When to use**
 *
 * Use when passing `disableChecks: true` to skip validation when you trust the data.
 * - Pass `parseOptions` to control error reporting behavior.
 *
 * @see {@link Bottom.makeEffect}
 * @see {@link Bottom.make}
 *
 * @category models
 * @since 3.13.4
 */
export interface MakeOptions {
  /**
   * The parse options to use for the schema.
   */
  readonly parseOptions?: AST.ParseOptions | undefined
  /**
   * Whether to disable validation for the schema.
   */
  readonly disableChecks?: boolean | undefined
}

/**
 * The fully-parameterized base interface for all schemas. Exposes all 14 type
 * parameters controlling type inference, mutability, optionality, services,
 * and transformation behavior.
 *
 * **When to use**
 *
 * Use when you are writing advanced generic schema utilities or performing schema
 *   introspection.
 * - In user code, prefer {@link Schema}, {@link Codec}, {@link Decoder}, or
 *   {@link Encoder} instead.
 *
 * @see {@link Top} — the existential "any schema" type (erased type params)
 * @see {@link Schema} — tracks only the decoded Type
 * @see {@link Codec} — tracks Type + Encoded
 *
 * @category models
 * @since 4.0.0
 */
export interface Bottom<
  out T,
  out E,
  out RD,
  out RE,
  out Ast extends AST.AST,
  out Rebuild extends Top,
  out TypeMakeIn = T,
  out Iso = T,
  in out TypeParameters extends ReadonlyArray<Top> = readonly [],
  out TypeMake = TypeMakeIn,
  out TypeMutability extends Mutability = "readonly",
  out TypeOptionality extends Optionality = "required",
  out TypeConstructorDefault extends ConstructorDefault = "no-default",
  out EncodedMutability extends Mutability = "readonly",
  out EncodedOptionality extends Optionality = "required"
> extends Pipeable.Pipeable {
  readonly [TypeId]: typeof TypeId

  readonly "ast": Ast
  readonly "Rebuild": Rebuild
  readonly "~type.parameters": TypeParameters

  readonly "Type": T
  readonly "Encoded": E
  readonly "DecodingServices": RD
  readonly "EncodingServices": RE

  readonly "~type.make.in": TypeMakeIn
  readonly "~type.make": TypeMake // useful to type the `refine` interface
  readonly "~type.constructor.default": TypeConstructorDefault
  readonly "Iso": Iso

  readonly "~type.mutability": TypeMutability
  readonly "~type.optionality": TypeOptionality
  readonly "~encoded.mutability": EncodedMutability
  readonly "~encoded.optionality": EncodedOptionality

  annotate(annotations: Annotations.Bottom<this["Type"], this["~type.parameters"]>): this["Rebuild"]
  annotateKey(annotations: Annotations.Key<this["Type"]>): this["Rebuild"]
  check(...checks: readonly [AST.Check<this["Type"]>, ...Array<AST.Check<this["Type"]>>]): this["Rebuild"]
  rebuild(ast: this["ast"]): this["Rebuild"]
  /**
   * Constructs a value from the make input representation synchronously.
   *
   * **When to use**
   *
   * Use when constructor input is trusted or when validation failure
   * should abort with a thrown `Error`.
   *
   * **Details**
   *
   * Applies constructor defaults and type-side validation according to
   * `MakeOptions`.
   *
   * **Gotchas**
   *
   * Throws an `Error` with the schema issue in its `cause` when validation
   * fails.
   *
   * @see {@link Bottom.makeOption} — construct synchronously and discard validation details
   * @see {@link Bottom.makeEffect} — construct through `Effect` when validation failure should stay in the error channel
   */
  make(input: this["~type.make.in"], options?: MakeOptions): this["Type"]
  /**
   * Constructs a value from the make input representation, returning `Option.none`
   * when validation fails.
   *
   * **When to use**
   *
   * Use when you only need to know whether construction succeeds
   * and do not need validation details.
   *
   * **Details**
   *
   * Applies constructor defaults and type-side validation according to
   * `MakeOptions`.
   *
   * @see {@link Bottom.make} — construct synchronously when validation failure should throw
   * @see {@link Bottom.makeEffect} — construct through `Effect` when validation details should stay in the error channel
   */
  makeOption(input: this["~type.make.in"], options?: MakeOptions): Option_.Option<this["Type"]>
  /**
   * Constructs a value from the make input representation, returning validation
   * failures in the `Effect` error channel.
   *
   * **When to use**
   *
   * Use when constructor input may fail validation and you want to
   * compose that failure with other `Effect` operations instead of throwing.
   *
   * @see {@link Bottom.make} — construct synchronously when validation failure should throw
   * @see {@link Bottom.makeOption} — construct synchronously and discard validation details
   */
  makeEffect(input: this["~type.make.in"], options?: MakeOptions): Effect.Effect<this["Type"], SchemaError>
}

/**
 * The schema type returned by {@link declareConstructor}, tracking the decoded
 * type `T`, the encoded type `E`, and the list of type-parameter schemas
 * `TypeParameters`.
 *
 * @category constructors
 * @since 4.0.0
 */
export interface declareConstructor<T, E, TypeParameters extends ReadonlyArray<Top>, Iso = T> extends
  Bottom<
    T,
    E,
    TypeParameters[number]["DecodingServices"],
    TypeParameters[number]["EncodingServices"],
    AST.Declaration,
    declareConstructor<T, E, TypeParameters, Iso>,
    T,
    Iso,
    TypeParameters
  >
{}

/**
 * Creates a schema for a **parametric** type (a generic container such as
 * `Array<A>`, `Option<A>`, etc.) by accepting a list of type-parameter schemas
 * and a decoder factory.
 *
 * **Details**
 *
 * The outer call `declareConstructor<T, E, Iso>()` fixes the decoded type `T`,
 * the encoded type `E`, and the optional iso type. The inner call receives:
 * - `typeParameters` — the concrete schemas for each type variable
 * - `run` — a factory that, given resolved codecs for each type parameter,
 *   returns a parsing function `(u, ast, options) => Effect<T, Issue>`
 * - `annotations` — optional metadata
 *
 * @see {@link declare} for creating schemas for non-parametric types.
 *
 * **Example** (Schema for a parametric `Box<A>` type)
 *
 * ```ts
 * import { Effect, Option, Schema, SchemaIssue as Issue, SchemaParser } from "effect"
 *
 * interface Box<A> {
 *   readonly value: A
 * }
 *
 * const isBox = (u: unknown): u is Box<unknown> =>
 *   typeof u === "object" && u !== null && "value" in u
 *
 * const Box = <A extends Schema.Top>(item: A) =>
 *   Schema.declareConstructor<Box<A["Type"]>, Box<A["Encoded"]>>()(
 *     [item],
 *     ([itemCodec]) =>
 *       (u, ast, options) => {
 *         if (!isBox(u)) {
 *           return Effect.fail(new Issue.InvalidType(ast, Option.some(u)))
 *         }
 *         return Effect.map(
 *           SchemaParser.decodeUnknownEffect(itemCodec)(u.value, options),
 *           (value) => ({ value })
 *         )
 *       }
 *   )
 *
 * const schema = Box(Schema.Number)
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export function declareConstructor<T, E = T, Iso = T>() {
  return <const TypeParameters extends ReadonlyArray<Top>>(
    typeParameters: TypeParameters,
    run: (
      typeParameters: {
        readonly [K in keyof TypeParameters]: Codec<TypeParameters[K]["Type"], TypeParameters[K]["Encoded"]>
      }
    ) => (u: unknown, self: AST.Declaration, options: AST.ParseOptions) => Effect.Effect<T, Issue.Issue>,
    annotations?: Annotations.Declaration<T, TypeParameters>
  ): declareConstructor<T, E, TypeParameters, Iso> => {
    return make(
      new AST.Declaration(
        typeParameters.map(AST.getAST),
        (typeParameters) => run(typeParameters.map((ast) => make(ast)) as any),
        annotations
      )
    )
  }
}

/**
 * The schema type returned by {@link declare}, representing a non-parametric
 * opaque type `T` with no type parameters.
 *
 * @category constructors
 * @since 3.13.3
 */
export interface declare<T, Iso = T> extends declareConstructor<T, T, readonly [], Iso> {
  readonly "Rebuild": declare<T, Iso>
}

/**
 * Creates a schema for a **non-parametric** opaque type using a type-guard
 * function. The schema accepts any unknown value and succeeds when `is` returns
 * `true`, failing with an `InvalidType` issue otherwise.
 *
 * **Details**
 *
 * Use this when the type has no type parameters. For parametric types such as
 * `Option<A>` or `Array<A>`, use {@link declareConstructor} instead.
 *
 * **Example** (Schema for a custom `UserId` branded type)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * type UserId = string & { readonly _tag: "UserId" }
 *
 * const isUserId = (u: unknown): u is UserId =>
 *   typeof u === "string" && u.startsWith("user_")
 *
 * const UserId = Schema.declare<UserId>(isUserId, {
 *   title: "UserId",
 *   description: "A user identifier starting with 'user_'"
 * })
 * ```
 *
 * @see {@link declareConstructor} for creating schemas for parametric types.
 *
 * @category constructors
 * @since 3.10.0
 */
export function declare<T, Iso = T>(
  is: (u: unknown) => u is T,
  annotations?: Annotations.Declaration<T> | undefined
): declare<T, Iso> {
  return declareConstructor<T, T, Iso>()(
    [],
    () => (input, ast) =>
      is(input) ?
        Effect.succeed(input) :
        Effect.fail(new Issue.InvalidType(ast, Option_.some(input))),
    annotations
  )
}

/**
 * Returns a schema widened to the fully-parameterized {@link Bottom} interface,
 * making all 14 type parameters visible to TypeScript.
 *
 * **Details**
 *
 * Normally, concrete schema interfaces (e.g. `Schema<string>`) hide most type
 * parameters. `revealBottom` is useful when writing generic utilities that need
 * to inspect or propagate the complete set of type parameters.
 *
 * **Example** (Inspecting all type parameters of a schema)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.String
 *
 * // Widen to Bottom to access all 14 type parameters
 * const bottom = Schema.revealBottom(schema)
 *
 * // `bottom` now exposes Type, Encoded, DecodingServices, EncodingServices,
 * // ast, Rebuild, ~type.make.in, Iso, ~type.parameters, etc.
 * type T = typeof bottom["Type"]     // string
 * type E = typeof bottom["Encoded"]  // string
 * ```
 *
 * @category utils
 * @since 4.0.0
 */
export function revealBottom<S extends Top>(
  bottom: S
): Bottom<
  S["Type"],
  S["Encoded"],
  S["DecodingServices"],
  S["EncodingServices"],
  S["ast"],
  S["Rebuild"],
  S["~type.make.in"],
  S["Iso"],
  S["~type.parameters"],
  S["~type.make"],
  S["~type.mutability"],
  S["~type.optionality"],
  S["~type.constructor.default"],
  S["~encoded.mutability"],
  S["~encoded.optionality"]
> {
  return bottom
}

/**
 * Adds metadata annotations to a schema without changing its runtime behavior.
 * This is the pipeable (curried) counterpart of the `.annotate` method.
 *
 * **Details**
 *
 * Annotations provide extra context used by documentation generators, JSON
 * Schema converters, error formatters, and other tooling. Common keys include
 * `title`, `description`, `examples`, `message`, and `identifier`.
 *
 * **Example** (Adding a title and description)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const Age = Schema.Number.pipe(
 *   Schema.annotate({
 *     title: "Age",
 *     description: "A non-negative integer representing age in years"
 *   })
 * )
 * ```
 *
 * @see {@link annotateEncoded} to annotate the encoded side instead.
 *
 * @category annotations
 * @since 4.0.0
 */
export function annotate<S extends Top>(annotations: Annotations.Bottom<S["Type"], S["~type.parameters"]>) {
  return (self: S) => self.annotate(annotations)
}

/**
 * Adds metadata annotations to the **encoded** side of a schema without
 * changing its runtime behavior. This is the encoded-side counterpart of
 * `annotate`, which targets the decoded (Type) side.
 *
 * **Details**
 *
 * Internally the schema is flipped so that `Encoded` becomes `Type`,
 * annotated, and then flipped back.
 *
 * **Example** (Adding a title to the encoded representation)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.NumberFromString.pipe(
 *   Schema.annotateEncoded({
 *     title: "my title"
 *   })
 * )
 *
 * console.log(Schema.toEncoded(schema).ast.annotations?.title)
 * // "my title"
 * ```
 *
 * @see {@link annotate} to annotate the type side instead.
 *
 * @category annotations
 * @since 4.0.0
 */
export function annotateEncoded<S extends Top>(annotations: Annotations.Bottom<S["Encoded"], readonly []>) {
  return (self: S): S["Rebuild"] => flip(flip(self).annotate(annotations))
}

/**
 * Adds key-level annotations to a schema field. This is the pipeable
 * (curried) counterpart of the `.annotateKey` method.
 *
 * **Details**
 *
 * Key annotations apply to a field's position inside a `Struct` or `Tuple`
 * rather than to the field's value type. They can carry a
 * `messageMissingKey` to customise the error shown when the field is absent,
 * as well as standard documentation fields such as `title`, `description`,
 * and `examples`.
 *
 * **Example** (Custom missing-key message for a required field)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.Struct({
 *   username: Schema.String.pipe(
 *     Schema.annotateKey({
 *       description: "The username used to log in",
 *       messageMissingKey: "Username is required"
 *     })
 *   )
 * })
 * ```
 *
 * @category annotations
 * @since 4.0.0
 */
export function annotateKey<S extends Top>(annotations: Annotations.Key<S["Type"]>) {
  return (self: S): S["Rebuild"] => {
    return self.rebuild(AST.annotateKey(self.ast, annotations))
  }
}

/**
 * The existential "any schema" type — all type parameters are erased to `unknown`.
 *
 * **Details**
 *
 * Use `Top` as a constraint when writing generic utilities that must accept *any*
 * schema regardless of its `Type`, `Encoded`, or service requirements. It is the
 * widest possible schema type and therefore gives you the least static information.
 *
 * In user code prefer the narrower interfaces:
 * - {@link Schema}`<T>` — when you only care about the decoded type
 * - {@link Codec}`<T, E, RD, RE>` — when you need the encoded type and service requirements
 * - {@link Decoder}`<T, RD>` — for decode-only APIs
 * - {@link Encoder}`<E, RE>` — for encode-only APIs
 *
 * @category models
 * @since 4.0.0
 */
export interface Top extends
  Bottom<
    unknown,
    unknown,
    unknown,
    unknown,
    AST.AST,
    Top,
    unknown,
    unknown,
    any, // this is because TypeParameters is invariant
    unknown,
    Mutability,
    Optionality,
    ConstructorDefault,
    Mutability,
    Optionality
  >
{}

/**
 * Namespace of type-level helpers for {@link Schema}.
 *
 * @since 3.10.0
 */
export declare namespace Schema {
  /**
   * Extracts the decoded `Type` from a schema.
   *
   * **Example** (Extracting the decoded type)
   *
   * ```ts
   * import { Schema } from "effect"
   *
   * const Person = Schema.Struct({ name: Schema.String, age: Schema.Number })
   * type Person = Schema.Schema.Type<typeof Person>
   * // { readonly name: string; readonly age: number }
   * ```
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Type<S> = S extends Top ? S["Type"] : never
}

/**
 * A typed view of a schema that tracks only the decoded (output) type `T`.
 *
 * **Details**
 *
 * Use `Schema<T>` as a constraint when you want to accept "any schema that
 * decodes to `T`" and do not need to know or constrain the encoded
 * representation, required services, or any other type parameters.
 *
 * This is a structural interface — concrete schema values are produced by the
 * constructors in this module (e.g. {@link Struct}, {@link String}, {@link Number}).
 * When you also need the encoded type or service requirements, use {@link Codec}.
 *
 * **Example** (Function that accepts any schema decoding to `string`)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * declare function print(schema: Schema.Schema<string>): void
 *
 * print(Schema.String)            // ok
 * print(Schema.NonEmptyString)    // ok
 * ```
 *
 * @see {@link Codec} — also tracks Encoded, DecodingServices, EncodingServices
 * @see {@link Schema.Type} — extract the decoded type at the type level
 *
 * @category models
 * @since 3.10.0
 */
export interface Schema<out T> extends Top {
  readonly "Type": T
  readonly "Rebuild": Schema<T>
}

/**
 * Namespace of type-level helpers for {@link Codec}.
 *
 * @since 4.0.0
 */
export declare namespace Codec {
  /**
   * Extracts the encoded (`Encoded`) type from a schema.
   *
   * **Example** (Extracting the encoded type)
   *
   * ```ts
   * import { Schema } from "effect"
   *
   * const schema = Schema.NumberFromString
   * type Enc = Schema.Codec.Encoded<typeof schema>
   * // string
   * ```
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Encoded<S> = S extends Top ? S["Encoded"] : never
  /**
   * Extracts the Effect services required during *decoding* from a schema.
   *
   * **Example** (Checking decoding service requirements)
   *
   * ```ts
   * import { Schema } from "effect"
   *
   * const schema = Schema.String
   * type RD = Schema.Codec.DecodingServices<typeof schema>
   * // never
   * ```
   *
   * @category utility types
   * @since 4.0.0
   */
  export type DecodingServices<S> = S extends Top ? S["DecodingServices"] : never
  /**
   * Extracts the Effect services required during *encoding* from a schema.
   *
   * **Example** (Checking encoding service requirements)
   *
   * ```ts
   * import { Schema } from "effect"
   *
   * const schema = Schema.String
   * type RE = Schema.Codec.EncodingServices<typeof schema>
   * // never
   * ```
   *
   * @category utility types
   * @since 4.0.0
   */
  export type EncodingServices<S> = S extends Top ? S["EncodingServices"] : never
}

/**
 * A schema that additionally supports optic (lens/prism) operations.
 *
 * **Details**
 *
 * `Optic<T, Iso>` extends {@link Schema}`<T>` with an `Iso` type that
 * describes the isomorphic counterpart used by the optic layer. Crucially,
 * decoding and encoding require *no* Effect services (`DecodingServices` and
 * `EncodingServices` are both `never`), which means the optic can operate
 * purely without an Effect runtime.
 *
 * Most primitive schemas (e.g. `Schema.String`, `Schema.Number`) implement
 * `Optic` automatically. You normally interact with this interface through
 * {@link Optic_} utilities rather than constructing it directly.
 *
 * @category models
 * @since 4.0.0
 */
export interface Optic<out T, out Iso> extends Schema<T> {
  readonly "Iso": Iso
  readonly "DecodingServices": never
  readonly "EncodingServices": never
  readonly "Rebuild": Optic<T, Iso>
}

/**
 * A schema that tracks the decoded type `T`, the encoded type `E`, and the
 * Effect services required during decoding (`RD`) and encoding (`RE`).
 *
 * **Details**
 *
 * Use `Codec<T, E, RD, RE>` when you need to preserve full type information
 * about a schema — both what it decodes to and what it serializes from/to.
 * Most concrete schemas produced by this module implement `Codec`.
 *
 * For APIs that only need one direction, prefer the narrower views:
 * - {@link Decoder}`<T, RD>` — decode-only
 * - {@link Encoder}`<E, RE>` — encode-only
 * - {@link Schema}`<T>` — type-only (no encoded representation)
 *
 * **Example** (Accepting a codec that decodes to `number` from `string`)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * declare function serialize<T>(codec: Schema.Codec<T, string>): string
 *
 * serialize(Schema.NumberFromString) // ok — decodes number, encoded as string
 * ```
 *
 * @see {@link Codec.Encoded} — extract the encoded type
 * @see {@link Codec.DecodingServices} — extract required decoding services
 * @see {@link Codec.EncodingServices} — extract required encoding services
 * @see {@link revealCodec} — helper to make TypeScript infer the full Codec type
 *
 * @category models
 * @since 4.0.0
 */
export interface Codec<out T, out E = T, out RD = never, out RE = never> extends Schema<T> {
  readonly "Encoded": E
  readonly "DecodingServices": RD
  readonly "EncodingServices": RE
  readonly "Rebuild": Codec<T, E, RD, RE>
}

/**
 * A {@link Codec} view for APIs that only *decode* (parse/validate) values.
 *
 * **Details**
 *
 * Use `Decoder<T, RD>` to accept "any schema that can decode to `T`" without
 * constraining or depending on the encoded representation (`Encoded` is
 * `unknown`) or encoding services.
 *
 * **Example** (Function that only needs to decode)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * declare function validate<T>(decoder: Schema.Decoder<T>): (input: unknown) => T
 *
 * validate(Schema.String)          // ok
 * validate(Schema.NumberFromString) // ok
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export interface Decoder<out T, out RD = never> extends Codec<T, unknown, RD, unknown> {
  readonly "Rebuild": Decoder<T, RD>
}

/**
 * A {@link Codec} view for APIs that only *encode* values.
 *
 * **Details**
 *
 * Use `Encoder<E, RE>` to accept "any schema that can encode to `E`" without
 * constraining or depending on the decoded `Type` (`Type` is `unknown`) or
 * decoding services.
 *
 * **Example** (Function that only needs to encode)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * declare function serialize<E>(encoder: Schema.Encoder<E>): (value: unknown) => E
 *
 * serialize(Schema.String)          // ok — encodes to string
 * serialize(Schema.NumberFromString) // ok — encodes number to string
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export interface Encoder<out E, out RE = never> extends Codec<unknown, E, unknown, RE> {
  readonly "Rebuild": Encoder<E, RE>
}

/**
 * Returns a codec widened to the full {@link Codec} interface, prompting
 * TypeScript to infer all four type parameters (`T`, `E`, `RD`, `RE`).
 *
 * **Details**
 *
 * When a schema is stored in a variable typed as `Schema<T>` or `Top`, the
 * encoded type and service requirements are erased. Passing the value through
 * `revealCodec` recovers those parameters without any runtime cost.
 *
 * **Example** (Recovering encoded type from a schema variable)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema: Schema.Schema<number> = Schema.NumberFromString
 *
 * // Without revealCodec, Encoded is unknown
 * const codec = Schema.revealCodec(schema)
 * type Enc = typeof codec["Encoded"] // string
 * ```
 *
 * @category utils
 * @since 4.0.0
 */
export function revealCodec<T, E, RD, RE>(codec: Codec<T, E, RD, RE>) {
  return codec
}

export {
  /**
   * Error thrown (or returned as the error channel value) when schema decoding
   * or encoding fails.
   *
   * **Details**
   *
   * The `issue` field contains a structured {@link Issue.Issue} tree describing
   * every validation failure, including the path to the problematic value,
   * expected types, and actual values received. `message` renders the issue tree
   * as a human-readable string.
   *
   * Use {@link isSchemaError} to narrow an unknown value to `SchemaError`.
   *
   * **Example** (Catching a SchemaError)
   *
   * ```ts
   * import { Schema } from "effect"
   *
   * try {
   *   Schema.decodeUnknownSync(Schema.Number)("not a number")
   * } catch (err) {
   *   if (Schema.isSchemaError(err)) {
   *     console.log(err.message)
   *     // Expected number, actual "not a number"
   *   }
   * }
   * ```
   *
   * @category errors
   * @since 4.0.0
   */
  SchemaError
}

/**
 * Returns `true` if `u` is a {@link SchemaError}.
 *
 * **Example** (Type guard in a catch block)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * try {
 *   Schema.decodeUnknownSync(Schema.Number)("oops")
 * } catch (err) {
 *   if (Schema.isSchemaError(err)) {
 *     console.log(err._tag) // "SchemaError"
 *   }
 * }
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export function isSchemaError(u: unknown): u is SchemaError {
  return Predicate.hasProperty(u, InternalSchema.SchemaErrorTypeId)
}

function makeStandardResult<A>(exit: Exit_.Exit<StandardSchemaV1.Result<A>>): StandardSchemaV1.Result<A> {
  return Exit_.isSuccess(exit) ? exit.value : {
    issues: [{ message: Cause_.pretty(exit.cause) }]
  }
}

/**
 * Returns a "Standard Schema" object conforming to the [Standard Schema
 * v1](https://standardschema.dev/) specification.
 *
 * **Details**
 *
 * This function creates a schema whose `validate` method attempts to decode and
 * validate the provided input synchronously. If the underlying `Schema`
 * includes any asynchronous components (e.g., asynchronous message resolutions
 * or checks), then validation will necessarily return a `Promise` instead.
 *
 * **Example** (Creating a standard schema from a regular schema)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * // Define custom hook functions for error formatting
 * const leafHook = (issue: any) => {
 *   switch (issue._tag) {
 *     case "InvalidType":
 *       return "Expected different type"
 *     case "InvalidValue":
 *       return "Invalid value provided"
 *     case "MissingKey":
 *       return "Required property missing"
 *     case "UnexpectedKey":
 *       return "Unexpected property found"
 *     case "Forbidden":
 *       return "Operation not allowed"
 *     case "OneOf":
 *       return "Multiple valid options available"
 *     default:
 *       return "Validation error"
 *   }
 * }
 *
 * // Create a standard schema from a regular schema
 * const PersonSchema = Schema.Struct({
 *   name: Schema.NonEmptyString,
 *   age: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 150 }))
 * })
 *
 * const standardSchema = Schema.toStandardSchemaV1(PersonSchema, {
 *   leafHook
 * })
 *
 * // The standard schema can be used with any Standard Schema v1 compatible library
 * const validResult = standardSchema["~standard"].validate({
 *   name: "Alice",
 *   age: 30
 * })
 * console.log(validResult) // { value: { name: "Alice", age: 30 } }
 *
 * const invalidResult = standardSchema["~standard"].validate({
 *   name: "",
 *   age: 200
 * })
 * console.log(invalidResult) // { issues: [{ path: ["name"], message: "..." }, { path: ["age"], message: "..." }] }
 * ```
 *
 * @category Standard Schema
 * @since 4.0.0
 */
export function toStandardSchemaV1<S extends Decoder<unknown>>(
  self: S,
  options?: {
    readonly leafHook?: Issue.LeafHook | undefined
    readonly checkHook?: Issue.CheckHook | undefined
    readonly parseOptions?: AST.ParseOptions | undefined
  }
): StandardSchemaV1<S["Encoded"], S["Type"]> & S {
  const decodeUnknownEffect = Parser.decodeUnknownEffect(self) as (
    input: unknown,
    options?: AST.ParseOptions
  ) => Effect.Effect<S["Type"], Issue.Issue>
  const parseOptions: AST.ParseOptions = { errors: "all", ...options?.parseOptions }
  const formatter = Issue.makeFormatterStandardSchemaV1(options)
  const validate: StandardSchemaV1<S["Encoded"], S["Type"]>["~standard"]["validate"] = (value: unknown) => {
    const scheduler = new Scheduler.MixedScheduler()
    const fiber = Effect.runFork(
      Effect.match(decodeUnknownEffect(value, parseOptions), {
        onFailure: formatter,
        onSuccess: (value): StandardSchemaV1.Result<S["Type"]> => ({ value })
      }),
      { scheduler }
    )
    fiber.currentDispatcher?.flush()
    const exit = fiber.pollUnsafe()
    if (exit) {
      return makeStandardResult(exit)
    }
    return new Promise((resolve) => {
      fiber.addObserver((exit) => {
        resolve(makeStandardResult(exit))
      })
    })
  }
  if ("~standard" in self) {
    const out = self as any
    if ("validate" in out["~standard"]) return out
    Object.assign(out["~standard"], { validate })
    return out
  } else {
    return Object.assign(self, {
      "~standard": {
        version: 1,
        vendor: "effect",
        validate
      } as const
    })
  }
}

function toBaseStandardJSONSchemaV1(self: Top, target: StandardJSONSchemaV1.Target): JsonSchema.JsonSchema {
  const doc2020_12 = toJsonSchemaDocument(self)
  if (target === "draft-2020-12") {
    const schema = doc2020_12.schema
    if (Object.keys(doc2020_12.definitions).length > 0) {
      schema.$defs = doc2020_12.definitions
    }
    return schema
  } else if (target === "draft-07") {
    const doc07 = JsonSchema.toDocumentDraft07(doc2020_12)
    const schema = doc07.schema
    if (Object.keys(doc07.definitions).length > 0) {
      schema.definitions = doc07.definitions
    }
    return schema
  }
  throw new globalThis.Error(`Unsupported target: ${target}`)
}

/**
 * Converts a schema to an experimental Standard JSON Schema V1 representation.
 *
 * **Details**
 *
 * https://github.com/standard-schema/standard-schema/pull/134
 *
 * @category Standard Schema
 * @since 4.0.0
 */
export function toStandardJSONSchemaV1<S extends Top>(self: S): StandardJSONSchemaV1<S["Encoded"], S["Type"]> & S {
  const jsonSchema: StandardJSONSchemaV1.Props<S["Encoded"], S["Type"]>["jsonSchema"] = {
    input(options) {
      return toBaseStandardJSONSchemaV1(self, options.target)
    },
    output(options) {
      return toBaseStandardJSONSchemaV1(toType(self), options.target)
    }
  }
  if ("~standard" in self) {
    const out = self as any
    if ("jsonSchema" in out["~standard"]) return out
    Object.assign(out["~standard"], { jsonSchema })
    return out
  } else {
    return Object.assign(self, {
      "~standard": {
        version: 1,
        vendor: "effect",
        jsonSchema
      } as const
    })
  }
}

/**
 * Creates a type guard function that checks if a value conforms to a given
 * schema.
 *
 * **Details**
 *
 * This function returns a predicate that performs a type-safe check, narrowing
 * the type of the input value if the check passes. It's particularly useful for
 * runtime type validation and TypeScript type narrowing.
 *
 * **Example** (Basic Type Guard)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const isString = Schema.is(Schema.String)
 *
 * console.log(isString("hello")) // true
 * console.log(isString(42)) // false
 *
 * // Type narrowing in action
 * const value: unknown = "hello"
 * if (isString(value)) {
 *   // value is now typed as string
 *   console.log(value.toUpperCase()) // "HELLO"
 * }
 * ```
 *
 * @category guards
 * @since 3.10.0
 */
export const is = Parser.is

/**
 * Creates an assertion function that throws an error if the input doesn't match
 * the schema.
 *
 * **When to use**
 *
 * Use to validate unknown input at runtime while narrowing the value with a
 * TypeScript `asserts` predicate.
 *
 * **Details**
 *
 * The input is narrowed if the assertion succeeds. If validation fails, the
 * assertion throws.
 *
 * **Example** (Basic Usage)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const input: unknown = "hello"
 *
 * // This will pass silently (no return value) and narrow input to string
 * Schema.asserts(Schema.String, input)
 * console.log(input.toUpperCase())
 *
 * // This will throw an error
 * try {
 *   const invalid: unknown = 123
 *   Schema.asserts(Schema.String, invalid)
 * } catch (error) {
 *   console.log("Non-string assertion failed as expected")
 * }
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const asserts: <S extends Top, I>(schema: S, input: I) => asserts input is I & S["Type"] = Parser.asserts

/**
 * Decodes an `unknown` input against a schema, returning an `Effect` that
 * succeeds with the decoded value or fails with a {@link SchemaError}.
 *
 * **When to use**
 *
 * Use when decoding input whose type is not statically known.
 *
 * **Details**
 *
 * Prefer {@link decodeEffect} when the input is already typed as the schema's
 * `Encoded` type.
 * Options may be provided either when creating the decoder or when applying it;
 * application options override creation options.
 *
 * @category decoding
 * @since 4.0.0
 */
export function decodeUnknownEffect<S extends Top>(schema: S, options?: AST.ParseOptions) {
  const parser = Parser.decodeUnknownEffect(schema, options)
  return (input: unknown, options?: AST.ParseOptions): Effect.Effect<S["Type"], SchemaError, S["DecodingServices"]> => {
    return Effect.mapErrorEager(parser(input, options), (issue) => new SchemaError(issue))
  }
}

/**
 * Decodes a typed input (the schema's `Encoded` type) against a schema,
 * returning an `Effect` that succeeds with the decoded value or fails with a
 * {@link SchemaError}.
 *
 * **When to use**
 *
 * Use when the input is already typed as the schema's `Encoded` type.
 *
 * **Details**
 *
 * For `unknown` input use {@link decodeUnknownEffect}.
 * Options may be provided either when creating the decoder or when applying it;
 * application options override creation options.
 *
 * @category decoding
 * @since 4.0.0
 */
export const decodeEffect: <S extends Top>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Encoded"], options?: AST.ParseOptions) => Effect.Effect<S["Type"], SchemaError, S["DecodingServices"]> =
  decodeUnknownEffect

/**
 * Decodes an `unknown` input against a schema synchronously, returning an
 * `Exit` that is either a `Success` with the decoded value or a `Failure` with
 * a {@link SchemaError}.
 *
 * **When to use**
 *
 * Use when the input type is not statically known and decoding should return an
 * `Exit` instead of failing or throwing.
 *
 * **Details**
 *
 * Only usable with schemas that have no `DecodingServices` requirement. Prefer
 * {@link decodeExit} when the input is already typed as the schema's `Encoded`
 * type.
 * Options may be provided either when creating the decoder or when applying it;
 * application options override creation options.
 *
 * @category decoding
 * @since 4.0.0
 */
export function decodeUnknownExit<S extends Decoder<unknown>>(schema: S, options?: AST.ParseOptions) {
  const parser = Parser.decodeUnknownExit(schema, options)
  return (input: unknown, options?: AST.ParseOptions): Exit_.Exit<S["Type"], SchemaError> => {
    return Exit_.mapError(parser(input, options), (issue) => new SchemaError(issue))
  }
}

/**
 * Decodes a typed input (the schema's `Encoded` type) against a schema
 * synchronously, returning an `Exit` that is either a `Success` with the
 * decoded value or a `Failure` with a {@link SchemaError}.
 *
 * **When to use**
 *
 * Use when typed input should be decoded into an `Exit` instead of failing or
 * throwing.
 *
 * **Details**
 *
 * Only usable with schemas that have no `DecodingServices` requirement. For
 * `unknown` input use {@link decodeUnknownExit}.
 * Options may be provided either when creating the decoder or when applying it;
 * application options override creation options.
 *
 * @category decoding
 * @since 4.0.0
 */
export const decodeExit: <S extends Decoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Encoded"], options?: AST.ParseOptions) => Exit_.Exit<S["Type"], SchemaError> = decodeUnknownExit

/**
 * Decodes an `unknown` input against a schema, returning an `Option` that is
 * `Some` with the decoded value on success or `None` on failure.
 *
 * **When to use**
 *
 * Use when the input type is not statically known and you only need to know
 * whether decoding succeeded.
 *
 * **Details**
 *
 * Prefer this over {@link decodeUnknownExit} or {@link decodeUnknownEffect}
 * when you don't need error details. For typed input use {@link decodeOption}.
 * Options may be provided either when creating the decoder or when applying it;
 * application options override creation options.
 *
 * @category decoding
 * @since 3.10.0
 */
export const decodeUnknownOption = Parser.decodeUnknownOption

/**
 * Decodes a typed input (the schema's `Encoded` type) against a schema,
 * returning an `Option` that is `Some` with the decoded value on success or
 * `None` on failure.
 *
 * **When to use**
 *
 * Use when typed input should be decoded and only success or failure matters.
 *
 * **Details**
 *
 * For `unknown` input use {@link decodeUnknownOption}.
 * Options may be provided either when creating the decoder or when applying it;
 * application options override creation options.
 *
 * @category decoding
 * @since 3.10.0
 */
export const decodeOption = Parser.decodeOption

/**
 * Decodes an `unknown` input against a schema, returning a `Result` that
 * succeeds with the decoded value or fails with a schema issue.
 *
 * **When to use**
 *
 * Use when the input type is not statically known and decoding should return a
 * `Result` with structured issue data.
 *
 * **Details**
 *
 * For typed input use {@link decodeResult}.
 * Options may be provided either when creating the decoder or when applying it;
 * application options override creation options.
 *
 * @category decoding
 * @since 4.0.0
 */
export const decodeUnknownResult = Parser.decodeUnknownResult

/**
 * Decodes a typed input (the schema's `Encoded` type) against a schema,
 * returning a `Result` that succeeds with the decoded value or fails with a
 * schema issue.
 *
 * **When to use**
 *
 * Use when typed input should be decoded into a `Result` with structured issue
 * data.
 *
 * **Details**
 *
 * For `unknown` input use {@link decodeUnknownResult}.
 * Options may be provided either when creating the decoder or when applying it;
 * application options override creation options.
 *
 * @category decoding
 * @since 4.0.0
 */
export const decodeResult = Parser.decodeResult

/**
 * Decodes an `unknown` input against a schema, returning a `Promise` that
 * resolves with the decoded value or rejects with a schema issue.
 *
 * **When to use**
 *
 * Use when integrating unknown input validation with Promise-based APIs.
 *
 * **Details**
 *
 * For typed input use {@link decodePromise}.
 * Options may be provided either when creating the decoder or when applying it;
 * application options override creation options.
 *
 * @category decoding
 * @since 3.10.0
 */
export const decodeUnknownPromise = Parser.decodeUnknownPromise

/**
 * Decodes a typed input (the schema's `Encoded` type) against a schema,
 * returning a `Promise` that resolves with the decoded value or rejects with a
 * schema issue.
 *
 * **When to use**
 *
 * Use when integrating typed input decoding with Promise-based APIs.
 *
 * **Details**
 *
 * For `unknown` input use `decodeUnknownPromise`.
 * Options may be provided either when creating the decoder or when applying it;
 * application options override creation options.
 *
 * @category decoding
 * @since 3.10.0
 */
export const decodePromise = Parser.decodePromise

/**
 * Decodes an `unknown` input against a schema synchronously, returning the
 * decoded value or throwing an `Error` whose cause contains the schema issue.
 *
 * **When to use**
 *
 * Use when validating unknown data at a boundary and treating schema mismatches
 * as exceptions.
 *
 * **Details**
 *
 * For typed input use `decodeSync`.
 * Only service-free schemas can be decoded synchronously. For non-throwing
 * alternatives see `decodeUnknownOption`, `decodeUnknownExit`, or
 * `decodeUnknownEffect`. Options may be provided either when creating the
 * decoder or when applying it; application options override creation options.
 *
 * **Example** (Decoding with a transformation schema)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const NumberFromString = Schema.NumberFromString
 *
 * console.log(Schema.decodeUnknownSync(NumberFromString)("42"))
 * // Output: 42
 *
 * Schema.decodeUnknownSync(NumberFromString)("not a number")
 * // throws SchemaError: NumberFromString
 * //   └─ Encoded side transformation failure
 * //      └─ NumberFromString
 * //         └─ Expected a numeric string, actual "not a number"
 * ```
 *
 * @category decoding
 * @since 4.0.0
 */
export const decodeUnknownSync = Parser.decodeUnknownSync

/**
 * Decodes a typed input (the schema's `Encoded` type) against a schema
 * synchronously, returning the decoded value or throwing an `Error` whose cause
 * contains the schema issue.
 *
 * **When to use**
 *
 * Use when typed input should be decoded synchronously and schema mismatches
 * should throw.
 *
 * **Details**
 *
 * For `unknown` input use `decodeUnknownSync`.
 * Only service-free schemas can be decoded synchronously. Options may be
 * provided either when creating the decoder or when applying it; application
 * options override creation options.
 *
 * @category decoding
 * @since 4.0.0
 */
export const decodeSync = Parser.decodeSync

/**
 * Encodes an `unknown` input against a schema, returning an `Effect` that
 * succeeds with the encoded value or fails with a {@link SchemaError}.
 *
 * **When to use**
 *
 * Use when encoding input whose type is not statically known.
 *
 * **Details**
 *
 * Prefer {@link encodeEffect} when the input is already typed as the schema's
 * `Type`.
 * Options may be provided either when creating the encoder or when applying it;
 * application options override creation options.
 *
 * **Example** (Encoding a value to a string)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 *
 * const NumberFromString = Schema.NumberFromString
 *
 * Effect.runPromise(Schema.encodeUnknownEffect(NumberFromString)(42)).then(console.log)
 * // Output: "42"
 * ```
 *
 * @category encoding
 * @since 4.0.0
 */
export function encodeUnknownEffect<S extends Top>(schema: S, options?: AST.ParseOptions) {
  const parser = Parser.encodeUnknownEffect(schema, options)
  return (
    input: unknown,
    options?: AST.ParseOptions
  ): Effect.Effect<S["Encoded"], SchemaError, S["EncodingServices"]> => {
    return Effect.mapErrorEager(parser(input, options), (issue) => new SchemaError(issue))
  }
}

/**
 * Encodes a typed input (the schema's `Type`) against a schema, returning an
 * `Effect` that succeeds with the encoded value or fails with a
 * {@link SchemaError}.
 *
 * **When to use**
 *
 * Use when the input is already typed as the schema's `Type`.
 *
 * **Details**
 *
 * For `unknown` input use {@link encodeUnknownEffect}.
 * Options may be provided either when creating the encoder or when applying it;
 * application options override creation options.
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodeEffect: <S extends Top>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => Effect.Effect<S["Encoded"], SchemaError, S["EncodingServices"]> =
  encodeUnknownEffect

/**
 * Encodes an `unknown` input against a schema synchronously, returning an
 * `Exit` that is either a `Success` with the encoded value or a `Failure` with
 * a {@link SchemaError}.
 *
 * **When to use**
 *
 * Use when the input type is not statically known and encoding should return an
 * `Exit` instead of failing or throwing.
 *
 * **Details**
 *
 * Only usable with schemas that have no `EncodingServices` requirement. Prefer
 * {@link encodeExit} when the input is already typed as the schema's `Type`.
 * Options may be provided either when creating the encoder or when applying it;
 * application options override creation options.
 *
 * @category encoding
 * @since 4.0.0
 */
export function encodeUnknownExit<S extends Encoder<unknown>>(schema: S, options?: AST.ParseOptions) {
  const parser = Parser.encodeUnknownExit(schema, options)
  return (input: unknown, options?: AST.ParseOptions): Exit_.Exit<S["Encoded"], SchemaError> => {
    return Exit_.mapError(parser(input, options), (issue) => new SchemaError(issue))
  }
}

/**
 * Encodes a typed input (the schema's `Type`) against a schema synchronously,
 * returning an `Exit` that is either a `Success` with the encoded value or a
 * `Failure` with a {@link SchemaError}.
 *
 * **When to use**
 *
 * Use when typed input should be encoded into an `Exit` instead of failing or
 * throwing.
 *
 * **Details**
 *
 * Only usable with schemas that have no `EncodingServices` requirement. For
 * `unknown` input use {@link encodeUnknownExit}.
 * Options may be provided either when creating the encoder or when applying it;
 * application options override creation options.
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodeExit: <S extends Encoder<unknown>>(
  schema: S,
  options?: AST.ParseOptions
) => (input: S["Type"], options?: AST.ParseOptions) => Exit_.Exit<S["Encoded"], SchemaError> = encodeUnknownExit

/**
 * Encodes an `unknown` input against a schema, returning an `Option` that is
 * `Some` with the encoded value on success or `None` on failure.
 *
 * **When to use**
 *
 * Use when the input type is not statically known and you only need to know
 * whether encoding succeeded.
 *
 * **Details**
 *
 * Prefer this over {@link encodeUnknownExit} or {@link encodeUnknownEffect}
 * when you don't need error details. For typed input use {@link encodeOption}.
 * Options may be provided either when creating the encoder or when applying it;
 * application options override creation options.
 *
 * @category encoding
 * @since 3.10.0
 */
export const encodeUnknownOption = Parser.encodeUnknownOption

/**
 * Encodes a typed input (the schema's `Type`) against a schema, returning an
 * `Option` that is `Some` with the encoded value on success or `None` on
 * failure.
 *
 * **When to use**
 *
 * Use when typed input should be encoded and only success or failure matters.
 *
 * **Details**
 *
 * For `unknown` input use {@link encodeUnknownOption}.
 * Options may be provided either when creating the encoder or when applying it;
 * application options override creation options.
 *
 * @category encoding
 * @since 3.10.0
 */
export const encodeOption = Parser.encodeOption

/**
 * Encodes an `unknown` input against a schema, returning a `Result` that
 * succeeds with the encoded value or fails with a schema issue.
 *
 * **When to use**
 *
 * Use when the input type is not statically known and encoding should return a
 * `Result` with structured issue data.
 *
 * **Details**
 *
 * For typed input use {@link encodeResult}.
 * Options may be provided either when creating the encoder or when applying it;
 * application options override creation options.
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodeUnknownResult = Parser.encodeUnknownResult

/**
 * Encodes a typed input (the schema's `Type`) against a schema, returning a
 * `Result` that succeeds with the encoded value or fails with a schema issue.
 *
 * **When to use**
 *
 * Use when typed input should be encoded into a `Result` with structured issue
 * data.
 *
 * **Details**
 *
 * For `unknown` input use {@link encodeUnknownResult}.
 * Options may be provided either when creating the encoder or when applying it;
 * application options override creation options.
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodeResult = Parser.encodeResult

/**
 * Encodes an `unknown` input against a schema, returning a `Promise` that
 * resolves with the encoded value or rejects with a schema issue.
 *
 * **When to use**
 *
 * Use when integrating unknown input serialization with Promise-based APIs.
 *
 * **Details**
 *
 * For typed input use {@link encodePromise}.
 * Options may be provided either when creating the encoder or when applying it;
 * application options override creation options.
 *
 * @category encoding
 * @since 3.10.0
 */
export const encodeUnknownPromise = Parser.encodeUnknownPromise

/**
 * Encodes a typed input (the schema's `Type`) against a schema, returning a
 * `Promise` that resolves with the encoded value or rejects with a
 * {@link SchemaError}.
 *
 * **When to use**
 *
 * Use when integrating typed input serialization with Promise-based APIs.
 *
 * **Details**
 *
 * For `unknown` input use {@link encodeUnknownPromise}.
 * Options may be provided either when creating the encoder or when applying it;
 * application options override creation options.
 *
 * @category encoding
 * @since 3.10.0
 */
export const encodePromise = Parser.encodePromise

/**
 * Encodes an `unknown` input against a schema synchronously, throwing a
 * {@link SchemaError} on failure.
 *
 * **When to use**
 *
 * Use when serializing unknown data at a boundary and treating schema
 * mismatches as unrecoverable errors.
 *
 * **Details**
 *
 * For non-throwing alternatives see {@link encodeUnknownOption},
 * {@link encodeUnknownExit}, or {@link encodeUnknownEffect}. For typed input
 * use {@link encodeSync}.
 * Options may be provided either when creating the encoder or when applying it;
 * application options override creation options.
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodeUnknownSync = Parser.encodeUnknownSync

/**
 * Encodes a typed input (the schema's `Type`) against a schema synchronously,
 * throwing a {@link SchemaError} on failure.
 *
 * **When to use**
 *
 * Use when typed input should be encoded synchronously and schema mismatches
 * should throw.
 *
 * **Details**
 *
 * For `unknown` input use {@link encodeUnknownSync}.
 * Options may be provided either when creating the encoder or when applying it;
 * application options override creation options.
 *
 * @category encoding
 * @since 4.0.0
 */
export const encodeSync = Parser.encodeSync

/**
 * Creates a schema from an AST (Abstract Syntax Tree) node.
 *
 * **Details**
 *
 * This is the fundamental constructor for all schemas in the Effect Schema
 * library. It takes an AST node and wraps it in a fully-typed schema that
 * preserves all type information and provides the complete schema API.
 *
 * The `make` function is used internally to create all primitive schemas like
 * `String`, `Number`, `Boolean`, etc., as well as more complex schemas. It's
 * the bridge between the untyped AST representation and the strongly-typed
 * schema.
 *
 * @category constructors
 * @since 3.10.0
 */
export const make: <S extends Top>(ast: S["ast"], options?: object) => S = InternalSchema.make

/**
 * Transforms a schema into a class that can be extended with `extends`. The
 * resulting class inherits the full schema API (e.g. `annotate`) and can define
 * static methods that reference `this`.
 *
 * **Example** (Wrapping a primitive schema)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * class MyString extends Schema.asClass(Schema.String) {
 *   static readonly decodeUnknownSync = Schema.decodeUnknownSync(this)
 * }
 *
 * console.log(MyString.decodeUnknownSync("a"))
 * // "a"
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export function asClass<S extends Top>(schema: S): S & { new(_: never): {} } {
  // oxlint-disable-next-line @typescript-eslint/no-extraneous-class
  class Class {}
  return Object.setPrototypeOf(Class, schema)
}

/**
 * Checks whether a value is a `Schema`.
 *
 * @category guards
 * @since 3.10.0
 */
export function isSchema(u: unknown): u is Top {
  return Predicate.hasProperty(u, TypeId) && u[TypeId] === TypeId
}

/**
 * Companion type for an exact optional struct key. The key may be absent, but
 * when present must match the wrapped schema (no implicit `undefined`).
 * Produced by {@link optionalKey}.
 *
 * @category models
 * @since 4.0.0
 */
export interface optionalKey<S extends Top> extends
  Bottom<
    S["Type"],
    S["Encoded"],
    S["DecodingServices"],
    S["EncodingServices"],
    S["ast"],
    optionalKey<S>,
    S["~type.make.in"],
    S["Iso"],
    S["~type.parameters"],
    S["~type.make"],
    S["~type.mutability"],
    "optional",
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    "optional"
  >
{
  readonly schema: S
}

interface optionalKeyLambda extends Lambda {
  <S extends Top>(self: S): optionalKey<S>
  readonly "~lambda.out": this["~lambda.in"] extends Top ? optionalKey<this["~lambda.in"]> : never
}

/**
 * Creates an exact optional key schema for struct fields. Unlike `optional`,
 * this creates exact optional properties (not `| undefined`) that can be
 * completely omitted from the object.
 *
 * **Example** (Creating a struct with optional key)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.Struct({
 *   name: Schema.String,
 *   age: Schema.optionalKey(Schema.Number)
 * })
 *
 * // Type: { readonly name: string; readonly age?: number }
 * type Person = typeof schema["Type"]
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export const optionalKey = Struct_.lambda<optionalKeyLambda>((schema) => make(AST.optionalKey(schema.ast), { schema }))

interface requiredKeyLambda extends Lambda {
  <S extends Top>(self: optionalKey<S>): S
  readonly "~lambda.out": this["~lambda.in"] extends optionalKey<Top> ? this["~lambda.in"]["schema"]
    : "Error: schema not eligible for requiredKey"
}

/**
 * Reverses `optionalKey` and returns the inner required schema.
 *
 * **When to use**
 *
 * Use to remove optional-key wrapping from a schema field that was previously
 * wrapped with {@link optionalKey}.
 *
 * @category combinators
 * @since 4.0.0
 */
export const requiredKey = Struct_.lambda<requiredKeyLambda>((self) => self.schema)

/**
 * Companion type for an optional struct key that also accepts `undefined`.
 * Equivalent to `optionalKey<UndefinedOr<S>>`. Produced by {@link optional}.
 *
 * @category models
 * @since 3.10.0
 */
export interface optional<S extends Top> extends optionalKey<UndefinedOr<S>> {
  readonly "Rebuild": optional<S>
}

interface optionalLambda extends Lambda {
  <S extends Top>(self: S): optional<S>
  readonly "~lambda.out": this["~lambda.in"] extends Top ? optional<this["~lambda.in"]> : never
}

/**
 * Marks a struct field as optional, allowing the key to be absent or
 * `undefined`.
 *
 * **Details**
 *
 * The resulting property may be absent or explicitly set to `undefined`.
 * Equivalent to `optionalKey(UndefinedOr(S))`.
 *
 * Use {@link optionalKey} instead if you want exact optional semantics (absent
 * only, not `undefined`).
 *
 * **Example** (Optional field accepting undefined)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.Struct({
 *   name: Schema.String,
 *   age: Schema.optional(Schema.Number)
 * })
 *
 * // { readonly name: string; readonly age?: number | undefined }
 * type Person = typeof schema.Type
 * ```
 *
 * @category combinators
 * @since 3.10.0
 */
export const optional = Struct_.lambda<optionalLambda>((self) => optionalKey(UndefinedOr(self)))

interface requiredLambda extends Lambda {
  <S extends Top>(self: optional<S>): S
  readonly "~lambda.out": this["~lambda.in"] extends optional<Top> ? this["~lambda.in"]["schema"]["members"][0]
    : "Error: schema not eligible for required"
}

/**
 * Reverses `optional` and returns the inner schema.
 *
 * **When to use**
 *
 * Use to remove optional wrapping from a schema field that was previously
 * wrapped with {@link optional}.
 *
 * **Details**
 *
 * This also unwraps the `UndefinedOr` member added by `optional`.
 *
 * @category combinators
 * @since 3.10.0
 */
export const required = Struct_.lambda<requiredLambda>((self) => self.schema.members[0])

/**
 * Companion type for a mutable struct key. The key's property is writable.
 * Produced by {@link mutableKey}.
 *
 * @category models
 * @since 4.0.0
 */
export interface mutableKey<S extends Top> extends
  Bottom<
    S["Type"],
    S["Encoded"],
    S["DecodingServices"],
    S["EncodingServices"],
    S["ast"],
    mutableKey<S>,
    S["~type.make.in"],
    S["Iso"],
    S["~type.parameters"],
    S["~type.make"],
    "mutable",
    S["~type.optionality"],
    S["~type.constructor.default"],
    "mutable",
    S["~encoded.optionality"]
  >
{
  readonly schema: S
}

interface mutableKeyLambda extends Lambda {
  <S extends Top>(self: S): mutableKey<S>
  readonly "~lambda.out": this["~lambda.in"] extends Top ? mutableKey<this["~lambda.in"]> : never
}

/**
 * Makes a struct field mutable (removes the `readonly` modifier on the property).
 * Use {@link readonlyKey} to reverse.
 *
 * @category combinators
 * @since 4.0.0
 */
export const mutableKey = Struct_.lambda<mutableKeyLambda>((schema) => make(AST.mutableKey(schema.ast), { schema }))

interface readonlyKeyLambda extends Lambda {
  <S extends Top>(self: mutableKey<S>): S
  readonly "~lambda.out": this["~lambda.in"] extends mutableKey<Top> ? this["~lambda.in"]["schema"]
    : "Error: schema not eligible for readonlyKey"
}

/**
 * Reverses `mutableKey` and returns the inner readonly schema.
 *
 * **When to use**
 *
 * Use to remove mutable-key wrapping from a schema field that was previously
 * wrapped with {@link mutableKey}.
 *
 * @category combinators
 * @since 4.0.0
 */
export const readonlyKey = Struct_.lambda<readonlyKeyLambda>((self) => self.schema)

/**
 * Schema type that collapses a transformation schema to its decoded `Type` on
 * both sides (Type = Encoded = S["Type"]). Produced by {@link toType}.
 *
 * @category transforming
 * @since 4.0.0
 */
export interface toType<S extends Top> extends
  Bottom<
    S["Type"],
    S["Type"],
    never,
    never,
    S["ast"],
    toType<S>,
    S["~type.make.in"],
    S["Iso"],
    S["~type.parameters"],
    S["~type.make"],
    S["~type.mutability"],
    S["~type.optionality"],
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{}

interface toTypeLambda extends Lambda {
  <S extends Top>(self: S): toType<S>
  readonly "~lambda.out": this["~lambda.in"] extends Top ? toType<this["~lambda.in"]> : never
}

/**
 * Extracts the type-side schema: sets `Encoded` to equal the decoded `Type`,
 * discarding the encoding transformation path.
 *
 * @category transforming
 * @since 4.0.0
 */
export const toType = Struct_.lambda<toTypeLambda>((schema) => make(AST.toType(schema.ast), { schema }))

/**
 * Schema type that collapses a transformation schema to its `Encoded` side on
 * both sides (Type = Encoded = S["Encoded"]). Produced by {@link toEncoded}.
 *
 * @category transforming
 * @since 4.0.0
 */
export interface toEncoded<S extends Top> extends
  Bottom<
    S["Encoded"],
    S["Encoded"],
    never,
    never,
    AST.AST,
    toEncoded<S>,
    S["Encoded"],
    S["Encoded"],
    ReadonlyArray<Top>,
    S["Encoded"],
    S["~type.mutability"],
    S["~type.optionality"],
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{}

interface toEncodedLambda extends Lambda {
  <S extends Top>(self: S): toEncoded<S>
  readonly "~lambda.out": this["~lambda.in"] extends Top ? toEncoded<this["~lambda.in"]> : never
}

/**
 * Extracts the encoded-side schema: sets `Type` to equal the `Encoded`,
 * discarding the decoding transformation path.
 *
 * @category transforming
 * @since 4.0.0
 */
export const toEncoded = Struct_.lambda<toEncodedLambda>((schema) => make(AST.toEncoded(schema.ast), { schema }))

const FlipTypeId = "~effect/Schema/flip"

/**
 * Schema type representing a flipped schema where `Type` and `Encoded` are
 * swapped. Produced by {@link flip}.
 *
 * @category transforming
 * @since 4.0.0
 */
export interface flip<S extends Top> extends
  Bottom<
    S["Encoded"],
    S["Type"],
    S["EncodingServices"],
    S["DecodingServices"],
    AST.AST,
    flip<S>,
    S["Encoded"],
    S["Encoded"],
    ReadonlyArray<Top>,
    S["Encoded"],
    S["~encoded.mutability"],
    S["~encoded.optionality"],
    ConstructorDefault,
    S["~type.mutability"],
    S["~type.optionality"]
  >
{
  readonly [FlipTypeId]: typeof FlipTypeId
  readonly schema: S
}

function isFlip$(schema: Top): schema is flip<any> {
  return Predicate.hasProperty(schema, FlipTypeId) && schema[FlipTypeId] === FlipTypeId
}

/**
 * Swaps the decoded and encoded sides of a schema.
 *
 * **When to use**
 *
 * Use to invert a schema transformation direction.
 *
 * **Details**
 *
 * Calling `flip` twice returns the original schema.
 *
 * **Example** (Flip a number-from-string schema)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * // NumberFromString: decodes string → number
 * const flipped = Schema.flip(Schema.NumberFromString)
 * // flipped: decodes number → string
 * ```
 *
 * @category transforming
 * @since 4.0.0
 */
export function flip<S extends Top>(schema: S): S extends flip<infer F> ? F["Rebuild"] : flip<S>
export function flip<S extends Top>(schema: S): flip<S> {
  if (isFlip$(schema)) {
    return schema.schema.rebuild(AST.flip(schema.ast))
  }
  return make(AST.flip(schema.ast), { [FlipTypeId]: FlipTypeId, schema })
}

/**
 * Represents a schema for a single literal value.
 *
 * @see {@link Literal} for the constructor function.
 * @category models
 * @since 3.10.0
 */
export interface Literal<L extends AST.LiteralValue> extends Bottom<L, L, never, never, AST.Literal, Literal<L>> {
  readonly literal: L
  transform<L2 extends AST.LiteralValue>(to: L2): decodeTo<Literal<L2>, Literal<L>>
}

/**
 * Creates a schema for a single literal value (string, number, bigint, boolean, or null).
 *
 * **Example** (String literal)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.Literal("hello")
 * // Type: Schema.Literal<"hello">
 * ```
 *
 * @see {@link Literals} for a schema that represents a union of literals.
 * @see {@link tag} for a schema that represents a literal value that can be
 * used as a discriminator field in tagged unions and has a constructor default.
 * @category constructors
 * @since 3.10.0
 */
export function Literal<L extends AST.LiteralValue>(literal: L): Literal<L> {
  const out = make<Literal<L>>(new AST.Literal(literal), {
    literal,
    transform<L2 extends AST.LiteralValue>(to: L2): decodeTo<Literal<L2>, Literal<L>> {
      return out.pipe(decodeTo(Literal(to), {
        decode: Getter.transform(() => to),
        encode: Getter.transform(() => literal)
      }))
    }
  })
  return out
}

/**
 * Namespace for {@link TemplateLiteral} helper types.
 *
 * @since 3.10.0
 */
export declare namespace TemplateLiteral {
  /**
   * Constraint for schema parts that can appear inside a `TemplateLiteral`.
   *
   * **Details**
   *
   * The schema's encoded value must be a `string`, `number`, or `bigint` so it can
   * be converted into a template literal string segment.
   *
   * @category utility types
   * @since 4.0.0
   */
  export interface SchemaPart extends Top {
    readonly Encoded: string | number | bigint
  }

  /**
   * Literal value that can be used directly as a part of a `TemplateLiteral`.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type LiteralPart = string | number | bigint

  /**
   * A single part of a `TemplateLiteral`, either an interpolated schema part or a
   * literal `string`, `number`, or `bigint`.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Part = SchemaPart | LiteralPart

  /**
   * Ordered list of parts used to construct a `TemplateLiteral` schema.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Parts = ReadonlyArray<Part>

  type AppendType<
    Template extends string,
    Next
  > = Next extends LiteralPart ? `${Template}${Next}`
    : Next extends Codec<unknown, infer E extends LiteralPart, unknown, unknown> ? `${Template}${E}`
    : never

  /**
   * Computes the encoded string literal type produced by concatenating the encoded
   * forms of all template literal parts.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Encoded<Parts> = Parts extends readonly [...infer Init, infer Last] ? AppendType<Encoded<Init>, Last>
    : ``
}

/**
 * Represents a schema that validates strings matching a template literal pattern.
 * The encoded type is a string formed by concatenating the parts.
 *
 * @see {@link TemplateLiteral} for the constructor function.
 * @category models
 * @since 3.10.0
 */
export interface TemplateLiteral<Parts extends TemplateLiteral.Parts> extends
  Bottom<
    TemplateLiteral.Encoded<Parts>,
    TemplateLiteral.Encoded<Parts>,
    never,
    never,
    AST.TemplateLiteral,
    TemplateLiteral<Parts>
  >
{
  readonly parts: Parts
}

function templateLiteralFromParts<Parts extends TemplateLiteral.Parts>(parts: Parts) {
  return new AST.TemplateLiteral(parts.map((part) => isSchema(part) ? part.ast : new AST.Literal(part)))
}

/**
 * Creates a schema that validates strings matching a template literal pattern. Each part can be
 * a literal string/number/bigint or a schema whose encoded type is a string, number, or bigint.
 *
 * **Example** (URL path pattern)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.TemplateLiteral(["/user/", Schema.Number])
 * // matches strings like "/user/123", "/user/42", etc.
 * ```
 *
 * @see {@link TemplateLiteralParser} for a schema that also parses matched parts into a tuple.
 * @category constructors
 * @since 3.10.0
 */
export function TemplateLiteral<const Parts extends TemplateLiteral.Parts>(parts: Parts): TemplateLiteral<Parts> {
  return make(templateLiteralFromParts(parts), { parts })
}

/**
 * Namespace for {@link TemplateLiteralParser} helper types.
 *
 * @since 3.10.0
 */
export declare namespace TemplateLiteralParser {
  /**
   * Computes the decoded tuple type produced by `TemplateLiteralParser`.
   *
   * **Details**
   *
   * Literal parts contribute their literal value to the tuple. Schema parts
   * contribute their decoded `Type`.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Type<Parts> = Parts extends readonly [infer Head, ...infer Tail] ? readonly [
      Head extends TemplateLiteral.LiteralPart ? Head :
        Head extends Codec<infer T, unknown, unknown, unknown> ? T
        : never,
      ...Type<Tail>
    ]
    : []
}

/**
 * Represents a schema that validates strings matching a template literal pattern and decodes
 * them into a tuple of typed values, one per schema part.
 *
 * @see {@link TemplateLiteralParser} for the constructor function.
 * @category models
 * @since 3.10.0
 */
export interface TemplateLiteralParser<Parts extends TemplateLiteral.Parts> extends
  Bottom<
    TemplateLiteralParser.Type<Parts>,
    TemplateLiteral.Encoded<Parts>,
    never,
    never,
    AST.Arrays,
    TemplateLiteralParser<Parts>
  >
{
  readonly parts: Parts
}

/**
 * Schema for parsing template literal matches into typed tuple parts.
 *
 * **When to use**
 *
 * Use to validate a template literal string and decode the matched parts into
 * typed values.
 *
 * **Details**
 *
 * Unlike {@link TemplateLiteral}, this schema decodes the matched string into a
 * readonly tuple with one element per schema part.
 *
 * **Example** (Parse path parameters)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.TemplateLiteralParser(["/user/", Schema.NumberFromString])
 * // decodes "/user/42" => readonly ["/user/", 42]
 * ```
 *
 * @see {@link TemplateLiteral} for a validation-only version that keeps the string encoded.
 * @category constructors
 * @since 3.10.0
 */
export function TemplateLiteralParser<const Parts extends TemplateLiteral.Parts>(
  parts: Parts
): TemplateLiteralParser<Parts> {
  return make(templateLiteralFromParts(parts).asTemplateLiteralParser(), { parts })
}

/**
 * Represents a schema derived from a TypeScript enum object or an enum-like
 * `as const` object, accepting any of its values.
 *
 * @see {@link Enum} for the constructor function.
 * @category models
 * @since 4.0.0
 */
export interface Enum<A extends { [x: string]: string | number }>
  extends Bottom<A[keyof A], A[keyof A], never, never, AST.Enum, Enum<A>>
{
  readonly enums: A
}

/**
 * Creates a schema from a TypeScript enum object. Validates that the input is one of the enum's values.
 *
 * **Example** (Direction enum)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * enum Direction {
 *   Up = "Up",
 *   Down = "Down"
 * }
 *
 * const schema = Schema.Enum(Direction)
 * // accepts "Up" or "Down"
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export function Enum<A extends { [x: string]: string | number }>(enums: A): Enum<A> {
  return make(
    new AST.Enum(
      Object.keys(enums).filter(
        (key) => typeof enums[enums[key]] !== "number"
      ).map((key) => [key, enums[key]])
    ),
    { enums }
  )
}

/**
 * Schema for the `never` type. Always fails validation.
 *
 * @see {@link Never} for the schema value.
 * @category models
 * @since 3.10.0
 */
export interface Never extends Bottom<never, never, never, never, AST.Never, Never> {}

/**
 * Schema for the `never` type. Always fails validation — no value satisfies it.
 *
 * @category schemas
 * @since 3.10.0
 */
export const Never: Never = make(AST.never)

/**
 * Schema for the `any` type. Accepts any value without validation.
 *
 * @see {@link Any} for the schema value.
 * @category models
 * @since 3.10.0
 */
export interface Any extends Bottom<any, any, never, never, AST.Any, Any> {}

/**
 * Schema for the `any` type. Accepts any value without validation.
 *
 * @see {@link Unknown} for a safer alternative that uses `unknown`.
 * @category schemas
 * @since 3.10.0
 */
export const Any: Any = make(AST.any)

/**
 * Schema for the `unknown` type. Accepts any value without validation.
 *
 * @see {@link Unknown} for the schema value.
 * @category models
 * @since 3.10.0
 */
export interface Unknown extends Bottom<unknown, unknown, never, never, AST.Unknown, Unknown> {}

/**
 * Schema for the `unknown` type. Accepts any value without validation.
 *
 * @see {@link Any} for the `any` variant.
 * @category schemas
 * @since 3.10.0
 */
export const Unknown: Unknown = make(AST.unknown)

/**
 * Schema for the `null` literal. Validates that the input is strictly `null`.
 *
 * @see {@link Null} for the schema value.
 * @category models
 * @since 3.10.0
 */
export interface Null extends Bottom<null, null, never, never, AST.Null, Null> {}

/**
 * Schema for the `null` literal. Validates that the input is strictly `null`.
 *
 * @see {@link NullOr} for a union with another schema.
 * @category schemas
 * @since 3.10.0
 */
export const Null: Null = make(AST.null)

/**
 * Schema for the `undefined` literal. Validates that the input is strictly `undefined`.
 *
 * @see {@link Undefined} for the schema value.
 * @category models
 * @since 3.10.0
 */
export interface Undefined extends Bottom<undefined, undefined, never, never, AST.Undefined, Undefined> {}

/**
 * Schema for the `undefined` literal. Validates that the input is strictly `undefined`.
 *
 * @see {@link UndefinedOr} for a union with another schema.
 * @category schemas
 * @since 3.10.0
 */
export const Undefined: Undefined = make(AST.undefined)

/**
 * Schema for `string` values.
 *
 * @see {@link String} for the schema value.
 * @category models
 * @since 4.0.0
 */
export interface String extends Bottom<string, string, never, never, AST.String, String> {}

/**
 * Schema for `string` values. Validates that the input is `typeof` `"string"`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const String: String = make(AST.string)

/**
 * Schema for `number` values, including `NaN`, `Infinity`, and `-Infinity`.
 *
 * @see {@link Number} for the schema value.
 * @category models
 * @since 4.0.0
 */
export interface Number extends Bottom<number, number, never, never, AST.Number, Number> {}

/**
 * Schema for `number` values, including `NaN`, `Infinity`, and `-Infinity`.
 *
 * **Details**
 *
 * Default JSON serializer:
 *
 * - Finite numbers are serialized as numbers.
 * - Non-finite values are serialized as strings (`"NaN"`, `"Infinity"`, `"-Infinity"`).
 *
 * @see {@link Finite} for a schema that excludes non-finite values.
 * @category schemas
 * @since 4.0.0
 */
export const Number: Number = make(AST.number)

/**
 * Schema for `boolean` values.
 *
 * @see {@link Boolean} for the schema value.
 * @category models
 * @since 4.0.0
 */
export interface Boolean extends Bottom<boolean, boolean, never, never, AST.Boolean, Boolean> {}

/**
 * Schema for `boolean` values. Validates that the input is `typeof` `"boolean"`.
 *
 * **When to use**
 *
 * Use to validate values that are already JavaScript booleans.
 *
 * @see {@link BooleanFromBit} for a schema that decodes bit literals `0` or `1` into a boolean
 *
 * @category Boolean
 * @since 4.0.0
 */
export const Boolean: Boolean = make(AST.boolean)

/**
 * Schema for `symbol` values.
 *
 * @see {@link Symbol} for the schema value.
 * @category models
 * @since 4.0.0
 */
export interface Symbol extends Bottom<symbol, symbol, never, never, AST.Symbol, Symbol> {}

/**
 * Schema for `symbol` values. Validates that the input is `typeof` `"symbol"`.
 *
 * @see {@link UniqueSymbol} for a schema that matches a specific symbol.
 * @category schemas
 * @since 4.0.0
 */
export const Symbol: Symbol = make(AST.symbol)

/**
 * Schema for `bigint` values.
 *
 * @see {@link BigInt} for the schema value.
 * @category models
 * @since 4.0.0
 */
export interface BigInt extends Bottom<bigint, bigint, never, never, AST.BigInt, BigInt> {}

/**
 * Schema for `bigint` values. Validates that the input is `typeof` `"bigint"`.
 *
 * **When to use**
 *
 * Use when the input is already a bigint and the schema should validate and
 * preserve bigint values without parsing from another representation.
 *
 * @see {@link BigIntFromString} for parsing string input into a bigint
 *
 * @category schemas
 * @since 4.0.0
 */
export const BigInt: BigInt = make(AST.bigInt)

/**
 * Schema for the `void` type.
 *
 * @see {@link Void} for the schema value.
 * @category models
 * @since 3.10.0
 */
export interface Void extends Bottom<void, void, never, never, AST.Void, Void> {}

/**
 * Schema for the `void` type. Accepts `undefined` as the encoded value.
 *
 * @category schemas
 * @since 3.10.0
 */
export const Void: Void = make(AST.void)

/**
 * Schema for the `object` type keyword.
 *
 * @see {@link ObjectKeyword} for the schema value.
 * @category models
 * @since 4.0.0
 */
export interface ObjectKeyword extends Bottom<object, object, never, never, AST.ObjectKeyword, ObjectKeyword> {}

/**
 * Schema for the `object` type. Validates that the input is a non-null object or function
 * (i.e. `typeof value === "object" && value !== null || typeof value === "function"`).
 *
 * @category schemas
 * @since 4.0.0
 */
export const ObjectKeyword: ObjectKeyword = make(AST.objectKeyword)

/**
 * Represents a schema for a specific unique symbol.
 *
 * @see {@link UniqueSymbol} for the constructor function.
 * @category models
 * @since 4.0.0
 */
export interface UniqueSymbol<sym extends symbol>
  extends Bottom<sym, sym, never, never, AST.UniqueSymbol, UniqueSymbol<sym>>
{}

/**
 * Creates a schema for a specific symbol. Only that exact symbol satisfies the schema.
 *
 * **Example** (Specific symbol)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const mySymbol = Symbol.for("mySymbol")
 * const schema = Schema.UniqueSymbol(mySymbol)
 * ```
 *
 * @see {@link Symbol} for a schema that accepts any symbol.
 * @category constructors
 * @since 4.0.0
 */
export function UniqueSymbol<const sym extends symbol>(symbol: sym): UniqueSymbol<sym> {
  return make(new AST.UniqueSymbol(symbol))
}

/**
 * Namespace for struct field type utilities.
 *
 * **Details**
 *
 * These types compute the decoded `Type`, encoded `Encoded`, and constructor
 * input `MakeIn` of a {@link Struct} from its field map, handling optional,
 * mutable, and other field modifiers automatically.
 *
 * - `Struct.Fields` — constraint for the field map object
 * - `Struct.Type<F>` — decoded type of the struct
 * - `Struct.Encoded<F>` — encoded type of the struct
 * - `Struct.MakeIn<F>` — constructor input (optional/defaulted fields may be omitted)
 * - `Struct.DecodingServices<F>` / `Struct.EncodingServices<F>` — required services
 *
 * @since 3.10.0
 */
export declare namespace Struct {
  /**
   * Constraint for a struct field map: an object whose values are schemas.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Fields = { readonly [x: PropertyKey]: Top }

  type TypeOptionalKeys<Fields extends Struct.Fields> = {
    [K in keyof Fields]: Fields[K] extends { readonly "~type.optionality": "optional" } ? K
      : never
  }[keyof Fields]

  type TypeMutableKeys<Fields extends Struct.Fields> = {
    [K in keyof Fields]: Fields[K] extends { readonly "~type.mutability": "mutable" } ? K
      : never
  }[keyof Fields]

  type Type_<
    F extends Fields,
    O extends keyof F = TypeOptionalKeys<F>,
    M extends keyof F = TypeMutableKeys<F>
  > =
    & { readonly [K in keyof F as K extends M | O ? never : K]: F[K]["Type"] }
    & { readonly [K in keyof F as K extends O ? K extends M ? never : K : never]?: F[K]["Type"] }
    & { -readonly [K in keyof F as K extends M ? K extends O ? never : K : never]: F[K]["Type"] }
    & { -readonly [K in keyof F as K extends M & O ? K : never]?: F[K]["Type"] }

  /**
   * Computes the decoded object type for a struct field map.
   *
   * **Details**
   *
   * Field schemas contribute their decoded `Type`. `optionalKey` and `optional`
   * produce optional properties, while `mutableKey` produces writable properties.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Type<F extends Fields> = Simplify<Type_<F>>

  type Iso_<
    F extends Fields,
    O extends keyof F = TypeOptionalKeys<F>,
    M extends keyof F = TypeMutableKeys<F>
  > =
    & { readonly [K in keyof F as K extends M | O ? never : K]: F[K]["Iso"] }
    & { readonly [K in keyof F as K extends O ? K extends M ? never : K : never]?: F[K]["Iso"] }
    & { -readonly [K in keyof F as K extends M ? K extends O ? never : K : never]: F[K]["Iso"] }
    & { -readonly [K in keyof F as K extends M & O ? K : never]?: F[K]["Iso"] }

  /**
   * Computes the iso object type for a struct field map from each field schema's
   * `Iso` type.
   *
   * **Details**
   *
   * The resulting property optionality and mutability follow the same field
   * modifiers used by `Struct.Type`.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Iso<F extends Fields> = Simplify<Iso_<F>>

  type EncodedOptionalKeys<Fields extends Struct.Fields> = {
    [K in keyof Fields]: Fields[K] extends { readonly "~encoded.optionality": "optional" } ? K
      : never
  }[keyof Fields]

  type EncodedMutableKeys<Fields extends Struct.Fields> = {
    [K in keyof Fields]: Fields[K] extends { readonly "~encoded.mutability": "mutable" } ? K
      : never
  }[keyof Fields]

  type Encoded_<
    F extends Fields,
    O extends keyof F = EncodedOptionalKeys<F>,
    M extends keyof F = EncodedMutableKeys<F>
  > =
    & { readonly [K in keyof F as K extends M | O ? never : K]: F[K]["Encoded"] }
    & { readonly [K in keyof F as K extends O ? K extends M ? never : K : never]?: F[K]["Encoded"] }
    & { -readonly [K in keyof F as K extends M ? K extends O ? never : K : never]: F[K]["Encoded"] }
    & { -readonly [K in keyof F as K extends M & O ? K : never]?: F[K]["Encoded"] }

  /**
   * Computes the encoded object type for a struct field map.
   *
   * **Details**
   *
   * Field schemas contribute their `Encoded` type. Encoded-side optionality and
   * mutability modifiers determine whether properties are optional or writable in
   * the encoded shape.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Encoded<F extends Fields> = Simplify<Encoded_<F>>

  /**
   * Union of all decoding service requirements needed by the schemas in a struct
   * field map.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type DecodingServices<F extends Fields> = { readonly [K in keyof F]: F[K]["DecodingServices"] }[keyof F]

  /**
   * Union of all encoding service requirements needed by the schemas in a struct
   * field map.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type EncodingServices<F extends Fields> = { readonly [K in keyof F]: F[K]["EncodingServices"] }[keyof F]

  type TypeConstructorDefaultedKeys<Fields extends Struct.Fields> = {
    [K in keyof Fields]: Fields[K] extends { readonly "~type.constructor.default": "with-default" } ? K
      : never
  }[keyof Fields]

  type MakeIn_<
    F extends Fields,
    O = TypeOptionalKeys<F> | TypeConstructorDefaultedKeys<F>
  > =
    & { readonly [K in keyof F as K extends O ? never : K]: F[K]["~type.make"] }
    & { readonly [K in keyof F as K extends O ? K : never]?: F[K]["~type.make"] }

  /**
   * Computes the input object type accepted when constructing a struct value.
   *
   * **Details**
   *
   * Required fields use each field schema's `~type.make` input. Fields marked
   * optional or with a constructor default may be omitted.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type MakeIn<F extends Fields> = Simplify<MakeIn_<F>>
}

/**
 * Schema type returned by `Schema.Struct` for an object with a fixed set of
 * schema-defined fields.
 *
 * **Details**
 *
 * The `fields` property exposes the original field map for reuse, and
 * `mapFields` creates a new struct schema by transforming that field map.
 *
 * @category models
 * @since 3.10.0
 */
export interface Struct<Fields extends Struct.Fields> extends
  Bottom<
    Struct.Type<Fields>,
    Struct.Encoded<Fields>,
    Struct.DecodingServices<Fields>,
    Struct.EncodingServices<Fields>,
    AST.Objects,
    Struct<Fields>,
    Struct.MakeIn<Fields>,
    Struct.Iso<Fields>
  >
{
  /**
   * The field definitions of this struct. Spread them into a new struct to
   * reuse fields across schemas.
   *
   * **Example** (Reusing fields across structs)
   *
   * ```ts
   * import { Schema } from "effect"
   *
   * const Timestamped = Schema.Struct({
   *   createdAt: Schema.Date,
   *   updatedAt: Schema.Date
   * })
   *
   * const User = Schema.Struct({
   *   ...Timestamped.fields,
   *   name: Schema.String,
   *   email: Schema.String
   * })
   * ```
   */
  readonly fields: Fields
  /**
   * Returns a new struct with the fields modified by the provided function.
   *
   * **Details**
   *
   * Options:
   *
   * - `unsafePreserveChecks` - if `true`, keep any `.check(...)` constraints
   *   that were attached to the original union. Defaults to `false`.
   *
   *   **Warning**: This is an unsafe operation. Since `mapFields`
   *   transformations change the schema type, the original refinement functions
   *   may no longer be valid or safe to apply to the transformed schema. Only
   *   use this option if you have verified that your refinements remain correct
   *   after the transformation.
   */
  mapFields<To extends Struct.Fields>(
    f: (fields: Fields) => To,
    options?: {
      readonly unsafePreserveChecks?: boolean | undefined
    } | undefined
  ): Struct<Simplify<Readonly<To>>>
}

function makeStruct<const Fields extends Struct.Fields>(ast: AST.Objects, fields: Fields): Struct<Fields> {
  return make(ast, {
    fields,
    mapFields<To extends Struct.Fields>(
      this: Struct<Fields>,
      f: (fields: Fields) => To,
      options?: {
        readonly unsafePreserveChecks?: boolean | undefined
      } | undefined
    ): Struct<To> {
      const fields = f(this.fields)
      return makeStruct(AST.struct(fields, options?.unsafePreserveChecks ? this.ast.checks : undefined), fields)
    }
  })
}

/**
 * Defines a struct schema from a map of field schemas.
 *
 * **Details**
 *
 * Each field value is a schema. Use {@link optionalKey} or {@link optional} to
 * mark fields as optional, and {@link mutableKey} to mark them as mutable.
 *
 * The resulting schema's `Type` is a readonly object type with the fields'
 * decoded types. The `Encoded` form mirrors the field schemas' encoded types.
 *
 * **Example** (Basic struct)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const Person = Schema.Struct({
 *   name: Schema.String,
 *   age: Schema.Number,
 *   email: Schema.optionalKey(Schema.String)
 * })
 *
 * // { readonly name: string; readonly age: number; readonly email?: string }
 * type Person = typeof Person.Type
 *
 * const alice = Schema.decodeUnknownSync(Person)({ name: "Alice", age: 30 })
 * console.log(alice)
 * // { name: 'Alice', age: 30 }
 * ```
 *
 * @category constructors
 * @since 3.10.0
 */
export function Struct<const Fields extends Struct.Fields>(fields: Fields): Struct<Fields> {
  return makeStruct(AST.struct(fields, undefined), fields)
}

interface fieldsAssign<NewFields extends Struct.Fields> extends Lambda {
  <Fields extends Struct.Fields>(
    struct: Struct<Fields>
  ): Struct<Struct_.Simplify<Struct_.Assign<Fields, NewFields>>>
  readonly "~lambda.out": this["~lambda.in"] extends Struct<Struct.Fields>
    ? Struct<Struct_.Simplify<Struct_.Assign<this["~lambda.in"]["fields"], NewFields>>>
    : "Error: schema not eligible for fieldsAssign"
}

/**
 * Adds fields to a struct schema through a struct-mapping lambda.
 *
 * **When to use**
 *
 * Use to add the same fields to an existing struct or to every struct member of
 * a union.
 *
 * **Details**
 *
 * This is a shortcut for `MyStruct.mapFields(Struct.assign(fields))`.
 *
 * **Example** (Adding fields to a union of structs)
 *
 * ```ts
 * import { Schema, Tuple } from "effect"
 *
 * // Add a new field to all members of a union of structs
 * const schema = Schema.Union([
 *   Schema.Struct({ a: Schema.String }),
 *   Schema.Struct({ b: Schema.Number })
 * ]).mapMembers(Tuple.map(Schema.fieldsAssign({ c: Schema.Number })))
 * ```
 *
 * @category combinators
 * @since 4.0.0
 */
export function fieldsAssign<const NewFields extends Struct.Fields>(fields: NewFields) {
  return Struct_.lambda<fieldsAssign<NewFields>>((struct) => struct.mapFields(Struct_.assign(fields)))
}

/**
 * Schema type for a struct with renamed encoded keys. Produced by
 * {@link encodeKeys}.
 *
 * @category transforming
 * @since 4.0.0
 */
export interface encodeKeys<
  S extends Top & { readonly fields: Struct.Fields },
  M extends { readonly [K in keyof S["fields"]]?: PropertyKey }
> extends
  decodeTo<
    S,
    Struct<
      {
        [
          K in keyof S["fields"] as K extends keyof M ? M[K] extends PropertyKey ? M[K] : K : K
        ]: toEncoded<S["fields"][K]>
      }
    >
  >
{}

/**
 * Renames struct keys in the encoded form without changing the decoded type.
 *
 * **Details**
 *
 * Takes a partial mapping `{ decodedKey: encodedKey }` and produces a
 * transformation schema that decodes from the renamed keys and encodes back to
 * the renamed keys. Keys not present in the mapping are left unchanged.
 *
 * **Example** (Rename `name` to `full_name` in the encoded form)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const Person = Schema.Struct({ name: Schema.String, age: Schema.Number })
 * const Encoded = Person.pipe(Schema.encodeKeys({ name: "full_name" }))
 *
 * // Decodes { full_name: "Alice", age: 30 } → { name: "Alice", age: 30 }
 * const alice = Schema.decodeUnknownSync(Encoded)({ full_name: "Alice", age: 30 })
 * console.log(alice)
 * // { name: 'Alice', age: 30 }
 * ```
 *
 * @category transforming
 * @since 4.0.0
 */
export function encodeKeys<
  S extends Top & { readonly fields: Struct.Fields },
  const M extends { readonly [K in keyof S["fields"]]?: PropertyKey }
>(mapping: M) {
  return function(self: S): encodeKeys<S, M> {
    const fields: any = {}
    const reverseMapping: any = {}
    for (const k in self.fields) {
      const encoded = toEncoded(self.fields[k])
      if (Object.hasOwn(mapping, k)) {
        fields[mapping[k]!] = encoded
        reverseMapping[mapping[k]!] = k
      } else {
        fields[k] = encoded
      }
    }
    return Struct(fields).pipe(decodeTo(
      self,
      Transformation.transform<any, any>({
        decode: Struct_.renameKeys(reverseMapping),
        encode: Struct_.renameKeys(mapping)
      })
    )) as any
  }
}

/**
 * Adds derived fields to a struct schema during decoding.
 *
 * **Details**
 *
 * Each new field is derived from the decoded struct value via a function that
 * returns `Option`. On encoding the derived fields are stripped. This allows
 * computed or enriched fields to live in the decoded type without appearing in
 * the encoded form.
 *
 * **Example** (Add a computed `fullName` field)
 *
 * ```ts
 * import { Option, Schema } from "effect"
 *
 * const Person = Schema.Struct({ first: Schema.String, last: Schema.String })
 * const Extended = Person.pipe(
 *   Schema.extendTo(
 *     { fullName: Schema.String },
 *     { fullName: (p) => Option.some(`${p.first} ${p.last}`) }
 *   )
 * )
 *
 * const alice = Schema.decodeUnknownSync(Extended)({ first: "Alice", last: "Smith" })
 * console.log(alice.fullName)
 * // Alice Smith
 * ```
 *
 * @category transforming
 * @since 4.0.0
 */
export function extendTo<S extends Struct<Struct.Fields>, const Fields extends Struct.Fields>(
  /** The new fields to add */
  fields: Fields,
  /** A function per field to derive its value from the original input */
  derive: { readonly [K in keyof Fields]: (s: S["Type"]) => Option_.Option<Fields[K]["Type"]> }
) {
  return (
    self: S
  ): decodeTo<Struct<Simplify<{ [K in keyof S["fields"]]: toType<S["fields"][K]> } & Fields>>, S> => {
    const f = Record_.map(self.fields, toType)
    const to = Struct({ ...f, ...fields })
    return self.pipe(decodeTo(
      to,
      Transformation.transform({
        decode: (input) => {
          const out: any = { ...input }
          for (const k in fields) {
            const f = derive[k]
            const o = f(input)
            if (Option_.isSome(o)) {
              out[k] = o.value
            }
          }
          return out
        },
        encode: (input) => {
          const out = { ...input }
          for (const k in fields) {
            delete out[k]
          }
          return out
        }
      })
    )) as any
  }
}

/**
 * Namespace for `Record` type utilities.
 *
 * **Details**
 *
 * - `Record.Key` — constraint for the key schema (must encode to `PropertyKey`)
 * - `Record.Type<K, V>` — decoded type of the record
 * - `Record.Encoded<K, V>` — encoded type of the record
 *
 * @since 3.10.0
 */
export declare namespace Record {
  /**
   * Constraint for schemas that can be used as record keys.
   *
   * **Details**
   *
   * The key schema must decode and encode property keys (`string`, `number`, or
   * `symbol`) so it can describe object property names.
   *
   * @category utility types
   * @since 4.0.0
   */
  export interface Key extends Codec<PropertyKey, PropertyKey, unknown, unknown> {
    readonly "~type.make": PropertyKey
    readonly "Iso": PropertyKey
  }

  /**
   * Computes the decoded object type for a record schema from its key and value
   * schemas.
   *
   * **Details**
   *
   * The key schema supplies the property keys and the value schema supplies each
   * property's decoded `Type`. Optional and mutable value schemas affect the
   * resulting property optionality and writability.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Type<Key extends Record.Key, Value extends Top> = Value extends
    { readonly "~type.optionality": "optional" } ?
    Value extends { readonly "~type.mutability": "mutable" } ? { [P in Key["Type"]]?: Value["Type"] }
    : { readonly [P in Key["Type"]]?: Value["Type"] }
    : Value extends { readonly "~type.mutability": "mutable" } ? { [P in Key["Type"]]: Value["Type"] }
    : { readonly [P in Key["Type"]]: Value["Type"] }

  /**
   * Computes the iso object type for a record schema from the key schema's `Iso`
   * keys and the value schema's `Iso` values.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Iso<Key extends Record.Key, Value extends Top> = Value extends
    { readonly "~type.optionality": "optional" } ?
    Value extends { readonly "~type.mutability": "mutable" } ? { [P in Key["Iso"]]?: Value["Iso"] }
    : { readonly [P in Key["Iso"]]?: Value["Iso"] }
    : Value extends { readonly "~type.mutability": "mutable" } ? { [P in Key["Iso"]]: Value["Iso"] }
    : { readonly [P in Key["Iso"]]: Value["Iso"] }

  /**
   * Computes the encoded object type for a record schema from the key and value
   * schemas' encoded types.
   *
   * **Details**
   *
   * Encoded-side optionality and mutability on the value schema determine whether
   * the encoded record properties are optional or writable.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Encoded<Key extends Record.Key, Value extends Top> = Value extends
    { readonly "~encoded.optionality": "optional" } ?
    Value extends { readonly "~encoded.mutability": "mutable" } ? { [P in Key["Encoded"]]?: Value["Encoded"] }
    : { readonly [P in Key["Encoded"]]?: Value["Encoded"] }
    : Value extends { readonly "~encoded.mutability": "mutable" } ? { [P in Key["Encoded"]]: Value["Encoded"] }
    : { readonly [P in Key["Encoded"]]: Value["Encoded"] }

  /**
   * Union of the decoding service requirements of a record's key schema and value
   * schema.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type DecodingServices<Key extends Record.Key, Value extends Top> =
    | Key["DecodingServices"]
    | Value["DecodingServices"]

  /**
   * Union of the encoding service requirements of a record's key schema and value
   * schema.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type EncodingServices<Key extends Record.Key, Value extends Top> =
    | Key["EncodingServices"]
    | Value["EncodingServices"]

  /**
   * Computes the input object type accepted when constructing a record value.
   *
   * **Details**
   *
   * Keys use the key schema's `~type.make` type and values use the value schema's
   * `~type.make` type. Value optionality and mutability determine whether
   * properties are optional or writable.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type MakeIn<Key extends Record.Key, Value extends Top> = Value extends
    { readonly "~encoded.optionality": "optional" } ?
    Value extends { readonly "~encoded.mutability": "mutable" } ? { [P in Key["~type.make"]]?: Value["~type.make"] }
    : { readonly [P in Key["~type.make"]]?: Value["~type.make"] }
    : Value extends { readonly "~encoded.mutability": "mutable" } ? { [P in Key["~type.make"]]: Value["~type.make"] }
    : { readonly [P in Key["~type.make"]]: Value["~type.make"] }
}

/**
 * Companion type for a key-value record (map) with a typed key and value schema.
 * Produced by {@link Record}.
 *
 * **When to use**
 *
 * Use as the concrete schema type returned by `Record` when an API needs to
 * accept or return a record schema with typed property keys and values.
 *
 * @see {@link Record} for constructing record schemas
 * @see {@link StructWithRest} for combining fixed struct fields with record index signatures
 *
 * @category models
 * @since 4.0.0
 */
export interface $Record<Key extends Record.Key, Value extends Top> extends
  Bottom<
    Record.Type<Key, Value>,
    Record.Encoded<Key, Value>,
    Record.DecodingServices<Key, Value>,
    Record.EncodingServices<Key, Value>,
    AST.Objects,
    $Record<Key, Value>,
    Simplify<Record.MakeIn<Key, Value>>,
    Record.Iso<Key, Value>
  >
{
  readonly key: Key
  readonly value: Value
}

/**
 * Defines a record (dictionary) schema with typed keys and values.
 *
 * **Example** (String-keyed record of numbers)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.Record(Schema.String, Schema.Number)
 *
 * // { readonly [x: string]: number }
 * type R = typeof schema.Type
 *
 * const result = Schema.decodeUnknownSync(schema)({ a: 1, b: 2 })
 * console.log(result)
 * // { a: 1, b: 2 }
 * ```
 *
 * @category constructors
 * @since 3.10.0
 */
export function Record<Key extends Record.Key, Value extends Top>(
  key: Key,
  value: Value,
  options?: {
    readonly keyValueCombiner: {
      readonly decode?: Combiner.Combiner<readonly [Key["Type"], Value["Type"]]> | undefined
      readonly encode?: Combiner.Combiner<readonly [Key["Encoded"], Value["Encoded"]]> | undefined
    }
  }
): $Record<Key, Value> {
  const keyValueCombiner = options?.keyValueCombiner?.decode || options?.keyValueCombiner?.encode
    ? new AST.KeyValueCombiner(options.keyValueCombiner.decode, options.keyValueCombiner.encode)
    : undefined
  return make(AST.record(key.ast, value.ast, keyValueCombiner), { key, value })
}

/**
 * Namespace for `StructWithRest` type utilities.
 *
 * **Details**
 *
 * - `StructWithRest.Type<S, R>` — decoded type (struct type intersected with record types)
 * - `StructWithRest.Encoded<S, R>` — encoded type
 *
 * @since 4.0.0
 */
export declare namespace StructWithRest {
  /**
   * Constraint for object-like schemas that can be used as the fixed portion of a
   * `StructWithRest` schema.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Objects = Top & { readonly ast: AST.Objects }

  /**
   * Readonly list of record schemas that provide the additional index signatures
   * for a `StructWithRest` schema.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Records = ReadonlyArray<$Record<Record.Key, Top>>

  type MergeTuple<T extends ReadonlyArray<unknown>> = T extends readonly [infer Head, ...infer Tail] ?
    Head & MergeTuple<Tail>
    : {}

  /**
   * Computes the decoded type for `StructWithRest` by intersecting the base object
   * schema's decoded `Type` with the decoded types of all rest record schemas.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Type<S extends Objects, Records extends StructWithRest.Records> =
    & S["Type"]
    & MergeTuple<{ readonly [K in keyof Records]: Records[K]["Type"] }>

  /**
   * Computes the iso type for `StructWithRest` by intersecting the base object
   * schema's `Iso` type with the `Iso` types of all rest record schemas.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Iso<S extends Objects, Records extends StructWithRest.Records> =
    & S["Iso"]
    & MergeTuple<{ readonly [K in keyof Records]: Records[K]["Iso"] }>

  /**
   * Computes the encoded type for `StructWithRest` by intersecting the base object
   * schema's encoded type with the encoded types of all rest record schemas.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Encoded<S extends Objects, Records extends StructWithRest.Records> =
    & S["Encoded"]
    & MergeTuple<{ readonly [K in keyof Records]: Records[K]["Encoded"] }>

  /**
   * Union of the decoding service requirements of the base object schema and all
   * rest record schemas.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type DecodingServices<S extends Objects, Records extends StructWithRest.Records> =
    | S["DecodingServices"]
    | { [K in keyof Records]: Records[K]["DecodingServices"] }[number]

  /**
   * Union of the encoding service requirements of the base object schema and all
   * rest record schemas.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type EncodingServices<S extends Objects, Records extends StructWithRest.Records> =
    | S["EncodingServices"]
    | { [K in keyof Records]: Records[K]["EncodingServices"] }[number]

  /**
   * Computes the input type accepted when constructing a `StructWithRest` value by
   * intersecting the base object's make input with the make inputs of all rest
   * record schemas.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type MakeIn<S extends Objects, Records extends StructWithRest.Records> =
    & S["~type.make"]
    & MergeTuple<{ readonly [K in keyof Records]: Records[K]["~type.make"] }>
}

/**
 * Companion type for a struct combined with one or more record schemas. Produced
 * by {@link StructWithRest}.
 *
 * **When to use**
 *
 * Use as the schema type when generic code needs to retain the base struct
 * schema and all rest record schemas.
 *
 * @see {@link StructWithRest} for constructing this schema type
 * @see {@link Record} for constructing record schemas used as rest index signatures
 *
 * @category models
 * @since 4.0.0
 */
export interface StructWithRest<
  S extends StructWithRest.Objects,
  Records extends StructWithRest.Records
> extends
  Bottom<
    Simplify<StructWithRest.Type<S, Records>>,
    Simplify<StructWithRest.Encoded<S, Records>>,
    StructWithRest.DecodingServices<S, Records>,
    StructWithRest.EncodingServices<S, Records>,
    AST.Objects,
    StructWithRest<S, Records>,
    Simplify<StructWithRest.MakeIn<S, Records>>,
    Simplify<StructWithRest.Iso<S, Records>>
  >
{
  readonly schema: S
  readonly records: Records
}

/**
 * Extends a struct schema with one or more record (index-signature) schemas,
 * producing a schema whose decoded type intersects the struct and all records.
 *
 * **Example** (Struct with string-indexed extra keys)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.StructWithRest(
 *   Schema.Struct({ id: Schema.Number }),
 *   [Schema.Record(Schema.String, Schema.String)]
 * )
 *
 * // { readonly id: number } & { readonly [x: string]: string }
 * type T = typeof schema.Type
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export function StructWithRest<
  const S extends StructWithRest.Objects,
  const Records extends StructWithRest.Records
>(
  schema: S,
  records: Records
): StructWithRest<S, Records> {
  return make(AST.structWithRest(schema.ast, records.map(AST.getAST)), { schema, records })
}

/**
 * Namespace for `Tuple` type utilities.
 *
 * **Details**
 *
 * - `Tuple.Elements` — constraint for the element schema array
 * - `Tuple.Type<E>` — decoded tuple type
 * - `Tuple.Encoded<E>` — encoded tuple type
 * - `Tuple.MakeIn<E>` — constructor input tuple
 *
 * @since 3.10.0
 */
export declare namespace Tuple {
  /**
   * Constraint for the readonly array of element schemas used to define a
   * fixed-length `Tuple` schema.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Elements = ReadonlyArray<Top>

  type Type_<
    Elements,
    Out extends ReadonlyArray<any> = readonly []
  > = Elements extends readonly [infer Head, ...infer Tail] ?
    Head extends { readonly "Type": infer T } ?
      Head extends { readonly "~type.optionality": "optional" } ? Type_<Tail, readonly [...Out, T?]>
      : Type_<Tail, readonly [...Out, T]>
    : Out
    : Out

  /**
   * Computes the decoded tuple type for a tuple element schema array.
   *
   * **Details**
   *
   * Each element contributes its decoded `Type`; optional element schemas produce
   * optional tuple positions.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Type<E extends Elements> = Type_<E>

  type Iso_<
    Elements,
    Out extends ReadonlyArray<any> = readonly []
  > = Elements extends readonly [infer Head, ...infer Tail] ?
    Head extends { readonly "Iso": infer T } ?
      Head extends { readonly "~type.optionality": "optional" } ? Iso_<Tail, readonly [...Out, T?]>
      : Iso_<Tail, readonly [...Out, T]>
    : Out
    : Out

  /**
   * Computes the iso tuple type for a tuple element schema array from each
   * element schema's `Iso` type.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Iso<E extends Elements> = Iso_<E>

  type Encoded_<
    Elements,
    Out extends ReadonlyArray<any> = readonly []
  > = Elements extends readonly [infer Head, ...infer Tail] ?
    Head extends { readonly "Encoded": infer T } ?
      Head extends { readonly "~encoded.optionality": "optional" } ? Encoded_<Tail, readonly [...Out, T?]>
      : Encoded_<Tail, readonly [...Out, T]>
    : Out
    : Out

  /**
   * Computes the encoded tuple type for a tuple element schema array.
   *
   * **Details**
   *
   * Each element contributes its `Encoded` type; encoded-side optional element
   * schemas produce optional tuple positions.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Encoded<E extends Elements> = Encoded_<E>

  /**
   * Union of all decoding service requirements needed by the tuple element
   * schemas.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type DecodingServices<E extends Elements> = E[number]["DecodingServices"]

  /**
   * Union of all encoding service requirements needed by the tuple element
   * schemas.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type EncodingServices<E extends Elements> = E[number]["EncodingServices"]

  type MakeIn_<
    E,
    Out extends ReadonlyArray<any> = readonly []
  > = E extends readonly [infer Head, ...infer Tail] ?
    Head extends { "~type.make": infer T } ?
      Head extends
        { readonly "~type.optionality": "optional" } | { readonly "~type.constructor.default": "with-default" } ?
        MakeIn_<Tail, readonly [...Out, T?]> :
      MakeIn_<Tail, readonly [...Out, T]>
    : Out :
    Out

  /**
   * Computes the input tuple type accepted when constructing a tuple value.
   *
   * **Details**
   *
   * Each element uses its `~type.make` input type. Optional elements and elements
   * with constructor defaults produce optional tuple positions.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type MakeIn<E extends Elements> = MakeIn_<E>
}

/**
 * Companion type for a fixed-length tuple. Produced by {@link Tuple}.
 *
 * @category models
 * @since 3.10.0
 */
export interface Tuple<Elements extends Tuple.Elements> extends
  Bottom<
    Tuple.Type<Elements>,
    Tuple.Encoded<Elements>,
    Tuple.DecodingServices<Elements>,
    Tuple.EncodingServices<Elements>,
    AST.Arrays,
    Tuple<Elements>,
    Tuple.MakeIn<Elements>,
    Tuple.Iso<Elements>
  >
{
  readonly elements: Elements
  /**
   * Returns a new tuple with the elements modified by the provided function.
   *
   * **Details**
   *
   * Options:
   *
   * - `unsafePreserveChecks` - if `true`, keep any `.check(...)` constraints
   *   that were attached to the original union. Defaults to `false`.
   *
   *   **Warning**: This is an unsafe operation. Since `mapFields`
   *   transformations change the schema type, the original refinement functions
   *   may no longer be valid or safe to apply to the transformed schema. Only
   *   use this option if you have verified that your refinements remain correct
   *   after the transformation.
   */
  mapElements<To extends Tuple.Elements>(
    f: (elements: Elements) => To,
    options?: {
      readonly unsafePreserveChecks?: boolean | undefined
    } | undefined
  ): Tuple<Simplify<Readonly<To>>>
}

function makeTuple<Elements extends Tuple.Elements>(ast: AST.Arrays, elements: Elements): Tuple<Elements> {
  return make(ast, {
    elements,
    mapElements<To extends Tuple.Elements>(
      this: Tuple<Elements>,
      f: (elements: Elements) => To,
      options?: {
        readonly unsafePreserveChecks?: boolean | undefined
      } | undefined
    ): Tuple<Simplify<Readonly<To>>> {
      const elements = f(this.elements)
      return makeTuple(AST.tuple(elements, options?.unsafePreserveChecks ? this.ast.checks : undefined), elements)
    }
  })
}

/**
 * Defines a fixed-length tuple schema from an array of element schemas.
 *
 * **Example** (Pair of string and number)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.Tuple([Schema.String, Schema.Number])
 *
 * const pair = Schema.decodeUnknownSync(schema)(["hello", 42])
 * console.log(pair)
 * // [ 'hello', 42 ]
 * ```
 *
 * @category constructors
 * @since 3.10.0
 */
export function Tuple<const Elements extends ReadonlyArray<Top>>(elements: Elements): Tuple<Elements> {
  return makeTuple(AST.tuple(elements), elements)
}

/**
 * Namespace for `TupleWithRest` type utilities.
 *
 * **Details**
 *
 * - `TupleWithRest.TupleType` — constraint for the leading tuple schema
 * - `TupleWithRest.Rest` — the rest element schema(s)
 * - `TupleWithRest.Type<T, R>` — decoded type (fixed elements + rest)
 * - `TupleWithRest.Encoded<T, R>` — encoded type
 *
 * @since 4.0.0
 */
export declare namespace TupleWithRest {
  /**
   * Constraint for tuple-like schemas that can be used as the fixed leading
   * portion of a `TupleWithRest` schema.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type TupleType = Top & {
    readonly Type: ReadonlyArray<unknown>
    readonly Encoded: ReadonlyArray<unknown>
    readonly ast: AST.Arrays
    readonly "~type.make": ReadonlyArray<unknown>
    readonly "Iso": ReadonlyArray<unknown>
  }

  /**
   * Non-empty list of schemas used for the rest portion of a `TupleWithRest`.
   *
   * **Details**
   *
   * The first schema describes the repeated rest element. Additional schemas, when
   * present, describe trailing tuple elements after the repeated rest segment.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Rest = readonly [Top, ...Array<Top>]

  /**
   * Computes the decoded tuple type for a `TupleWithRest`.
   *
   * **Details**
   *
   * The output starts with the fixed tuple elements, continues with zero or more
   * values decoded by the first rest schema, and includes any trailing rest schemas
   * as fixed tuple positions.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Type<T extends ReadonlyArray<unknown>, Rest extends TupleWithRest.Rest> = Rest extends
    readonly [infer Head extends Top, ...infer Tail extends ReadonlyArray<Top>] ? Readonly<[
      ...T,
      ...Array<Head["Type"]>,
      ...{ readonly [K in keyof Tail]: Tail[K]["Type"] }
    ]> :
    T

  /**
   * Computes the iso tuple type for a `TupleWithRest`.
   *
   * **Details**
   *
   * The output starts with the fixed tuple's `Iso` elements, continues with zero
   * or more values using the first rest schema's `Iso`, and includes any trailing
   * rest schemas as fixed tuple positions.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Iso<T extends ReadonlyArray<unknown>, Rest extends TupleWithRest.Rest> = Rest extends
    readonly [infer Head extends Top, ...infer Tail extends ReadonlyArray<Top>] ? Readonly<[
      ...T,
      ...Array<Head["Iso"]>,
      ...{ readonly [K in keyof Tail]: Tail[K]["Iso"] }
    ]> :
    T

  /**
   * Computes the encoded tuple type for `TupleWithRest`.
   *
   * **Details**
   *
   * The leading tuple's encoded elements are kept first. The encoded type of the
   * first rest schema may repeat zero or more times, and the encoded types of any
   * additional rest schemas become required trailing tuple elements.
   *
   * @category utility types
   * @since 3.10.0
   */
  export type Encoded<E extends ReadonlyArray<unknown>, Rest extends TupleWithRest.Rest> = Rest extends
    readonly [infer Head extends Top, ...infer Tail extends ReadonlyArray<Top>] ? readonly [
      ...E,
      ...Array<Head["Encoded"]>,
      ...{ readonly [K in keyof Tail]: Tail[K]["Encoded"] }
    ] :
    E

  /**
   * Computes the constructor input tuple type for `TupleWithRest`.
   *
   * **Details**
   *
   * The leading tuple's make input elements are kept first. The make input type of
   * the first rest schema may repeat zero or more times, and the make input types
   * of any additional rest schemas become required trailing tuple elements.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type MakeIn<M extends ReadonlyArray<unknown>, Rest extends TupleWithRest.Rest> = Rest extends
    readonly [infer Head extends Top, ...infer Tail extends ReadonlyArray<Top>] ? readonly [
      ...M,
      ...Array<Head["~type.make"]>,
      ...{ readonly [K in keyof Tail]: Tail[K]["~type.make"] }
    ] :
    M
}

/**
 * Companion type for a tuple with additional rest elements. Produced by
 * {@link TupleWithRest}.
 *
 * @category models
 * @since 4.0.0
 */
export interface TupleWithRest<
  S extends TupleWithRest.TupleType,
  Rest extends TupleWithRest.Rest
> extends
  Bottom<
    TupleWithRest.Type<S["Type"], Rest>,
    TupleWithRest.Encoded<S["Encoded"], Rest>,
    S["DecodingServices"] | Rest[number]["DecodingServices"],
    S["EncodingServices"] | Rest[number]["EncodingServices"],
    AST.Arrays,
    TupleWithRest<S, Rest>,
    TupleWithRest.MakeIn<S["~type.make"], Rest>,
    TupleWithRest.Iso<S["Iso"], Rest>
  >
{
  readonly schema: S
  readonly rest: Rest
}

/**
 * Extends a fixed-length tuple schema with a variadic rest segment.
 *
 * **Details**
 *
 * The resulting tuple starts with the fixed elements from `schema`. The first
 * schema in `rest` is the repeatable element schema, and any additional schemas
 * in `rest` are required trailing tuple elements after the variadic segment. For
 * example, `[Schema.Boolean, Schema.String]` represents zero or more booleans
 * followed by a final string.
 *
 * **Example** (Tuple with rest)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * // [string, number, ...boolean[]]
 * const schema = Schema.TupleWithRest(
 *   Schema.Tuple([Schema.String, Schema.Number]),
 *   [Schema.Boolean]
 * )
 *
 * const result = Schema.decodeUnknownSync(schema)(["hello", 1, true, false])
 * console.log(result)
 * // [ 'hello', 1, true, false ]
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export function TupleWithRest<S extends Tuple<Tuple.Elements>, const Rest extends TupleWithRest.Rest>(
  schema: S,
  rest: Rest
): TupleWithRest<S, Rest> {
  return make(AST.tupleWithRest(schema.ast, rest.map(AST.getAST)), { schema, rest })
}

/**
 * Schema interface produced by `Schema.Array` for readonly arrays.
 *
 * **When to use**
 *
 * Use as the public companion type returned by `Schema.Array` when you need to
 * refer to a readonly array schema built from an element schema.
 *
 * **Details**
 *
 * The decoded type is `ReadonlyArray<S["Type"]>`, the encoded type is
 * `ReadonlyArray<S["Encoded"]>`, and the element schema is available as
 * `value`.
 *
 * @category models
 * @since 4.0.0
 */
export interface $Array<S extends Top> extends
  Bottom<
    ReadonlyArray<S["Type"]>,
    ReadonlyArray<S["Encoded"]>,
    S["DecodingServices"],
    S["EncodingServices"],
    AST.Arrays,
    $Array<S>,
    ReadonlyArray<S["~type.make"]>,
    ReadonlyArray<S["Iso"]>
  >
{
  readonly value: S
}

interface ArrayLambda extends Lambda {
  <S extends Top>(self: S): $Array<S>
  readonly "~lambda.out": this["~lambda.in"] extends Top ? $Array<this["~lambda.in"]> : never
}

/**
 * @category constructors
 * @since 4.0.0
 */
const ArraySchema = Struct_.lambda<ArrayLambda>((schema) =>
  make(new AST.Arrays(false, [], [schema.ast]), { value: schema })
)

export {
  /**
   * Defines a `ReadonlyArray` schema for a given element schema.
   *
   * **Example** (Array of strings)
   *
   * ```ts
   * import { Schema } from "effect"
   *
   * const schema = Schema.Array(Schema.String)
   *
   * const result = Schema.decodeUnknownSync(schema)(["a", "b", "c"])
   * console.log(result)
   * // [ 'a', 'b', 'c' ]
   * ```
   *
   * @category constructors
   * @since 4.0.0
   */
  ArraySchema as Array
}

/**
 * Companion type for a non-empty `ReadonlyArray`. Produced by {@link NonEmptyArray}.
 *
 * **Details**
 *
 * The decoded type is `readonly [S["Type"], ...Array<S["Type"]>]`, the encoded type is
 * `readonly [S["Encoded"], ...Array<S["Encoded"]>]`, and the element schema is available as
 * `value`.
 *
 * @category models
 * @since 3.10.0
 */
export interface NonEmptyArray<S extends Top> extends
  Bottom<
    readonly [S["Type"], ...Array<S["Type"]>],
    readonly [S["Encoded"], ...Array<S["Encoded"]>],
    S["DecodingServices"],
    S["EncodingServices"],
    AST.Arrays,
    NonEmptyArray<S>,
    readonly [S["~type.make"], ...Array<S["~type.make"]>],
    readonly [S["Iso"], ...Array<S["Iso"]>]
  >
{
  readonly value: S
}

interface NonEmptyArrayLambda extends Lambda {
  <S extends Top>(self: S): NonEmptyArray<S>
  readonly "~lambda.out": this["~lambda.in"] extends Top ? NonEmptyArray<this["~lambda.in"]> : never
}

/**
 * Defines a non-empty `ReadonlyArray` schema — at least one element required.
 * Type is `readonly [T, ...T[]]`.
 *
 * **Example** (Non-empty array of numbers)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.NonEmptyArray(Schema.Number)
 *
 * Schema.decodeUnknownSync(schema)([1, 2, 3])  // ok
 * Schema.decodeUnknownSync(schema)([])          // throws
 * ```
 *
 * @category constructors
 * @since 3.10.0
 */
export const NonEmptyArray = Struct_.lambda<NonEmptyArrayLambda>((schema) =>
  make(new AST.Arrays(false, [schema.ast], [schema.ast]), { value: schema })
)

/**
 * Schema interface returned by `ArrayEnsure`, which normalizes a single item or
 * an array of items into a readonly array.
 *
 * **When to use**
 *
 * Use as the schema type when generic code needs to retain the original item
 * schema.
 *
 * **Details**
 *
 * The schema decodes from `S` or `Schema.Array(S)` and produces
 * `ReadonlyArray<S["Type"]>`.
 *
 * @see {@link ArrayEnsure} for constructing this schema type
 *
 * @category constructors
 * @since 3.10.0
 */
export interface ArrayEnsure<S extends Top> extends decodeTo<$Array<toType<S>>, Union<readonly [S, $Array<S>]>> {
  readonly "Rebuild": ArrayEnsure<S>
}

/**
 * Creates a schema that accepts either a value decoded by `schema` or an array
 * decoded by `Schema.Array(schema)`, then returns an array.
 *
 * **When to use**
 *
 * Use to accept input that may be provided either as one item or as an array,
 * while normalizing decoded values to a readonly array.
 *
 * **Details**
 *
 * During encoding, one-element arrays are encoded as the single element. Empty
 * arrays and arrays with two or more elements are encoded as arrays.
 *
 * **Gotchas**
 *
 * The single-value branch is tried before the array branch. If `schema` itself
 * accepts arrays, an array input can be treated as one value and wrapped in a
 * one-element array.
 *
 * @see {@link Array} for accepting only array input
 * @see {@link NonEmptyArray} for requiring at least one decoded element
 *
 * @category constructors
 * @since 3.10.0
 */
export function ArrayEnsure<S extends Top>(schema: S): ArrayEnsure<S> {
  return Union([schema, ArraySchema(schema)]).pipe(decodeTo(
    ArraySchema(toType(schema)),
    Transformation.transform({
      decode: Arr.ensure,
      encode: (array) => array.length === 1 ? array[0] : array
    })
  ))
}

/**
 * Companion type for an array with unique elements. Produced by {@link UniqueArray}.
 *
 * @category models
 * @since 4.0.0
 */
export interface UniqueArray<S extends Top> extends $Array<S> {
  readonly "Rebuild": UniqueArray<S>
}

/**
 * Returns a new array schema that ensures all elements are unique.
 *
 * **Details**
 *
 * The equivalence used to determine uniqueness is the one provided by
 * `Schema.toEquivalence(item)`.
 *
 * @category constructors
 * @since 4.0.0
 */
export function UniqueArray<S extends Top>(item: S): UniqueArray<S> {
  return ArraySchema(item).check(isUnique())
}

/**
 * Schema type that makes array or tuple elements mutable (removes `readonly`).
 * Produced by {@link mutable}.
 *
 * @category transforming
 * @since 3.10.0
 */
export interface mutable<S extends Top & { readonly "ast": AST.Arrays }> extends
  Bottom<
    Mutable<S["Type"]>,
    Mutable<S["Encoded"]>,
    S["DecodingServices"],
    S["EncodingServices"],
    S["ast"],
    mutable<S>,
    // "~type.make" and "~type.make.in" as they are because they are contravariant
    S["~type.make.in"],
    S["Iso"],
    S["~type.parameters"],
    S["~type.make"],
    S["~type.mutability"],
    S["~type.optionality"],
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{
  readonly schema: S
}

interface mutableLambda extends Lambda {
  <S extends Top & { readonly "ast": AST.Arrays }>(self: S): mutable<S>
  readonly "~lambda.out": this["~lambda.in"] extends Top & { readonly "ast": AST.Arrays } ? mutable<this["~lambda.in"]>
    : "Error: schema not eligible for mutable"
}

/**
 * Makes an array or tuple schema mutable, removing the `readonly` modifier.
 *
 * **Example** (Mutable array)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.mutable(Schema.Array(Schema.Number))
 *
 * // number[]   (mutable)
 * type T = typeof schema.Type
 * ```
 *
 * @category transforming
 * @since 3.10.0
 */
export const mutable = Struct_.lambda<mutableLambda>((schema) => {
  return make(new AST.Arrays(true, schema.ast.elements, schema.ast.rest), { schema })
})

/**
 * Companion type for a union of multiple schemas. Produced by {@link Union}.
 *
 * @category models
 * @since 3.10.0
 */
export interface Union<Members extends ReadonlyArray<Top>> extends
  Bottom<
    { [K in keyof Members]: Members[K]["Type"] }[number],
    { [K in keyof Members]: Members[K]["Encoded"] }[number],
    { [K in keyof Members]: Members[K]["DecodingServices"] }[number],
    { [K in keyof Members]: Members[K]["EncodingServices"] }[number],
    AST.Union<{ [K in keyof Members]: Members[K]["ast"] }[number]>,
    Union<Members>,
    { [K in keyof Members]: Members[K]["~type.make"] }[number],
    { [K in keyof Members]: Members[K]["Iso"] }[number]
  >
{
  readonly members: Members
  /**
   * Returns a new union with the members modified by the provided function.
   *
   * **Details**
   *
   * Options:
   *
   * - `unsafePreserveChecks` - if `true`, keep any `.check(...)` constraints
   *   that were attached to the original union. Defaults to `false`.
   *
   *   **Warning**: This is an unsafe operation. Since `mapFields`
   *   transformations change the schema type, the original refinement functions
   *   may no longer be valid or safe to apply to the transformed schema. Only
   *   use this option if you have verified that your refinements remain correct
   *   after the transformation.
   */
  mapMembers<To extends ReadonlyArray<Top>>(
    f: (members: Members) => To,
    options?: {
      readonly unsafePreserveChecks?: boolean | undefined
    } | undefined
  ): Union<Simplify<Readonly<To>>>
}

function makeUnion<Members extends ReadonlyArray<Top>>(
  ast: AST.Union<Members[number]["ast"]>,
  members: Members
): Union<Members> {
  return make(ast, {
    members,
    mapMembers<To extends ReadonlyArray<Top>>(
      this: Union<Members>,
      f: (members: Members) => To,
      options?: {
        readonly unsafePreserveChecks?: boolean | undefined
      } | undefined
    ): Union<Simplify<Readonly<To>>> {
      const members = f(this.members)
      return makeUnion(
        AST.union(members, this.ast.mode, options?.unsafePreserveChecks ? this.ast.checks : undefined),
        members
      )
    }
  })
}

/**
 * Creates a union schema from an array of member schemas. Members are tested in
 * order; the first match is returned.
 *
 * **Details**
 *
 * Optionally, specify `mode`:
 * - `"anyOf"` (default) — matches if any member matches.
 * - `"oneOf"` — matches if exactly one member matches.
 *
 * **Example** (String or number union)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.Union([Schema.String, Schema.Number])
 *
 * Schema.decodeUnknownSync(schema)("hello") // "hello"
 * Schema.decodeUnknownSync(schema)(42)       // 42
 * ```
 *
 * @category constructors
 * @since 3.10.0
 */
export function Union<const Members extends ReadonlyArray<Top>>(
  members: Members,
  options?: { mode?: "anyOf" | "oneOf" }
): Union<Members> {
  return makeUnion(AST.union(members, options?.mode ?? "anyOf", undefined), members)
}

/**
 * Represents a union schema of multiple literal values.
 *
 * @see {@link Literals} for the constructor function.
 * @category models
 * @since 4.0.0
 */
export interface Literals<L extends ReadonlyArray<AST.LiteralValue>>
  extends Bottom<L[number], L[number], never, never, AST.Union<AST.Literal>, Literals<L>>
{
  readonly literals: L
  readonly members: { readonly [K in keyof L]: Literal<L[K]> }
  /**
   * Map over the members of the union.
   */
  mapMembers<To extends ReadonlyArray<Top>>(f: (members: this["members"]) => To): Union<Simplify<Readonly<To>>>

  pick<const L2 extends ReadonlyArray<L[number]>>(literals: L2): Literals<L2>

  transform<const L2 extends { readonly [I in keyof L]: AST.LiteralValue }>(
    to: L2
  ): Union<{ [I in keyof L]: decodeTo<Literal<L2[I]>, Literal<L[I]>> }>
}

/**
 * Creates a union schema from an array of literal values.
 *
 * **Example** (Status codes)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.Literals(["active", "inactive", "pending"])
 * // accepts "active", "inactive", or "pending"
 * ```
 *
 * @see {@link Literal} for a schema that represents a single literal.
 * @category constructors
 * @since 4.0.0
 */
export function Literals<const L extends ReadonlyArray<AST.LiteralValue>>(literals: L): Literals<L> {
  const members = literals.map(Literal) as { readonly [K in keyof L]: Literal<L[K]> }
  return make(AST.union(members, "anyOf", undefined), {
    literals,
    members,
    mapMembers<To extends ReadonlyArray<Top>>(
      this: Literals<L>,
      f: (members: Literals<L>["members"]) => To
    ): Union<Simplify<Readonly<To>>> {
      return Union(f(this.members))
    },
    pick<const L2 extends ReadonlyArray<L[number]>>(literals: L2): Literals<L2> {
      return Literals(literals)
    },
    transform<const L2 extends { readonly [I in keyof L]: AST.LiteralValue }>(
      to: L2
    ): Union<{ [I in keyof L]: decodeTo<Literal<L2[I]>, Literal<L[I]>> }> {
      return Union(members.map((member, index) => member.transform(to[index]))) as any
    }
  })
}

/**
 * Companion type for `S | null`. Produced by {@link NullOr}.
 *
 * @category models
 * @since 3.10.0
 */
export interface NullOr<S extends Top> extends Union<readonly [S, Null]> {
  readonly "Rebuild": NullOr<S>
}

interface NullOrLambda extends Lambda {
  <S extends Top>(self: S): NullOr<S>
  readonly "~lambda.out": this["~lambda.in"] extends Top ? NullOr<this["~lambda.in"]> : never
}

/**
 * Creates a union schema of `S | null`.
 *
 * @category constructors
 * @since 3.10.0
 */
export const NullOr = Struct_.lambda<NullOrLambda>((self) => Union([self, Null]))

/**
 * Companion type for `S | undefined`. Produced by {@link UndefinedOr}.
 *
 * @category models
 * @since 3.10.0
 */
export interface UndefinedOr<S extends Top> extends Union<readonly [S, Undefined]> {
  readonly "Rebuild": UndefinedOr<S>
}

interface UndefinedOrLambda extends Lambda {
  <S extends Top>(self: S): UndefinedOr<S>
  readonly "~lambda.out": this["~lambda.in"] extends Top ? UndefinedOr<this["~lambda.in"]> : never
}

/**
 * Creates a union schema of `S | undefined`.
 *
 * @category constructors
 * @since 3.10.0
 */
export const UndefinedOr = Struct_.lambda<UndefinedOrLambda>((self) => Union([self, Undefined]))

/**
 * Companion type for `S | null | undefined`. Produced by {@link NullishOr}.
 *
 * @category models
 * @since 3.10.0
 */
export interface NullishOr<S extends Top> extends Union<readonly [S, Null, Undefined]> {
  readonly "Rebuild": NullishOr<S>
}

interface NullishOrLambda extends Lambda {
  <S extends Top>(self: S): NullishOr<S>
  readonly "~lambda.out": this["~lambda.in"] extends Top ? NullishOr<this["~lambda.in"]> : never
}

/**
 * Creates a union schema of `S | null | undefined`.
 *
 * @category constructors
 * @since 3.10.0
 */
export const NullishOr = Struct_.lambda<NullishOrLambda>((self) => Union([self, Null, Undefined]))

/**
 * Schema type wrapping a lazily-evaluated schema. Produced by {@link suspend}.
 *
 * @category models
 * @since 3.10.0
 */
export interface suspend<S extends Top> extends
  Bottom<
    S["Type"],
    S["Encoded"],
    S["DecodingServices"],
    S["EncodingServices"],
    AST.Suspend,
    suspend<S>,
    S["~type.make.in"],
    S["Iso"],
    S["~type.parameters"],
    S["~type.make"],
    S["~type.mutability"],
    S["~type.optionality"],
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{}

/**
 * Creates a suspended schema that defers evaluation until needed. This is
 * essential for creating recursive schemas where a schema references itself,
 * preventing infinite recursion during schema definition.
 *
 * **Example** (Recursive tree schema)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * interface Tree {
 *   readonly value: number
 *   readonly children: ReadonlyArray<Tree>
 * }
 *
 * const Tree = Schema.Struct({
 *   value: Schema.Number,
 *   children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree))
 * })
 * ```
 *
 * @category constructors
 * @since 3.10.0
 */
export function suspend<S extends Top>(f: () => S): suspend<S> {
  return make(new AST.Suspend(() => f().ast))
}

/**
 * Attaches one or more filter checks to a schema without changing the
 * TypeScript type.
 *
 * **Example** (Adding checks to a schema)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const AgeSchema = Schema.Number.pipe(
 *   Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(120))
 * )
 * ```
 *
 * @category filtering
 * @since 4.0.0
 */
export function check<S extends Top>(...checks: readonly [AST.Check<S["Type"]>, ...Array<AST.Check<S["Type"]>>]) {
  return (self: S): S["Rebuild"] => self.check(...checks)
}

/**
 * The output type of {@link refine}, narrowing the schema's `Type` to `T` via a
 * type guard.
 *
 * @category filtering
 * @since 3.10.0
 */
export interface refine<T extends S["Type"], S extends Top> extends
  Bottom<
    T,
    S["Encoded"],
    S["DecodingServices"],
    S["EncodingServices"],
    S["ast"],
    refine<T, S>,
    S["~type.make.in"],
    T,
    S["~type.parameters"],
    T,
    S["~type.mutability"],
    S["~type.optionality"],
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{
  readonly schema: S
}

/**
 * Narrows the TypeScript type of a schema's output via a type guard predicate,
 * attaching the guard as a runtime filter check.
 *
 * **Details**
 *
 * The `annotations` parameter annotates the filter created by the refinement.
 * With the default formatter, failed refinements use `message` first,
 * `expected` second, and `<filter>` when neither is provided. `identifier`
 * names type-level failures before the refinement runs; it does not name the
 * failed refinement itself.
 *
 * @category filtering
 * @since 3.10.0
 */
export function refine<S extends Top, T extends S["Type"]>(
  refinement: (value: S["Type"]) => value is T,
  annotations?: Annotations.Filter
) {
  return (schema: S): refine<T, S> =>
    make(AST.appendChecks(schema.ast, [AST.makeFilterByGuard(refinement, annotations)]), { schema })
}

type DistributeBrands<B> = UnionToIntersection<B extends infer U extends string ? Brand.Brand<U> : never>

/**
 * The output type of {@link brand}, intersecting the schema's `Type` with one or
 * more {@link Brand.Brand} tags.
 *
 * **When to use**
 *
 * Use as the schema type when generic code needs to retain the wrapped schema
 * and nominal brand type.
 *
 * @see {@link brand} for adding the brand tag to an existing schema
 *
 * @category branding
 * @since 3.10.0
 */
export interface brand<S extends Top, B> extends
  Bottom<
    S["Type"] & DistributeBrands<B>,
    S["Encoded"],
    S["DecodingServices"],
    S["EncodingServices"],
    S["ast"],
    brand<S, B>,
    S["~type.make.in"],
    S["Type"] & DistributeBrands<B>,
    S["~type.parameters"],
    S["Type"] & DistributeBrands<B>,
    S["~type.mutability"],
    S["~type.optionality"],
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{
  readonly schema: S
  readonly identifier: string
}

/**
 * Adds a nominal brand to a schema, intersecting the output type with
 * `Brand.Brand<B>` to prevent accidental mixing of structurally identical types.
 *
 * **When to use**
 *
 * Use to make values decoded by an existing schema nominally distinct when the
 * schema already carries the runtime validation you need.
 *
 * **Gotchas**
 *
 * `brand` adds brand metadata and narrows the TypeScript output type, but it
 * does not add runtime checks.
 *
 * @see {@link fromBrand} for applying a Brand constructor's checks along with the brand tag
 *
 * @category branding
 * @since 3.10.0
 */
export function brand<B extends string>(identifier: B) {
  return <S extends Top>(schema: S): brand<S["Rebuild"], B> =>
    make(AST.brand(schema.ast, identifier), { schema, identifier })
}

/**
 * Creates a branded schema from a {@link Brand.Constructor}, applying the
 * constructor's checks and brand tag to the underlying schema.
 *
 * @category branding
 * @since 3.10.0
 */
export function fromBrand<A extends Brand.Brand<any>>(identifier: string, ctor: Brand.Constructor<A>) {
  return <S extends Top & { readonly "Type": Brand.Brand.Unbranded<A> }>(
    self: S
  ): brand<S["Rebuild"], Brand.Brand.Keys<A>> => {
    return (ctor.checks ? self.check(...ctor.checks) : self).pipe(brand(identifier))
  }
}

/**
 * A schema that wraps another schema and intercepts its decoding pipeline.
 *
 * **Details**
 *
 * The interceptor receives the full decoding `Effect` and may replace, modify,
 * or augment it — including adding service requirements via `RD`.
 *
 * @see {@link middlewareDecoding} for the constructor
 * @category decoding
 * @since 4.0.0
 */
export interface middlewareDecoding<S extends Top, RD> extends
  Bottom<
    S["Type"],
    S["Encoded"],
    RD,
    S["EncodingServices"],
    S["ast"],
    middlewareDecoding<S, RD>,
    S["~type.make.in"],
    S["Iso"],
    S["~type.parameters"],
    S["~type.make"],
    S["~type.mutability"],
    S["~type.optionality"],
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{
  readonly schema: S
}

/**
 * Intercepts the decoding pipeline of a schema.
 *
 * **Details**
 *
 * The provided function receives the current decoding `Effect` and `ParseOptions`,
 * and returns a new `Effect` — potentially adding service requirements (`RD`),
 * recovering from errors, or augmenting the result.
 *
 * **Example** (Logging decode failures)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 *
 * const Logged = Schema.String.pipe(
 *   Schema.middlewareDecoding((effect) =>
 *     Effect.tapError(effect, (issue) => Effect.log("decode failed", issue))
 *   )
 * )
 * ```
 *
 * @see {@link catchDecoding} for a simpler error-recovery variant
 * @category decoding
 * @since 4.0.0
 */
export function middlewareDecoding<S extends Top, RD>(
  decode: (
    effect: Effect.Effect<Option_.Option<S["Type"]>, Issue.Issue, S["DecodingServices"]>,
    options: AST.ParseOptions
  ) => Effect.Effect<Option_.Option<S["Type"]>, Issue.Issue, RD>
) {
  return (schema: S): middlewareDecoding<S, RD> =>
    make(
      AST.middlewareDecoding(schema.ast, new Transformation.Middleware(decode, identity)),
      { schema }
    )
}

/**
 * A schema that wraps another schema and intercepts its encoding pipeline.
 *
 * **Details**
 *
 * The interceptor receives the full encoding `Effect` and may replace, modify,
 * or augment it — including adding service requirements via `RE`.
 *
 * @see {@link middlewareEncoding} for the constructor
 * @category encoding
 * @since 4.0.0
 */
export interface middlewareEncoding<S extends Top, RE> extends
  Bottom<
    S["Type"],
    S["Encoded"],
    S["DecodingServices"],
    RE,
    S["ast"],
    middlewareEncoding<S, RE>,
    S["~type.make.in"],
    S["Iso"],
    S["~type.parameters"],
    S["~type.make"],
    S["~type.mutability"],
    S["~type.optionality"],
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{
  readonly schema: S
}

/**
 * Intercepts the encoding pipeline of a schema.
 *
 * **Details**
 *
 * The provided function receives the current encoding `Effect` and `ParseOptions`,
 * and returns a new `Effect` — potentially adding service requirements (`RE`),
 * recovering from errors, or augmenting the result.
 *
 * **Example** (Logging encode failures)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 *
 * const Logged = Schema.String.pipe(
 *   Schema.middlewareEncoding((effect) =>
 *     Effect.tapError(effect, (issue) => Effect.log("encode failed", issue))
 *   )
 * )
 * ```
 *
 * @see {@link catchEncoding} for a simpler error-recovery variant
 * @category encoding
 * @since 4.0.0
 */
export function middlewareEncoding<S extends Top, RE>(
  encode: (
    effect: Effect.Effect<Option_.Option<S["Encoded"]>, Issue.Issue, S["EncodingServices"]>,
    options: AST.ParseOptions
  ) => Effect.Effect<Option_.Option<S["Encoded"]>, Issue.Issue, RE>
) {
  return (schema: S): middlewareEncoding<S, RE> =>
    make(
      AST.middlewareEncoding(schema.ast, new Transformation.Middleware(identity, encode)),
      { schema }
    )
}

/**
 * Recovers from a decoding error by providing a fallback value.
 *
 * **Details**
 *
 * The handler receives the `Issue` and returns an `Effect` that either
 * succeeds with a fallback value or re-fails with a (possibly different) issue.
 *
 * **Example** (Returning a default on decode failure)
 *
 * ```ts
 * import { Effect, Option, Schema } from "effect"
 *
 * const schema = Schema.Number.pipe(
 *   Schema.catchDecoding((_issue) => Effect.succeed(Option.some(0)))
 * )
 * ```
 *
 * @see {@link catchDecodingWithContext} to add service requirements to the handler
 * @category error handling
 * @since 4.0.0
 */
export function catchDecoding<S extends Top>(
  f: (issue: Issue.Issue) => Effect.Effect<Option_.Option<S["Type"]>, Issue.Issue>
): (self: S) => S["Rebuild"] {
  return catchDecodingWithContext(f)
}

/**
 * Recovers from a decoding error with a handler that may require Effect services.
 *
 * **When to use**
 *
 * Use when decoding fallback logic needs services from the Effect context.
 *
 * **Details**
 *
 * The handler receives the `Issue` and returns an `Effect` that either succeeds
 * with a fallback value or re-fails with a (possibly different) issue. The
 * handler's services are added to the schema's decoding services.
 *
 * @see {@link catchDecoding} for recovery handlers that do not require services
 * @see {@link middlewareDecoding} for intercepting or replacing the full decoding pipeline
 *
 * @category error handling
 * @since 4.0.0
 */
export function catchDecodingWithContext<S extends Top, R = never>(
  f: (issue: Issue.Issue) => Effect.Effect<Option_.Option<S["Type"]>, Issue.Issue, R>
) {
  return (self: S): middlewareDecoding<S, S["DecodingServices"] | R> =>
    self.pipe(middlewareDecoding(Effect.catchEager(f)))
}

/**
 * Recovers from an encoding error by providing a fallback value.
 *
 * **Details**
 *
 * The handler receives the `Issue` and returns an `Effect` that either
 * succeeds with a fallback value or re-fails with a (possibly different) issue.
 *
 * @see {@link catchEncodingWithContext} to add service requirements to the handler
 * @category error handling
 * @since 4.0.0
 */
export function catchEncoding<S extends Top>(
  f: (issue: Issue.Issue) => Effect.Effect<Option_.Option<S["Encoded"]>, Issue.Issue>
): (self: S) => S["Rebuild"] {
  return catchEncodingWithContext(f)
}

/**
 * Recovers from an encoding error with a handler that may require Effect services.
 *
 * **When to use**
 *
 * Use when encoding fallback logic needs services from the Effect context.
 *
 * **Details**
 *
 * The handler receives the `Issue` and returns an `Effect` that either succeeds
 * with a fallback encoded value or re-fails with a (possibly different) issue.
 * The handler's services are added to the schema's encoding services.
 *
 * @see {@link catchEncoding} for recovery handlers that do not require services
 * @see {@link middlewareEncoding} for intercepting or replacing the full encoding pipeline
 *
 * @category error handling
 * @since 4.0.0
 */
export function catchEncodingWithContext<S extends Top, R = never>(
  f: (issue: Issue.Issue) => Effect.Effect<Option_.Option<S["Encoded"]>, Issue.Issue, R>
) {
  return (self: S): middlewareEncoding<S, S["EncodingServices"] | R> =>
    self.pipe(middlewareEncoding(Effect.catchEager(f)))
}

/**
 * Schema type produced by `decodeTo` when a custom transformation composes a
 * `From` schema with a `To` schema.
 *
 * **Details**
 *
 * `Type` is `To["Type"]` and `Encoded` is `From["Encoded"]`. Decoding services
 * are `To["DecodingServices"] | From["DecodingServices"] | RD`; encoding
 * services are `To["EncodingServices"] | From["EncodingServices"] | RE`.
 *
 * @see {@link compose} for the passthrough (no transformation) variant
 * @category transforming
 * @since 4.0.0
 */
export interface decodeTo<To extends Top, From extends Top, RD = never, RE = never> extends
  Bottom<
    To["Type"],
    From["Encoded"],
    To["DecodingServices"] | From["DecodingServices"] | RD,
    To["EncodingServices"] | From["EncodingServices"] | RE,
    To["ast"],
    decodeTo<To, From, RD, RE>,
    To["~type.make.in"],
    To["Iso"],
    To["~type.parameters"],
    To["~type.make"],
    To["~type.mutability"],
    To["~type.optionality"],
    To["~type.constructor.default"],
    From["~encoded.mutability"],
    From["~encoded.optionality"]
  >
{
  readonly from: From
  readonly to: To
}

/**
 * The type produced by {@link decodeTo} when called without a custom transformation (passthrough composition).
 *
 * **Details**
 *
 * Equivalent to {@link decodeTo} with `RD = never` and `RE = never`, meaning the schemas
 * are composed using their natural encoding/decoding chain.
 *
 * @see {@link decodeTo} for the transformation variant
 * @category transforming
 * @since 3.10.0
 */
export interface compose<To extends Top, From extends Top> extends decodeTo<To, From> {}

/**
 * Creates a schema that transforms from a source schema to a target schema.
 *
 * **Details**
 *
 * This is a curried function: call it with the target schema `to` (and optionally a transformation),
 * then call the returned function with the source schema `from`. The resulting schema decodes from
 * `From["Encoded"]` to `To["Type"]` and encodes from `To["Type"]` back to `From["Encoded"]`.
 *
 * Key guarantees:
 * - Resulting schema has `Type = To["Type"]` and `Encoded = From["Encoded"]`
 * - When `transformation` is omitted, uses `Transformation.passthrough()` (schema composition)
 * - Combines decoding/encoding services from both `from` and `to` schemas
 * - Transformation `decode` maps `From["Type"]` → `To["Encoded"]` (used during encoding)
 * - Transformation `encode` maps `To["Encoded"]` → `From["Type"]` (used during decoding)
 *
 * Common mistakes:
 * - **Direction confusion**: Remember `to` is the target (what you decode TO), `from` is the source (what you decode FROM)
 * - **Currying**: This is curried - must use pipe: `from.pipe(Schema.decodeTo(to))`
 * - **Transformation direction**: `decode` goes `From["Type"]` → `To["Encoded"]`, `encode` goes `To["Encoded"]` → `From["Type"]`
 * - **Passthrough assumption**: Without transformation, schemas must satisfy `To["Encoded"] === From["Type"]` or use passthrough helpers
 * - **Service dependencies**: Resulting schema requires services from both schemas; use `Schema.provideService` if needed
 *
 * **Example** (String to Number with transformation)
 *
 * ```ts
 * import { Schema, SchemaGetter } from "effect"
 *
 * const NumberFromString = Schema.String.pipe(
 *   Schema.decodeTo(
 *     Schema.Number,
 *     {
 *       decode: SchemaGetter.transform((s) => Number(s)),
 *       encode: SchemaGetter.transform((n) => String(n))
 *     }
 *   )
 * )
 *
 * const result = Schema.decodeUnknownSync(NumberFromString)("123")
 * // result: 123
 * ```
 *
 * @category transforming
 * @since 4.0.0
 */
export function decodeTo<To extends Top>(to: To): <From extends Top>(from: From) => compose<To, From>
export function decodeTo<To extends Top, From extends Top, RD = never, RE = never>(
  to: To,
  transformation: {
    readonly decode: Getter.Getter<NoInfer<To["Encoded"]>, NoInfer<From["Type"]>, RD>
    readonly encode: Getter.Getter<NoInfer<From["Type"]>, NoInfer<To["Encoded"]>, RE>
  }
): (from: From) => decodeTo<To, From, RD, RE>
export function decodeTo<To extends Top, From extends Top, RD = never, RE = never>(
  to: To,
  transformation?: {
    readonly decode: Getter.Getter<To["Encoded"], From["Type"], RD>
    readonly encode: Getter.Getter<From["Type"], To["Encoded"], RE>
  } | undefined
) {
  return (from: From) => {
    return make(
      AST.decodeTo(
        from.ast,
        to.ast,
        transformation ? Transformation.make(transformation) : Transformation.passthrough()
      ),
      {
        from,
        to
      }
    )
  }
}

/**
 * Applies a transformation to a schema, creating a new schema with the same type but transformed encoding/decoding.
 *
 * **Details**
 *
 * This is a curried function: call it with a transformation object, then call the returned function with a schema.
 * The resulting schema has `Type = S["Type"]` and `Encoded = S["Encoded"]`, with the transformation applied during
 * encoding and decoding operations.
 *
 * Key guarantees:
 * - Resulting schema has `Type = S["Type"]` and `Encoded = S["Encoded"]`
 * - Uses `toType(self)` as the target schema internally (creates a schema where both Type and Encoded are `S["Type"]`)
 * - Combines decoding/encoding services from the source schema and transformation
 * - Transformation `decode` maps `S["Type"]` → `S["Type"]` (used during encoding)
 * - Transformation `encode` maps `S["Type"]` → `S["Type"]` (used during decoding)
 *
 * Common mistakes:
 * - **Currying**: This is curried - must use pipe: `schema.pipe(Schema.decode(transformation))`
 * - **Transformation direction**: `decode` and `encode` both operate on `S["Type"]` (same type, different values)
 * - **Service dependencies**: Resulting schema requires services from the source schema and transformation; use `Schema.provideService` if needed
 *
 * **Example** (Trimming string values during encoding/decoding)
 *
 * ```ts
 * import { Schema, SchemaGetter } from "effect"
 *
 * const Trimmed = Schema.String.pipe(
 *   Schema.decode({
 *     decode: SchemaGetter.transform((s) => s.trim()),
 *     encode: SchemaGetter.transform((s) => s.trim())
 *   })
 * )
 *
 * const result = Schema.decodeUnknownSync(Trimmed)("  hello  ")
 * // result: "hello"
 * ```
 *
 * @category transforming
 * @since 3.10.0
 */
export function decode<S extends Top, RD = never, RE = never>(transformation: {
  readonly decode: Getter.Getter<S["Type"], S["Type"], RD>
  readonly encode: Getter.Getter<S["Type"], S["Type"], RE>
}) {
  return (self: S): decodeTo<toType<S>, S, RD, RE> => {
    return self.pipe(decodeTo(toType(self), transformation))
  }
}

/**
 * Reverses a schema transformation so the encoded schema is supplied first.
 *
 * **When to use**
 *
 * Use to define a transformation by naming the encoded schema before the
 * decoded schema.
 *
 * **Details**
 *
 * `encodeTo(to)(from)` is equivalent to `to.pipe(decodeTo(from))`. The `from`
 * schema acts as the target decoded schema and `to` acts as the encoded source.
 *
 * **Example** (Encode a number back to string)
 *
 * ```ts
 * import { Schema, SchemaGetter } from "effect"
 *
 * const NumberFromString = Schema.Number.pipe(
 *   Schema.encodeTo(Schema.String, {
 *     decode: SchemaGetter.transform((s: string) => Number(s)),
 *     encode: SchemaGetter.transform((n: number) => String(n))
 *   })
 * )
 * ```
 *
 * @category transforming
 * @since 4.0.0
 */
export function encodeTo<To extends Top>(
  to: To
): <From extends Top>(from: From) => decodeTo<From, To>
export function encodeTo<To extends Top, From extends Top, RD = never, RE = never>(
  to: To,
  transformation: {
    readonly decode: Getter.Getter<NoInfer<From["Encoded"]>, NoInfer<To["Type"]>, RD>
    readonly encode: Getter.Getter<NoInfer<To["Type"]>, NoInfer<From["Encoded"]>, RE>
  }
): (from: From) => decodeTo<From, To, RD, RE>
export function encodeTo<To extends Top, From extends Top, RD = never, RE = never>(
  to: To,
  transformation?: {
    readonly decode: Getter.Getter<From["Encoded"], To["Type"], RD>
    readonly encode: Getter.Getter<To["Type"], From["Encoded"], RE>
  }
) {
  return (from: From): decodeTo<From, To, RD, RE> => {
    return transformation ?
      to.pipe(decodeTo(from, transformation)) :
      to.pipe(decodeTo(from))
  }
}

/**
 * Applies a transformation to a schema's encoded type, creating a new schema where encoding/decoding
 * operate on `S["Encoded"]` rather than `S["Type"]`.
 *
 * **Details**
 *
 * The `decode` getter maps `S["Encoded"]` → `S["Encoded"]` (applied during decoding),
 * and the `encode` getter maps `S["Encoded"]` → `S["Encoded"]` (applied during encoding).
 *
 * **Example** (Upper-casing encoded strings)
 *
 * ```ts
 * import { Schema, SchemaGetter } from "effect"
 *
 * const UpperFromLower = Schema.String.pipe(
 *   Schema.encode({
 *     decode: SchemaGetter.transform((s: string) => s.toLowerCase()),
 *     encode: SchemaGetter.transform((s: string) => s.toUpperCase())
 *   })
 * )
 * ```
 *
 * @category transforming
 * @since 3.10.0
 */
export function encode<S extends Top, RD = never, RE = never>(transformation: {
  readonly decode: Getter.Getter<S["Encoded"], S["Encoded"], RD>
  readonly encode: Getter.Getter<S["Encoded"], S["Encoded"], RE>
}) {
  return (self: S): decodeTo<S, toEncoded<S>, RD, RE> => {
    return toEncoded(self).pipe(decodeTo(self, transformation))
  }
}

/**
 * Constraint used to ensure a schema field does not already have a constructor default.
 *
 * **Details**
 *
 * Only schemas that satisfy this constraint can be passed to {@link withConstructorDefault}.
 *
 * @category models
 * @since 4.0.0
 */
export interface WithoutConstructorDefault {
  readonly "~type.constructor.default": "no-default"
}

/**
 * Schema type returned by `withConstructorDefault` after attaching a default used
 * by constructor helpers.
 *
 * **Details**
 *
 * The default affects `make` and related constructor helpers only; decoding and
 * encoding still use the original schema behavior. The schema is marked as
 * already having a constructor default so another constructor default cannot be
 * added.
 *
 * @see {@link withConstructorDefault} for the constructor
 * @category constructors
 * @since 3.10.0
 */
export interface withConstructorDefault<S extends Top & WithoutConstructorDefault> extends
  Bottom<
    S["Type"],
    S["Encoded"],
    S["DecodingServices"],
    S["EncodingServices"],
    S["ast"],
    withConstructorDefault<S>,
    S["~type.make.in"],
    S["Iso"],
    S["~type.parameters"],
    S["~type.make"],
    S["~type.mutability"],
    S["~type.optionality"],
    "with-default",
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{
  readonly schema: S
}

/**
 * Attaches a constructor default value to a schema field.
 *
 * **Details**
 *
 * Constructor defaults are applied only during `make*`, not during decoding or
 * encoding.
 *
 * **Example** (Optional field with a static default)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 *
 * const MySchema = Schema.Struct({
 *   name: Schema.String.pipe(
 *     Schema.optionalKey,
 *     Schema.withConstructorDefault(Effect.succeed("anonymous"))
 *   )
 * })
 *
 * const value = MySchema.make({})
 * // value: { name: "anonymous" }
 * ```
 *
 * @category constructors
 * @since 3.10.0
 */
export function withConstructorDefault<S extends Top & WithoutConstructorDefault>(
  // `S["~type.make.in"]` instead of `S["Type"]` is intentional here because
  // it makes easier to define the default value if there are nested defaults
  defaultValue: Effect.Effect<S["~type.make.in"], SchemaError>
) {
  return (schema: S): withConstructorDefault<S> =>
    make(AST.withConstructorDefault(schema.ast, Effect.mapErrorEager(defaultValue, (e) => e.issue)), { schema })
}

/**
 * The type produced by {@link withDecodingDefaultKey}: a schema whose `Encoded`
 * side is `optionalKey` and that fills in a default `Encoded` value during decoding.
 *
 * @see {@link withDecodingDefaultKey} for the constructor
 * @category decoding
 * @since 4.0.0
 */
export interface withDecodingDefaultKey<S extends Top, R = never> extends decodeTo<S, optionalKey<toEncoded<S>>, R> {
  readonly "Rebuild": withDecodingDefaultKey<S, R>
}

/**
 * Options for {@link withDecodingDefaultKey} and {@link withDecodingDefault}.
 *
 * **Details**
 *
 * - `encodingStrategy`:
 *   - `"passthrough"` (default): pass the value through during encoding
 *   - `"omit"`: omit the key from the encoded output
 *
 * @category models
 * @since 4.0.0
 */
export type DecodingDefaultOptions = {
  readonly encodingStrategy?: "omit" | "passthrough" | undefined
}

/**
 * Makes a struct key optional on the `Encoded` side and provides a default
 * `Encoded` value when the key is missing during decoding.
 *
 * **Details**
 *
 * The key uses `optionalKey` on the encoded side, so it may be absent from the
 * input object but **not** `undefined`. The default value is specified in terms
 * of the `Encoded` type (before any decoding transformations).
 *
 * Options:
 *
 * - `encodingStrategy`:
 *   - `"passthrough"` (default): include the value in the encoded output.
 *   - `"omit"`: omit the key from the encoded output.
 *
 * **Example** (Default for a missing struct key)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 *
 * const MySchema = Schema.Struct({
 *   name: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("anonymous")))
 * })
 *
 * const result = Schema.decodeUnknownSync(MySchema)({})
 * // result: { name: "anonymous" }
 * ```
 *
 * @see {@link withDecodingDefault} for the value-level variant (key absent **or** `undefined`)
 * @see {@link withDecodingDefaultTypeKey} for the variant where the default is a `Type` value
 * @category decoding
 * @since 4.0.0
 */
export function withDecodingDefaultKey<S extends Top, R = never>(
  defaultValue: Effect.Effect<S["Encoded"], SchemaError, R>,
  options?: DecodingDefaultOptions
) {
  const encode = options?.encodingStrategy === "omit" ? Getter.omit() : Getter.passthrough()
  return (self: S): withDecodingDefaultKey<S, R> => {
    return optionalKey(toEncoded(self)).pipe(decodeTo(self, {
      decode: Getter.withDefault(Effect.mapErrorEager(defaultValue, (e) => e.issue)),
      encode
    }))
  }
}

/**
 * The type produced by {@link withDecodingDefaultTypeKey}: a schema whose
 * `Encoded` side is `optionalKey` and that fills in a default `Type` value
 * during decoding.
 *
 * @see {@link withDecodingDefaultTypeKey} for the constructor
 * @category decoding
 * @since 4.0.0
 */
export interface withDecodingDefaultTypeKey<S extends Top, R = never>
  extends decodeTo<withDecodingDefaultKey<toType<S>, R>, optionalKey<S>>
{
  readonly "Rebuild": withDecodingDefaultTypeKey<S, R>
}

/**
 * Makes a struct key optional on the `Encoded` side (`optionalKey`, so the
 * key may be absent but **not** `undefined`) and provides a default `Type`
 * value when the key is missing during decoding.
 *
 * **Details**
 *
 * Unlike {@link withDecodingDefaultKey}, the default value is specified in
 * terms of the `Type` (decoded) representation, so it does not need to go
 * through the decoding transformation.
 *
 * Options:
 *
 * - `encodingStrategy`:
 *   - `"passthrough"` (default): include the value in the encoded output.
 *   - `"omit"`: omit the key from the encoded output.
 *
 * @see {@link withDecodingDefaultKey} for the variant where the default is an `Encoded` value
 * @see {@link withDecodingDefaultType} for the value-level variant
 * @category decoding
 * @since 4.0.0
 */
export function withDecodingDefaultTypeKey<S extends Top, R = never>(
  defaultValue: Effect.Effect<S["Type"], SchemaError, R>,
  options?: DecodingDefaultOptions
) {
  return (self: S): withDecodingDefaultTypeKey<S, R> => {
    return toType(self).pipe(
      withDecodingDefaultKey<toType<S>, R>(defaultValue, options),
      encodeTo(optionalKey(self))
    )
  }
}

/**
 * The type produced by {@link withDecodingDefault}: a schema whose `Encoded`
 * side is `optional` and that fills in a default `Encoded` value during decoding.
 *
 * @see {@link withDecodingDefault} for the constructor
 * @category decoding
 * @since 3.10.0
 */
export interface withDecodingDefault<S extends Top, R = never> extends decodeTo<S, optional<toEncoded<S>>, R> {
  readonly "Rebuild": withDecodingDefault<S, R>
}

/**
 * Wraps the `Encoded` side with `optional` (key absent **or** `undefined`)
 * and provides a default `Encoded` value when the field is missing or
 * `undefined` during decoding.
 *
 * **Details**
 *
 * The default value is specified in terms of the `Encoded` type (before any
 * decoding transformations).
 *
 * Options:
 *
 * - `encodingStrategy`:
 *   - `"passthrough"` (default): include the value in the encoded output.
 *   - `"omit"`: omit the key from the encoded output.
 *
 * **Example** (Default for an optional field value)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 *
 * const MySchema = Schema.Struct({
 *   name: Schema.String.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("anonymous")))
 * })
 *
 * const result = Schema.decodeUnknownSync(MySchema)({ name: undefined })
 * // result: { name: "anonymous" }
 * ```
 *
 * @see {@link withDecodingDefaultKey} for the key-level variant (key absent only, not `undefined`)
 * @see {@link withDecodingDefaultType} for the variant where the default is a `Type` value
 * @category decoding
 * @since 3.10.0
 */
export function withDecodingDefault<S extends Top, R = never>(
  defaultValue: Effect.Effect<S["Encoded"], SchemaError, R>,
  options?: DecodingDefaultOptions
) {
  const encode = options?.encodingStrategy === "omit" ? Getter.omit() : Getter.passthrough()
  return (self: S): withDecodingDefault<S, R> => {
    return optional(toEncoded(self)).pipe(decodeTo(self, {
      decode: Getter.withDefault(Effect.mapErrorEager(defaultValue, (e) => e.issue)),
      encode
    }))
  }
}

/**
 * The type produced by {@link withDecodingDefaultType}: a schema whose
 * `Encoded` side is `optional` and that fills in a default `Type` value during
 * decoding.
 *
 * @see {@link withDecodingDefaultType} for the constructor
 * @category decoding
 * @since 4.0.0
 */
export interface withDecodingDefaultType<S extends Top, R = never>
  extends decodeTo<withDecodingDefault<toType<S>, R>, optional<S>>
{
  readonly "Rebuild": withDecodingDefaultType<S, R>
}

/**
 * Wraps the `Encoded` side with `optional` (key absent **or** `undefined`)
 * and provides a default `Type` value when the field is missing or
 * `undefined` during decoding.
 *
 * **Details**
 *
 * Unlike {@link withDecodingDefault}, the default value is specified in terms
 * of the `Type` (decoded) representation, so it does not need to go through
 * the decoding transformation.
 *
 * Options:
 *
 * - `encodingStrategy`:
 *   - `"passthrough"` (default): include the value in the encoded output.
 *   - `"omit"`: omit the key from the encoded output.
 *
 * @see {@link withDecodingDefault} for the variant where the default is an `Encoded` value
 * @see {@link withDecodingDefaultTypeKey} for the key-level variant
 * @category decoding
 * @since 4.0.0
 */
export function withDecodingDefaultType<S extends Top, R = never>(
  defaultValue: Effect.Effect<S["Type"], SchemaError, R>,
  options?: DecodingDefaultOptions
) {
  return (self: S): withDecodingDefaultType<S, R> => {
    return toType(self).pipe(
      withDecodingDefault<toType<S>, R>(defaultValue, options),
      encodeTo(optional(self))
    )
  }
}

/**
 * The type produced by {@link tag} — a literal schema with a constructor default.
 *
 * **Details**
 *
 * Used as the type of the `_tag` field in {@link TaggedStruct} and related helpers.
 *
 * @see {@link tag} for the constructor
 * @category constructors
 * @since 3.10.0
 */
export interface tag<Tag extends AST.LiteralValue> extends withConstructorDefault<Literal<Tag>> {}

/**
 * Combines a {@link Literal} schema with {@link withConstructorDefault}, making it ideal
 * for discriminator fields in tagged unions. When constructing via `make`, the
 * `_tag` field can be omitted and will be filled automatically.
 *
 * **Example** (Discriminated union tag)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const A = Schema.Struct({ _tag: Schema.tag("A"), value: Schema.Number })
 *
 * // _tag is optional in make, auto-filled to "A"
 * const a = A.make({ value: 42 })
 * // a: { _tag: "A", value: 42 }
 * ```
 *
 * @see {@link tagDefaultOmit} to also omit the tag during encoding
 * @see {@link TaggedStruct} for a shorthand that adds `_tag` automatically
 * @category constructors
 * @since 3.10.0
 */
export function tag<Tag extends AST.LiteralValue>(literal: Tag): tag<Tag> {
  return Literal(literal).pipe(withConstructorDefault(Effect.succeed(literal)))
}

/**
 * Creates a literal `_tag` schema that is omitted from encoded output.
 *
 * **When to use**
 *
 * Use to decode data that omits the discriminator field while still constructing
 * values with a `_tag` for tagged union matching.
 *
 * **Details**
 *
 * The tag is filled during decoding and construction, like {@link tag}, but is
 * omitted when encoding.
 *
 * **Example** (Tag omitted during encoding)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const A = Schema.Struct({
 *   _tag: Schema.tagDefaultOmit("A"),
 *   value: Schema.Number
 * })
 *
 * // Encode strips the _tag field
 * const encoded = Schema.encodeUnknownSync(A)({ _tag: "A", value: 1 })
 * // encoded: { value: 1 }
 * ```
 *
 * @see {@link tag} for the variant that keeps the tag during encoding
 * @category constructors
 * @since 4.0.0
 */
export function tagDefaultOmit<Tag extends AST.LiteralValue>(literal: Tag) {
  return tag(literal).pipe(withDecodingDefaultKey(Effect.succeed(literal), { encodingStrategy: "omit" }))
}

/**
 * The type produced by {@link TaggedStruct} — a {@link Struct} with an extra `_tag` field of type {@link tag}.
 *
 * @see {@link TaggedStruct} for the constructor
 * @category models
 * @since 3.10.0
 */
export type TaggedStruct<Tag extends AST.LiteralValue, Fields extends Struct.Fields> = Struct<
  Simplify<{ readonly _tag: tag<Tag> } & Fields>
>

/**
 * Creates a struct schema with an automatically populated `_tag` field.
 *
 * **When to use**
 *
 * Use to define a tagged union case from a literal tag and a set of fields.
 *
 * **Details**
 *
 * When using the `make` method, the `_tag` field is optional and will be
 * added automatically. However, when decoding or encoding, the `_tag` field
 * must be present in the input.
 *
 * **Example** (Tagged struct as a shorthand for a struct with a `_tag` field)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * // Defines a struct with a fixed `_tag` field
 * const tagged = Schema.TaggedStruct("A", {
 *   a: Schema.String
 * })
 *
 * // This is the same as writing:
 * const equivalent = Schema.Struct({
 *   _tag: Schema.tag("A"),
 *   a: Schema.String
 * })
 * ```
 *
 * **Example** (Accessing the literal value of the tag)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const tagged = Schema.TaggedStruct("A", {
 *   a: Schema.String
 * })
 *
 * // literal: "A"
 * const literal = tagged.fields._tag.schema.literal
 * ```
 *
 * @category constructors
 * @since 3.10.0
 */
export function TaggedStruct<const Tag extends AST.LiteralValue, const Fields extends Struct.Fields>(
  value: Tag,
  fields: Fields
): TaggedStruct<Tag, Fields> {
  return Struct({ _tag: tag(value), ...fields })
}

/**
 * Recursively flatten any nested Schema.Union members into a single tuple of leaf schemas.
 */
type Flatten<Schemas> = Schemas extends readonly [infer Head, ...infer Tail]
  ? Head extends Union<infer Inner> ? [...Flatten<Inner>, ...Flatten<Tail>]
  : [Head, ...Flatten<Tail>]
  : []

type TaggedUnionUtils<
  Tag extends PropertyKey,
  Members extends ReadonlyArray<Top & { readonly Type: { readonly [K in Tag]: PropertyKey } }>,
  Flattened extends ReadonlyArray<Top & { readonly Type: { readonly [K in Tag]: PropertyKey } }> = Flatten<
    Members
  >
> = {
  readonly cases: Simplify<{ [M in Flattened[number] as M["Type"][Tag]]: M }>
  readonly isAnyOf: <const Keys>(
    keys: ReadonlyArray<Keys>
  ) => (value: Members[number]["Type"]) => value is Extract<Members[number]["Type"], { _tag: Keys }>
  readonly guards: { [M in Flattened[number] as M["Type"][Tag]]: (u: unknown) => u is M["Type"] }
  readonly match: {
    <
      Cases extends { [M in Flattened[number] as M["Type"][Tag]]: (value: M["Type"]) => any }
    >(
      value: Members[number]["Type"],
      cases: Cases
    ): Cases[keyof Cases] extends (value: any) => infer R ? Unify<R>
      : never
    <
      Cases extends { [M in Flattened[number] as M["Type"][Tag]]: (value: M["Type"]) => any }
    >(
      cases: Cases
    ): (value: Members[number]["Type"]) => Cases[keyof Cases] extends (value: any) => infer R ? Unify<R>
      : never
  }
}

/**
 * The type produced by {@link toTaggedUnion} — a {@link Union} augmented with `cases`, `guards`, `isAnyOf`, and `match` utilities.
 *
 * @see {@link toTaggedUnion} for the constructor
 * @category combinators
 * @since 4.0.0
 */
export type toTaggedUnion<
  Tag extends PropertyKey,
  Members extends ReadonlyArray<Top & { readonly Type: { readonly [K in Tag]: PropertyKey } }>
> = Union<Members> & TaggedUnionUtils<Tag, Members>

/**
 * Augments an existing {@link Union} of tagged structs with utility methods keyed by the discriminant field.
 *
 * **Example** (Adding tagged-union utilities to an existing union)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const A = Schema.TaggedStruct("A", { value: Schema.Number })
 * const B = Schema.TaggedStruct("B", { name: Schema.String })
 *
 * const MyUnion = Schema.Union([A, B]).pipe(Schema.toTaggedUnion("_tag"))
 *
 * // Pattern-match on the union
 * const result = MyUnion.match({ _tag: "A", value: 1 }, {
 *   A: (a) => `number: ${a.value}`,
 *   B: (b) => `name: ${b.name}`
 * })
 * ```
 *
 * @see {@link TaggedUnion} for a shorthand that builds the union from scratch
 * @category combinators
 * @since 4.0.0
 */
export function toTaggedUnion<const Tag extends PropertyKey>(tag: Tag) {
  return <const Members extends ReadonlyArray<Top & { readonly Type: { readonly [K in Tag]: PropertyKey } }>>(
    self: Union<Members>
  ): toTaggedUnion<Tag, Members> => {
    const cases: Record<PropertyKey, unknown> = {}
    const guards: Record<PropertyKey, (u: unknown) => boolean> = {}
    const isAnyOf = (keys: ReadonlyArray<PropertyKey>) => (value: Members[number]["Type"]) => keys.includes(value[tag])

    walk(self)

    return Object.assign(self, { cases, isAnyOf, guards, match }) as any

    function walk(schema: Top) {
      const ast = schema.ast

      if (
        AST.isUnion(ast) && "members" in schema && globalThis.Array.isArray(schema.members) &&
        schema.members.every(isSchema)
      ) {
        return schema.members.forEach(walk)
      }

      const sentinels = AST.collectSentinels(ast)
      if (sentinels.length > 0) {
        const literal = sentinels.find((s) => s.key === tag)?.literal
        if (Predicate.isPropertyKey(literal)) {
          cases[literal] = schema
          guards[literal] = is(toType(schema))
          return
        }
      }

      throw new globalThis.Error("No literal or unique symbol found")
    }

    function match() {
      if (arguments.length === 1) {
        const cases = arguments[0]
        return function(value: any) {
          return cases[value[tag]](value)
        }
      }
      const value = arguments[0]
      const cases = arguments[1]
      return cases[value[tag]](value)
    }
  }
}

/**
 * A union schema that exposes `cases`, `guards`, `isAnyOf`, and `match` utilities keyed by the `_tag` discriminant.
 * Produced by {@link TaggedUnion}.
 *
 * @see {@link TaggedUnion} for the constructor
 * @category models
 * @since 4.0.0
 */
export interface TaggedUnion<Cases extends Record<string, Top>> extends
  Bottom<
    { [K in keyof Cases]: Cases[K]["Type"] }[keyof Cases],
    { [K in keyof Cases]: Cases[K]["Encoded"] }[keyof Cases],
    { [K in keyof Cases]: Cases[K]["DecodingServices"] }[keyof Cases],
    { [K in keyof Cases]: Cases[K]["EncodingServices"] }[keyof Cases],
    AST.Union<AST.Objects>,
    TaggedUnion<Cases>,
    { [K in keyof Cases]: Cases[K]["~type.make"] }[keyof Cases]
  >
{
  readonly cases: Cases
  readonly isAnyOf: <const Keys>(
    keys: ReadonlyArray<Keys>
  ) => (value: Cases[keyof Cases]["Type"]) => value is Extract<Cases[keyof Cases]["Type"], { _tag: Keys }>
  readonly guards: { [K in keyof Cases]: (u: unknown) => u is Cases[K]["Type"] }
  readonly match: {
    <Output>(
      cases: { [K in keyof Cases]: (value: Cases[K]["Type"]) => Output }
    ): (value: Cases[keyof Cases]["Type"]) => Output
    <Output>(
      value: Cases[keyof Cases]["Type"],
      cases: { [K in keyof Cases]: (value: Cases[K]["Type"]) => Output }
    ): Output
  }
}

/**
 * Builds a discriminated union from a record of field sets, one per variant.
 * Each key becomes the `_tag` literal and the value is passed to {@link TaggedStruct}.
 * The result includes `cases`, `guards`, `isAnyOf`, and `match` utilities.
 *
 * **Example** (Discriminated union with pattern matching)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const Shape = Schema.TaggedUnion({
 *   Circle: { radius: Schema.Number },
 *   Rectangle: { width: Schema.Number, height: Schema.Number }
 * })
 *
 * // Pattern-match on a decoded value
 * const area = Shape.match({ _tag: "Circle", radius: 5 }, {
 *   Circle: (c) => Math.PI * c.radius ** 2,
 *   Rectangle: (r) => r.width * r.height
 * })
 * ```
 *
 * @see {@link toTaggedUnion} to augment an existing union instead
 * @category constructors
 * @since 4.0.0
 */
export function TaggedUnion<const CasesByTag extends Record<string, Struct.Fields>>(
  casesByTag: CasesByTag
): TaggedUnion<{ readonly [K in keyof CasesByTag & string]: TaggedStruct<K, CasesByTag[K]> }> {
  const cases: any = {}
  const members: any = []
  for (const key of Object.keys(casesByTag)) {
    members.push(cases[key] = TaggedStruct(key, casesByTag[key]))
  }
  const union = Union(members)
  const { guards, isAnyOf, match } = toTaggedUnion("_tag")(union)
  return make(union.ast, { cases, isAnyOf, guards, match })
}

/**
 * The interface type for schemas created by {@link Opaque}.
 * Carries the same encoded/decoded shape as `S` but replaces `Type` with `Self & Brand`,
 * making the decoded value nominally distinct.
 *
 * @see {@link Opaque} for the constructor
 * @category models
 * @since 4.0.0
 */
export interface Opaque<Self, S extends Top, Brand> extends
  Bottom<
    Self,
    S["Encoded"],
    S["DecodingServices"],
    S["EncodingServices"],
    S["ast"],
    S["Rebuild"],
    S["~type.make.in"],
    S["Iso"],
    S["~type.parameters"],
    S["~type.make"],
    S["~type.mutability"],
    S["~type.optionality"],
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{
  new(_: never): S["Type"] & Brand
}

/**
 * Wraps a struct schema so that its decoded `Type` becomes a nominally distinct type `Self`.
 * Useful for creating opaque types that are structurally identical to a base struct
 * but type-incompatible with it.
 *
 * **Example** (Opaque struct)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * class Person extends Schema.Opaque<Person>()(
 *   Schema.Struct({
 *     name: Schema.String
 *   })
 * ) {}
 *
 * // Decoded value is Person, not { name: string }
 * const person = Schema.decodeUnknownSync(Person)({ name: "Alice" })
 * // person: Person
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export function Opaque<Self, Brand = {}>() {
  return <S extends Top>(schema: S): Opaque<Self, S, Brand> & Omit<S, keyof Top> => {
    // oxlint-disable-next-line @typescript-eslint/no-extraneous-class
    class Opaque {}
    return Object.setPrototypeOf(Opaque, schema)
  }
}

/**
 * The type produced by {@link instanceOf} — a declaration schema that validates class instances.
 *
 * @see {@link instanceOf} for the constructor
 * @category models
 * @since 3.10.0
 */
export interface instanceOf<T, Iso = T> extends declare<T, Iso> {
  readonly "Rebuild": instanceOf<T, Iso>
}

/**
 * Creates a schema that validates values using `instanceof`.
 * Decoding and encoding pass the value through unchanged.
 *
 * **Example** (Schema for a built-in class)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const DateSchema = Schema.instanceOf(Date)
 *
 * const decoded = Schema.decodeUnknownSync(DateSchema)(new Date("2024-01-01"))
 * // decoded: Date
 * ```
 *
 * @category constructors
 * @since 3.10.0
 */
export function instanceOf<C extends abstract new(...args: any) => any, Iso = InstanceType<C>>(
  constructor: C,
  annotations?: Annotations.Declaration<InstanceType<C>> | undefined
): instanceOf<InstanceType<C>, Iso> {
  return declare((u): u is InstanceType<C> => u instanceof constructor, annotations)
}

/**
 * Constructs an `AST.Link` that describes how a value of type `T` encodes to and decodes from a `To` schema.
 * Used when building low-level AST transformations that bridge two schema types.
 *
 * @category transforming
 * @since 4.0.0
 */
export function link<T>() {
  return <To extends Top>(
    encodeTo: To,
    transformation: {
      readonly decode: Getter.Getter<T, NoInfer<To["Type"]>>
      readonly encode: Getter.Getter<NoInfer<To["Type"]>, T>
    }
  ): AST.Link => {
    return new AST.Link(encodeTo.ast, Transformation.make(transformation))
  }
}

// -----------------------------------------------------------------------------
// Checks
// -----------------------------------------------------------------------------

/**
 * Creates a custom validation filter from a predicate function.
 *
 * **Details**
 *
 * The predicate receives the decoded input value, the schema AST, and parse
 * options, and returns a `FilterOutput`. Non-success outputs are normalized into
 * schema issues. The `annotations` parameter annotates the filter itself; with
 * the default formatter, failures use `message` first, `expected` second, and
 * `<filter>` when neither is provided.
 *
 * When `abort` is `true`, parsing stops after this filter fails instead of
 * collecting later check failures.
 *
 * **Example** (Failure at a nested path)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.Struct({ password: Schema.String, confirmPassword: Schema.String }).check(
 *   Schema.makeFilter((o) =>
 *     o.password === o.confirmPassword
 *       ? undefined
 *       : { path: ["password"], issue: "password and confirmPassword must match" }
 *   )
 * )
 *
 * console.log(String(Schema.decodeUnknownExit(schema)({ password: "123456", confirmPassword: "1234567" })))
 * // Failure(Cause([Fail(SchemaError: password and confirmPassword must match
 * //   at ["password"])]))
 * ```
 *
 * **Example** (Reporting multiple failures at once)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.Struct({ a: Schema.Finite, b: Schema.Finite, c: Schema.Finite }).check(
 *   Schema.makeFilter((o) => {
 *     const issues: Array<Schema.FilterIssue> = []
 *     if (o.a > 0) {
 *       if (o.b <= 0) issues.push({ path: ["b"], issue: "b must be greater than 0" })
 *       if (o.c <= 0) issues.push({ path: ["c"], issue: "c must be greater than 0" })
 *     }
 *     return issues
 *   })
 * )
 *
 * console.log(String(Schema.decodeUnknownExit(schema)({ a: 1, b: 0, c: 0 })))
 * // Failure(Cause([Fail(SchemaError: b must be greater than 0
 * //   at ["b"]
 * // c must be greater than 0
 * //   at ["c"])]))
 * ```
 *
 * @category Checks Constructors
 * @since 4.0.0
 */
export const makeFilter: <T>(
  filter: (input: T, ast: AST.AST, options: AST.ParseOptions) => FilterOutput,
  annotations?: Annotations.Filter | undefined,
  abort?: boolean
) => AST.Filter<T> = AST.makeFilter

/**
 * A single failure reported by a filter predicate. Used as the element type
 * of the array arm of {@link FilterOutput}, and also accepted on its own.
 *
 * **Details**
 *
 * - `string`: failure with that string as the message. Produces an
 *   {@link Issue.InvalidValue} wrapping the input, with the string used as
 *   the issue's `message` annotation.
 * - {@link Issue.Issue}: a fully-formed issue, returned as-is.
 * - `{ path, issue }`: failure attached to a nested path. `issue` is either
 *   a `string` (wrapped in an {@link Issue.InvalidValue}) or a full
 *   {@link Issue.Issue}; the result is wrapped in an {@link Issue.Pointer}
 *   at the given `path`.
 *
 * @category models
 * @since 3.10.0
 */
export type FilterIssue = string | Issue.Issue | {
  readonly path: ReadonlyArray<PropertyKey>
  readonly issue: string | Issue.Issue
}

/**
 * The value a filter predicate (see {@link makeFilter}) may return.
 *
 * **Details**
 *
 * Each shape is normalized into an {@link Issue.Issue} (or `undefined` for
 * success) before being attached to the parse result:
 *
 * - `undefined`: success. The input satisfies the filter.
 * - `true`: success. Equivalent to `undefined`, useful when the predicate is
 *   a plain boolean expression.
 * - `false`: generic failure. Produces an {@link Issue.InvalidValue} wrapping
 *   the input, with no custom message.
 * - {@link FilterIssue}: a single failure. See {@link FilterIssue} for the
 *   shapes (`string`, {@link Issue.Issue}, or `{ path, issue }`).
 * - `ReadonlyArray<FilterIssue>`: several failures reported together. An
 *   empty array is treated as success; a single-element array is equivalent
 *   to returning that element directly; otherwise the entries are grouped
 *   into an {@link Issue.Composite}.
 *
 * @category models
 * @since 3.10.0
 */
export type FilterOutput =
  | undefined
  | boolean
  | FilterIssue
  | ReadonlyArray<FilterIssue>

/**
 * Groups multiple checks into a single {@link AST.FilterGroup}, applying
 * optional shared annotations to the group as a whole.
 *
 * @category Checks Constructors
 * @since 4.0.0
 */
export function makeFilterGroup<T>(
  checks: readonly [AST.Check<T>, ...Array<AST.Check<T>>],
  annotations: Annotations.Filter | undefined = undefined
): AST.FilterGroup<T> {
  return new AST.FilterGroup(checks, annotations)
}

const TRIMMED_PATTERN = "^\\S[\\s\\S]*\\S$|^\\S$|^$"

/**
 * Validates that a string has no leading or trailing whitespace.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to a `pattern` constraint in JSON Schema that
 * matches strings without leading or trailing whitespace.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `patterns`
 * constraint to ensure generated strings match the trimmed pattern.
 *
 * @category String checks
 * @since 4.0.0
 */
export function isTrimmed(annotations?: Annotations.Filter) {
  return makeFilter(
    (s: string) => s.trim() === s,
    {
      expected: "a string with no leading or trailing whitespace",
      meta: {
        _tag: "isTrimmed",
        regExp: new globalThis.RegExp(TRIMMED_PATTERN)
      },
      toArbitraryConstraint: {
        string: {
          patterns: [TRIMMED_PATTERN]
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates that a string matches the specified regular expression pattern.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `pattern` constraint in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `patterns`
 * constraint to ensure generated strings match the specified RegExp pattern.
 *
 * @category String checks
 * @since 4.0.0
 */
export const isPattern: (regExp: globalThis.RegExp, annotations?: Annotations.Filter) => AST.Filter<string> =
  AST.isPattern

/**
 * Validates that a string represents a finite number.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to a `pattern` constraint in JSON Schema that matches
 * strings representing finite numbers.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `patterns`
 * constraint to ensure generated strings match the number string pattern.
 *
 * @category String checks
 * @since 4.0.0
 */
export const isStringFinite: (annotations?: Annotations.Filter) => AST.Filter<string> = AST.isStringFinite

/**
 * Validates that a string is a signed base-10 integer literal for Effect's
 * BigInt string encoding.
 *
 * **Details**
 *
 * The check uses the pattern `^-?\d+$`. It does not accept leading `+`, decimal
 * points, exponent notation, separators, or non-decimal inputs such as
 * hexadecimal strings.
 *
 * JSON Schema:
 * This check corresponds to a `pattern` constraint with the same signed
 * base-10 integer pattern.
 *
 * @category String checks
 * @since 4.0.0
 */
export const isStringBigInt: (annotations?: Annotations.Filter) => AST.Filter<string> = AST.isStringBigInt

/**
 * Validates that a string has the `Symbol(description)` format used by Effect's
 * symbol string encoding.
 *
 * **Details**
 *
 * The check uses the pattern `^Symbol\((.*)\)$`. It is not a general test for
 * whether a string can be passed to JavaScript's `Symbol()` function.
 *
 * @category String checks
 * @since 4.0.0
 */
export const isStringSymbol: (annotations?: Annotations.Filter) => AST.Filter<string> = AST.isStringSymbol

/**
 * Returns a RegExp for validating an RFC 4122 UUID.
 *
 * Optionally specify a version 1-8. If no version is specified (`undefined`), all versions are supported.
 */
const getUUIDRegExp = (version?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8): globalThis.RegExp => {
  if (version) {
    return new globalThis.RegExp(
      `^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`
    )
  }
  return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000)$/
}

/**
 * Validates that a string is a valid Universally Unique Identifier (UUID).
 * Optionally specify a version (1-8) to validate against a specific UUID version.
 * If no version is specified (`undefined`), all versions are supported.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to a `pattern` constraint in JSON Schema that matches
 * UUID format, and includes a `format: "uuid"` annotation.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `patterns`
 * constraint to ensure generated strings match the UUID pattern.
 *
 * @category String checks
 * @since 4.0.0
 */
export function isUUID(version?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, annotations?: Annotations.Filter) {
  const regExp = getUUIDRegExp(version)
  return isPattern(
    regExp,
    {
      expected: version ? `a UUID v${version}` : "a UUID",
      meta: {
        _tag: "isUUID",
        regExp,
        version
      },
      ...annotations
    }
  )
}

/**
 * Validates that a string is a valid ULID (Universally Unique Lexicographically
 * Sortable Identifier).
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to a `pattern` constraint in JSON Schema that matches
 * the ULID format.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `patterns`
 * constraint to ensure generated strings match the ULID pattern.
 *
 * @category String checks
 * @since 4.0.0
 */
export function isULID(annotations?: Annotations.Filter) {
  const regExp = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/
  return isPattern(
    regExp,
    {
      meta: {
        _tag: "isULID",
        regExp
      },
      ...annotations
    }
  )
}

/**
 * Validates that a string is valid Base64 encoded data.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to a `pattern` constraint in JSON Schema that matches
 * Base64 format.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `patterns`
 * constraint to ensure generated strings match the Base64 pattern.
 *
 * @category String checks
 * @since 4.0.0
 */
export function isBase64(annotations?: Annotations.Filter) {
  const regExp = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/
  return isPattern(
    regExp,
    {
      expected: "a base64 encoded string",
      meta: {
        _tag: "isBase64",
        regExp
      },
      ...annotations
    }
  )
}

/**
 * Validates that a string is valid Base64URL encoded data (Base64 with URL-safe
 * characters).
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to a `pattern` constraint in JSON Schema that matches
 * Base64URL format.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `patterns`
 * constraint to ensure generated strings match the Base64URL pattern.
 *
 * @category String checks
 * @since 4.0.0
 */
export function isBase64Url(annotations?: Annotations.Filter) {
  const regExp = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/
  return isPattern(
    regExp,
    {
      expected: "a base64url encoded string",
      meta: {
        _tag: "isBase64Url",
        regExp
      },
      ...annotations
    }
  )
}

/**
 * Validates at runtime that a string starts with the specified literal prefix.
 *
 * **Details**
 *
 * Notes:
 * The JSON Schema and arbitrary metadata are built from `^${startsWith}` without
 * escaping regexp metacharacters. If the prefix contains regexp syntax, generated
 * patterns may not be equivalent to the runtime `startsWith` check.
 *
 * @category String checks
 * @since 4.0.0
 */
export function isStartsWith(startsWith: string, annotations?: Annotations.Filter) {
  const formatted = JSON.stringify(startsWith)
  return makeFilter(
    (s: string) => s.startsWith(startsWith),
    {
      expected: `a string starting with ${formatted}`,
      meta: {
        _tag: "isStartsWith",
        startsWith,
        regExp: new globalThis.RegExp(`^${startsWith}`)
      },
      toArbitraryConstraint: {
        string: {
          patterns: [`^${startsWith}`]
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates at runtime that a string ends with the specified literal suffix.
 *
 * **Details**
 *
 * Notes:
 * The JSON Schema and arbitrary metadata are built from `${endsWith}$` without
 * escaping regexp metacharacters. If the suffix contains regexp syntax, generated
 * patterns may not be equivalent to the runtime `endsWith` check.
 *
 * @category String checks
 * @since 4.0.0
 */
export function isEndsWith(endsWith: string, annotations?: Annotations.Filter) {
  const formatted = JSON.stringify(endsWith)
  return makeFilter(
    (s: string) => s.endsWith(endsWith),
    {
      expected: `a string ending with ${formatted}`,
      meta: {
        _tag: "isEndsWith",
        endsWith,
        regExp: new globalThis.RegExp(`${endsWith}$`)
      },
      toArbitraryConstraint: {
        string: {
          patterns: [`${endsWith}$`]
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates at runtime that a string contains the specified literal substring.
 *
 * **Details**
 *
 * Notes:
 * The JSON Schema and arbitrary metadata use the substring as a raw regexp
 * pattern. If the substring contains regexp syntax, generated patterns may not be
 * equivalent to the runtime `includes` check.
 *
 * @category String checks
 * @since 4.0.0
 */
export function isIncludes(includes: string, annotations?: Annotations.Filter) {
  const formatted = JSON.stringify(includes)
  return makeFilter(
    (s: string) => s.includes(includes),
    {
      expected: `a string including ${formatted}`,
      meta: {
        _tag: "isIncludes",
        includes,
        regExp: new globalThis.RegExp(includes)
      },
      toArbitraryConstraint: {
        string: {
          patterns: [includes]
        }
      },
      ...annotations
    }
  )
}

const UPPERCASED_PATTERN = "^[^a-z]*$"

/**
 * Validates that a string is unchanged by JavaScript's `toUpperCase()`.
 *
 * **Details**
 *
 * This accepts empty strings and characters that do not have lowercase forms,
 * such as digits, punctuation, and whitespace. It rejects strings that would
 * change when uppercased.
 *
 * @category String checks
 * @since 4.0.0
 */
export function isUppercased(annotations?: Annotations.Filter) {
  return makeFilter(
    (s: string) => s.toUpperCase() === s,
    {
      expected: "a string with all characters in uppercase",
      meta: {
        _tag: "isUppercased",
        regExp: new globalThis.RegExp(UPPERCASED_PATTERN)
      },
      toArbitraryConstraint: {
        string: {
          patterns: [UPPERCASED_PATTERN]
        }
      },
      ...annotations
    }
  )
}

const LOWERCASED_PATTERN = "^[^A-Z]*$"

/**
 * Validates that a string is unchanged by JavaScript's `toLowerCase()`.
 *
 * **Details**
 *
 * This accepts empty strings and characters that do not have uppercase forms,
 * such as digits, punctuation, and whitespace. It rejects strings that would
 * change when lowercased.
 *
 * @category String checks
 * @since 4.0.0
 */
export function isLowercased(annotations?: Annotations.Filter) {
  return makeFilter(
    (s: string) => s.toLowerCase() === s,
    {
      expected: "a string with all characters in lowercase",
      meta: {
        _tag: "isLowercased",
        regExp: new globalThis.RegExp(LOWERCASED_PATTERN)
      },
      toArbitraryConstraint: {
        string: {
          patterns: [LOWERCASED_PATTERN]
        }
      },
      ...annotations
    }
  )
}

const CAPITALIZED_PATTERN = "^[^a-z]?.*$"

/**
 * Validates that the first character of a string is unchanged by
 * `toUpperCase()`.
 *
 * **Details**
 *
 * Empty strings pass. Strings whose first character has no lowercase form, such
 * as a digit, punctuation mark, or whitespace, also pass.
 *
 * @category String checks
 * @since 4.0.0
 */
export function isCapitalized(annotations?: Annotations.Filter) {
  return makeFilter(
    (s: string) => s.charAt(0).toUpperCase() === s.charAt(0),
    {
      expected: "a string with the first character in uppercase",
      meta: {
        _tag: "isCapitalized",
        regExp: new globalThis.RegExp(CAPITALIZED_PATTERN)
      },
      toArbitraryConstraint: {
        string: {
          patterns: [CAPITALIZED_PATTERN]
        }
      },
      ...annotations
    }
  )
}

const UNCAPITALIZED_PATTERN = "^[^A-Z]?.*$"

/**
 * Validates that the first character of a string is unchanged by
 * `toLowerCase()`.
 *
 * **Details**
 *
 * Empty strings pass. Strings whose first character has no uppercase form, such
 * as a digit, punctuation mark, or whitespace, also pass.
 *
 * @category String checks
 * @since 4.0.0
 */
export function isUncapitalized(annotations?: Annotations.Filter) {
  return makeFilter(
    (s: string) => s.charAt(0).toLowerCase() === s.charAt(0),
    {
      expected: "a string with the first character in lowercase",
      meta: {
        _tag: "isUncapitalized",
        regExp: new globalThis.RegExp(UNCAPITALIZED_PATTERN)
      },
      toArbitraryConstraint: {
        string: {
          patterns: [UNCAPITALIZED_PATTERN]
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates that a number is finite (not `Infinity`, `-Infinity`, or `NaN`).
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check does not have a direct JSON Schema equivalent, but ensures the
 * number is valid and finite.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies `noDefaultInfinity`
 * and `noNaN` constraints to ensure generated numbers are finite.
 *
 * @category Number checks
 * @since 4.0.0
 */
export function isFinite(annotations?: Annotations.Filter) {
  return makeFilter(
    (n: number) => globalThis.Number.isFinite(n),
    {
      expected: "a finite number",
      meta: {
        _tag: "isFinite"
      },
      toArbitraryConstraint: {
        number: {
          noDefaultInfinity: true,
          noNaN: true
        }
      },
      ...annotations
    }
  )
}

/**
 * Creates a greater-than (`>`) check for any ordered type from an
 * `Order.Order` instance.
 *
 * @category Order checks
 * @since 4.0.0
 */
export function makeIsGreaterThan<T>(options: {
  readonly order: Order.Order<T>
  readonly annotate?: ((exclusiveMinimum: T) => Annotations.Filter) | undefined
  readonly formatter?: Formatter<T> | undefined
}) {
  const gt = Order.isGreaterThan(options.order)
  const formatter = options.formatter ?? format
  return (exclusiveMinimum: T, annotations?: Annotations.Filter) => {
    return makeFilter<T>(
      (input) => gt(input, exclusiveMinimum),
      {
        expected: `a value greater than ${formatter(exclusiveMinimum)}`,
        ...options.annotate?.(exclusiveMinimum),
        ...annotations
      }
    )
  }
}

/**
 * Creates a greater-than-or-equal-to (`>=`) check for any ordered type from an
 * `Order.Order` instance.
 *
 * @category Order checks
 * @since 4.0.0
 */
export function makeIsGreaterThanOrEqualTo<T>(options: {
  readonly order: Order.Order<T>
  readonly annotate?: ((exclusiveMinimum: T) => Annotations.Filter) | undefined
  readonly formatter?: Formatter<T> | undefined
}) {
  const gte = Order.isGreaterThanOrEqualTo(options.order)
  const formatter = options.formatter ?? format
  return (minimum: T, annotations?: Annotations.Filter) => {
    return makeFilter<T>(
      (input) => gte(input, minimum),
      {
        expected: `a value greater than or equal to ${formatter(minimum)}`,
        ...options.annotate?.(minimum),
        ...annotations
      }
    )
  }
}

/**
 * Creates a less-than (`<`) check for any ordered type from an `Order.Order`
 * instance.
 *
 * @category Order checks
 * @since 4.0.0
 */
export function makeIsLessThan<T>(options: {
  readonly order: Order.Order<T>
  readonly annotate?: ((exclusiveMaximum: T) => Annotations.Filter) | undefined
  readonly formatter?: Formatter<T> | undefined
}) {
  const lt = Order.isLessThan(options.order)
  const formatter = options.formatter ?? format
  return (exclusiveMaximum: T, annotations?: Annotations.Filter) => {
    return makeFilter<T>(
      (input) => lt(input, exclusiveMaximum),
      {
        expected: `a value less than ${formatter(exclusiveMaximum)}`,
        ...options.annotate?.(exclusiveMaximum),
        ...annotations
      }
    )
  }
}

/**
 * Creates a less-than-or-equal-to (`<=`) check for any ordered type from an
 * `Order.Order` instance.
 *
 * @category Order checks
 * @since 4.0.0
 */
export function makeIsLessThanOrEqualTo<T>(options: {
  readonly order: Order.Order<T>
  readonly annotate?: ((exclusiveMaximum: T) => Annotations.Filter) | undefined
  readonly formatter?: Formatter<T> | undefined
}) {
  const lte = Order.isLessThanOrEqualTo(options.order)
  const formatter = options.formatter ?? format
  return (maximum: T, annotations?: Annotations.Filter) => {
    return makeFilter<T>(
      (input) => lte(input, maximum),
      {
        expected: `a value less than or equal to ${formatter(maximum)}`,
        ...options.annotate?.(maximum),
        ...annotations
      }
    )
  }
}

/**
 * Creates an inclusive or exclusive range check for any ordered type from an
 * `Order.Order` instance.
 *
 * @category Order checks
 * @since 4.0.0
 */
export function makeIsBetween<T>(deriveOptions: {
  readonly order: Order.Order<T>
  readonly annotate?:
    | ((options: {
      readonly minimum: T
      readonly maximum: T
      readonly exclusiveMinimum?: boolean | undefined
      readonly exclusiveMaximum?: boolean | undefined
    }) => Annotations.Filter)
    | undefined
  readonly formatter?: Formatter<T> | undefined
}) {
  const greaterThanOrEqualTo = Order.isGreaterThanOrEqualTo(deriveOptions.order)
  const greaterThan = Order.isGreaterThan(deriveOptions.order)
  const lessThanOrEqualTo = Order.isLessThanOrEqualTo(deriveOptions.order)
  const lessThan = Order.isLessThan(deriveOptions.order)
  const formatter = deriveOptions.formatter ?? format
  return (options: {
    readonly minimum: T
    readonly maximum: T
    readonly exclusiveMinimum?: boolean | undefined
    readonly exclusiveMaximum?: boolean | undefined
  }, annotations?: Annotations.Filter) => {
    const gte = options.exclusiveMinimum ? greaterThan : greaterThanOrEqualTo
    const lte = options.exclusiveMaximum ? lessThan : lessThanOrEqualTo
    return makeFilter<T>(
      (input) => gte(input, options.minimum) && lte(input, options.maximum),
      {
        expected: `a value between ${formatter(options.minimum)}${options.exclusiveMinimum ? " (excluded)" : ""} and ${
          formatter(options.maximum)
        }${options.exclusiveMaximum ? " (excluded)" : ""}`,
        ...deriveOptions.annotate?.(options),
        ...annotations
      }
    )
  }
}

/**
 * Creates a divisibility check for any numeric type from a remainder function
 * and a zero value.
 *
 * @category Numeric checks
 * @since 4.0.0
 */
export function makeIsMultipleOf<T>(options: {
  readonly remainder: (input: T, divisor: T) => T
  readonly zero: NoInfer<T>
  readonly annotate?: ((divisor: T) => Annotations.Filter) | undefined
  readonly formatter?: Formatter<T> | undefined
}) {
  return (divisor: T, annotations?: Annotations.Filter) => {
    const formatter = options.formatter ?? format
    return makeFilter<T>(
      (input) => options.remainder(input, divisor) === options.zero,
      {
        expected: `a value that is a multiple of ${formatter(divisor)}`,
        ...options.annotate?.(divisor),
        ...annotations
      }
    )
  }
}

/**
 * Validates that a number is greater than the specified value (exclusive).
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `exclusiveMinimum` constraint in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `min` constraint
 * with `minExcluded: true` to ensure generated numbers are greater than the
 * specified value.
 *
 * @category Number checks
 * @since 4.0.0
 */
export const isGreaterThan = makeIsGreaterThan({
  order: Order.Number,
  annotate: (exclusiveMinimum) => ({
    meta: {
      _tag: "isGreaterThan",
      exclusiveMinimum
    },
    toArbitraryConstraint: {
      number: {
        min: exclusiveMinimum,
        minExcluded: true
      }
    }
  })
})

/**
 * Validates that a number is greater than or equal to the specified value
 * (inclusive).
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `minimum` constraint in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `min` constraint
 * to ensure generated numbers are greater than or equal to the specified value.
 *
 * @category Number checks
 * @since 4.0.0
 */
export const isGreaterThanOrEqualTo = makeIsGreaterThanOrEqualTo({
  order: Order.Number,
  annotate: (minimum) => ({
    meta: {
      _tag: "isGreaterThanOrEqualTo",
      minimum
    },
    toArbitraryConstraint: {
      number: {
        min: minimum
      }
    }
  })
})

/**
 * Validates that a number is less than the specified value (exclusive).
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `exclusiveMaximum` constraint in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `max` constraint
 * with `maxExcluded: true` to ensure generated numbers are less than the
 * specified value.
 *
 * @category Number checks
 * @since 4.0.0
 */
export const isLessThan = makeIsLessThan({
  order: Order.Number,
  annotate: (exclusiveMaximum) => ({
    meta: {
      _tag: "isLessThan",
      exclusiveMaximum
    },
    toArbitraryConstraint: {
      number: {
        max: exclusiveMaximum,
        maxExcluded: true
      }
    }
  })
})

/**
 * Validates that a number is less than or equal to the specified value
 * (inclusive).
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `maximum` constraint in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `max` constraint
 * to ensure generated numbers are less than or equal to the specified value.
 *
 * @category Number checks
 * @since 4.0.0
 */
export const isLessThanOrEqualTo = makeIsLessThanOrEqualTo({
  order: Order.Number,
  annotate: (maximum) => ({
    meta: {
      _tag: "isLessThanOrEqualTo",
      maximum
    },
    toArbitraryConstraint: {
      number: {
        max: maximum
      }
    }
  })
})

/**
 * Validates that a number is within a specified range. The range boundaries can
 * be inclusive or exclusive based on the provided options.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to `minimum`/`maximum` or `exclusiveMinimum`/`exclusiveMaximum`
 * constraints in JSON Schema, depending on the options provided.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies `min` and `max`
 * constraints with optional `minExcluded` and `maxExcluded` flags to ensure
 * generated numbers fall within the specified range.
 *
 * @category Number checks
 * @since 4.0.0
 */
export const isBetween = makeIsBetween({
  order: Order.Number,
  annotate: (options) => {
    return {
      meta: {
        _tag: "isBetween",
        ...options
      },
      toArbitraryConstraint: {
        number: {
          min: options.minimum,
          max: options.maximum,
          ...(options.exclusiveMinimum && { minExcluded: true }),
          ...(options.exclusiveMaximum && { maxExcluded: true })
        }
      }
    }
  }
})

/**
 * Validates that a number is a multiple of the specified divisor.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `multipleOf` constraint in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies constraints to ensure
 * generated numbers are multiples of the specified divisor.
 *
 * @category Number checks
 * @since 4.0.0
 */
export const isMultipleOf = makeIsMultipleOf({
  remainder,
  zero: 0,
  annotate: (divisor) => ({
    expected: `a value that is a multiple of ${divisor}`,
    meta: {
      _tag: "isMultipleOf",
      divisor
    }
  })
})

/**
 * Validates that a number is a safe integer (within the safe integer range
 * that can be exactly represented in JavaScript).
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `type: "integer"` constraint in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies an `isInteger: true`
 * constraint to ensure generated numbers are integers.
 *
 * @category Integer checks
 * @since 4.0.0
 */
export function isInt(annotations?: Annotations.Filter) {
  return makeFilter(
    (n: number) => globalThis.Number.isSafeInteger(n),
    {
      expected: "an integer",
      meta: {
        _tag: "isInt"
      },
      toArbitraryConstraint: {
        number: {
          isInteger: true
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates that a number is a 32-bit signed integer (range: -2,147,483,648 to
 * 2,147,483,647).
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `format: "int32"` constraint in OpenAPI 3.1,
 * or `minimum`/`maximum` constraints in other JSON Schema targets.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies integer and range
 * constraints to ensure generated numbers are 32-bit signed integers.
 *
 * @category Integer checks
 * @since 4.0.0
 */
export function isInt32(annotations?: Annotations.Filter) {
  return new AST.FilterGroup(
    [
      isInt(annotations),
      isBetween({ minimum: -2147483648, maximum: 2147483647 })
    ],
    {
      expected: "a 32-bit integer",
      ...annotations
    }
  )
}

/**
 * Validates that a number is a 32-bit unsigned integer (range: 0 to
 * 4,294,967,295).
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `format: "uint32"` constraint in OpenAPI 3.1,
 * or `minimum`/`maximum` constraints in other JSON Schema targets.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies integer and range
 * constraints to ensure generated numbers are 32-bit unsigned integers.
 *
 * @category Integer checks
 * @since 4.0.0
 */
export function isUint32(annotations?: Annotations.Filter) {
  return new AST.FilterGroup(
    [
      isInt(),
      isBetween({ minimum: 0, maximum: 4294967295 })
    ],
    {
      expected: "a 32-bit unsigned integer",
      ...annotations
    }
  )
}

/**
 * Validates that a Date object represents a valid date (not an invalid date
 * like `new Date("invalid")`).
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check does not have a direct JSON Schema equivalent, as JSON Schema
 * validates date strings, not Date objects.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `noInvalidDate`
 * constraint to ensure generated Date objects are valid.
 *
 * @category Date checks
 * @since 4.0.0
 */
export function isDateValid(annotations?: Annotations.Filter) {
  return makeFilter<globalThis.Date>(
    (date) => !isNaN(date.getTime()),
    {
      expected: "a valid date",
      meta: {
        _tag: "isDateValid"
      },
      toArbitraryConstraint: {
        date: {
          noInvalidDate: true
        }
      },
      ...annotations
    }
  )
}

const nextDate = (date: globalThis.Date) => new globalThis.Date(date.getTime() + 1)

const previousDate = (date: globalThis.Date) => new globalThis.Date(date.getTime() - 1)

/**
 * Validates that a Date is greater than the specified value (exclusive).
 *
 * **Details**
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `min` constraint of
 * one millisecond after the specified value to ensure generated Date objects are
 * greater than it.
 *
 * @category Date checks
 * @since 4.0.0
 */
export const isGreaterThanDate = makeIsGreaterThan({
  order: Order.Date,
  annotate: (exclusiveMinimum) => ({
    meta: {
      _tag: "isGreaterThanDate",
      exclusiveMinimum
    },
    toArbitraryConstraint: {
      date: {
        min: nextDate(exclusiveMinimum)
      }
    }
  })
})

/**
 * Validates that a Date is greater than or equal to the specified date
 * (inclusive).
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check does not have a direct JSON Schema equivalent, as JSON Schema
 * validates date strings, not Date objects.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `min` constraint
 * to ensure generated Date objects are greater than or equal to the specified
 * date.
 *
 * @category Date checks
 * @since 4.0.0
 */
export const isGreaterThanOrEqualToDate = makeIsGreaterThanOrEqualTo({
  order: Order.Date,
  annotate: (minimum) => ({
    meta: {
      _tag: "isGreaterThanOrEqualToDate",
      minimum
    },
    toArbitraryConstraint: {
      date: {
        min: minimum
      }
    }
  })
})

/**
 * Validates that a Date is less than the specified value (exclusive).
 *
 * **Details**
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `max` constraint of
 * one millisecond before the specified value to ensure generated Date objects
 * are less than it.
 *
 * @category Date checks
 * @since 4.0.0
 */
export const isLessThanDate = makeIsLessThan({
  order: Order.Date,
  annotate: (exclusiveMaximum) => ({
    meta: {
      _tag: "isLessThanDate",
      exclusiveMaximum
    },
    toArbitraryConstraint: {
      date: {
        max: previousDate(exclusiveMaximum)
      }
    }
  })
})

/**
 * Validates that a Date is less than or equal to the specified date
 * (inclusive).
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check does not have a direct JSON Schema equivalent, as JSON Schema
 * validates date strings, not Date objects.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `max` constraint
 * to ensure generated Date objects are less than or equal to the specified
 * date.
 *
 * @category Date checks
 * @since 4.0.0
 */
export const isLessThanOrEqualToDate = makeIsLessThanOrEqualTo({
  order: Order.Date,
  annotate: (maximum) => ({
    meta: {
      _tag: "isLessThanOrEqualToDate",
      maximum
    },
    toArbitraryConstraint: {
      date: {
        max: maximum
      }
    }
  })
})

/**
 * Validates that a Date is within a specified range. The range boundaries can
 * be inclusive or exclusive based on the provided options.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check does not have a direct JSON Schema equivalent, as JSON Schema
 * validates date strings, not Date objects.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies `min` and `max`
 * constraints to ensure generated Date objects fall within the specified range,
 * shifting exclusive bounds by one millisecond.
 *
 * @category Date checks
 * @since 4.0.0
 */
export const isBetweenDate = makeIsBetween({
  order: Order.Date,
  annotate: (options) => ({
    meta: {
      _tag: "isBetweenDate",
      ...options
    },
    toArbitraryConstraint: {
      date: {
        min: options.exclusiveMinimum ? nextDate(options.minimum) : options.minimum,
        max: options.exclusiveMaximum ? previousDate(options.maximum) : options.maximum
      }
    }
  })
})

const nextBigInt = (n: bigint) => n + globalThis.BigInt(1)

const previousBigInt = (n: bigint) => n - globalThis.BigInt(1)

/**
 * Validates that a BigInt is greater than the specified value (exclusive).
 *
 * **Details**
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `min` constraint of
 * `exclusiveMinimum + 1n` to ensure generated BigInts are greater than the
 * specified value.
 *
 * @category BigInt checks
 * @since 4.0.0
 */
export const isGreaterThanBigInt = makeIsGreaterThan({
  order: Order.BigInt,
  annotate: (exclusiveMinimum) => ({
    meta: {
      _tag: "isGreaterThanBigInt",
      exclusiveMinimum
    },
    toArbitraryConstraint: {
      bigint: {
        min: nextBigInt(exclusiveMinimum)
      }
    }
  })
})

/**
 * Validates that a BigInt is greater than or equal to the specified value
 * (inclusive).
 *
 * **Details**
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `min` constraint
 * to ensure generated BigInt values are greater than or equal to the specified
 * value.
 *
 * @category BigInt checks
 * @since 4.0.0
 */
export const isGreaterThanOrEqualToBigInt = makeIsGreaterThanOrEqualTo({
  order: Order.BigInt,
  annotate: (minimum) => ({
    meta: {
      _tag: "isGreaterThanOrEqualToBigInt",
      minimum
    },
    toArbitraryConstraint: {
      bigint: {
        min: minimum
      }
    }
  })
})

/**
 * Validates that a BigInt is less than the specified value (exclusive).
 *
 * **Details**
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `max` constraint of
 * `exclusiveMaximum - 1n` to ensure generated BigInts are less than the
 * specified value.
 *
 * @category BigInt checks
 * @since 4.0.0
 */
export const isLessThanBigInt = makeIsLessThan({
  order: Order.BigInt,
  annotate: (exclusiveMaximum) => ({
    meta: {
      _tag: "isLessThanBigInt",
      exclusiveMaximum
    },
    toArbitraryConstraint: {
      bigint: {
        max: previousBigInt(exclusiveMaximum)
      }
    }
  })
})

/**
 * Validates that a BigInt is less than or equal to the specified value
 * (inclusive).
 *
 * **Details**
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `max` constraint
 * to ensure generated BigInt values are less than or equal to the specified
 * value.
 *
 * @category BigInt checks
 * @since 4.0.0
 */
export const isLessThanOrEqualToBigInt = makeIsLessThanOrEqualTo({
  order: Order.BigInt,
  annotate: (maximum) => ({
    meta: {
      _tag: "isLessThanOrEqualToBigInt",
      maximum
    },
    toArbitraryConstraint: {
      bigint: {
        max: maximum
      }
    }
  })
})

/**
 * Validates that a BigInt is within a specified range. The range boundaries can
 * be inclusive or exclusive based on the provided options.
 *
 * **Details**
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies `min` and `max`
 * constraints to ensure generated BigInt values fall within the specified
 * range.
 *
 * @category BigInt checks
 * @since 4.0.0
 */
export const isBetweenBigInt = makeIsBetween({
  order: Order.BigInt,
  annotate: (options) => ({
    meta: {
      _tag: "isBetweenBigInt",
      ...options
    },
    toArbitraryConstraint: {
      bigint: {
        min: options.exclusiveMinimum ? nextBigInt(options.minimum) : options.minimum,
        max: options.exclusiveMaximum ? previousBigInt(options.maximum) : options.maximum
      }
    }
  })
})

/**
 * Validates that a BigDecimal is greater than the specified value (exclusive).
 *
 * @category BigDecimal checks
 * @since 4.0.0
 */
export const isGreaterThanBigDecimal = makeIsGreaterThan({
  order: BigDecimal_.Order,
  formatter: (bd) => BigDecimal_.format(bd)
})

/**
 * Validates that a BigDecimal is greater than or equal to the specified value
 * (inclusive).
 *
 * @category BigDecimal checks
 * @since 4.0.0
 */
export const isGreaterThanOrEqualToBigDecimal = makeIsGreaterThanOrEqualTo({
  order: BigDecimal_.Order,
  formatter: (bd) => BigDecimal_.format(bd)
})

/**
 * Validates that a BigDecimal is less than the specified value (exclusive).
 *
 * @category BigDecimal checks
 * @since 4.0.0
 */
export const isLessThanBigDecimal = makeIsLessThan({
  order: BigDecimal_.Order,
  formatter: (bd) => BigDecimal_.format(bd)
})

/**
 * Validates that a BigDecimal is less than or equal to the specified value
 * (inclusive).
 *
 * @category BigDecimal checks
 * @since 4.0.0
 */
export const isLessThanOrEqualToBigDecimal = makeIsLessThanOrEqualTo({
  order: BigDecimal_.Order,
  formatter: (bd) => BigDecimal_.format(bd)
})

/**
 * Validates that a `BigDecimal` is within a specified range.
 *
 * **Details**
 *
 * The minimum and maximum boundaries are inclusive by default. Pass
 * `exclusiveMinimum` or `exclusiveMaximum` to exclude either boundary.
 *
 * @category BigDecimal checks
 * @since 4.0.0
 */
export const isBetweenBigDecimal = makeIsBetween({
  order: BigDecimal_.Order,
  formatter: (bd) => BigDecimal_.format(bd)
})

/**
 * Validates that a value has at least the specified length. Works with strings
 * and arrays.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `minLength` constraint for strings or the
 * `minItems` constraint for arrays in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `minLength`
 * constraint to ensure generated strings or arrays have at least the required
 * length.
 *
 * **Example** (Minimum length check)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const NonEmptyStringSchema = Schema.String.check(Schema.isMinLength(1))
 * const NonEmptyArraySchema = Schema.Array(Schema.Number).check(Schema.isMinLength(1))
 * ```
 *
 * @category Length checks
 * @since 4.0.0
 */
export function isMinLength(minLength: number, annotations?: Annotations.Filter) {
  minLength = Math.max(0, Math.floor(minLength))
  return makeFilter<{ readonly length: number }>(
    (input) => input.length >= minLength,
    {
      expected: `a value with a length of at least ${minLength}`,
      meta: {
        _tag: "isMinLength",
        minLength
      },
      [AST.STRUCTURAL_ANNOTATION_KEY]: true,
      toArbitraryConstraint: {
        string: {
          minLength
        },
        array: {
          minLength
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates that a value has at least one element. Works with strings and arrays.
 * This is equivalent to `isMinLength(1)`.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `minLength: 1` constraint for strings or the
 * `minItems: 1` constraint for arrays in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `minLength: 1`
 * constraint to ensure generated strings or arrays are non-empty.
 *
 * @category Length checks
 * @since 4.0.0
 */
export function isNonEmpty(annotations?: Annotations.Filter) {
  return isMinLength(1, annotations)
}

/**
 * Validates that a value has at most the specified length. Works with strings
 * and arrays.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `maxLength` constraint for strings or the
 * `maxItems` constraint for arrays in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `maxLength`
 * constraint to ensure generated strings or arrays have at most the required
 * length.
 *
 * @category Length checks
 * @since 4.0.0
 */
export function isMaxLength(maxLength: number, annotations?: Annotations.Filter) {
  maxLength = Math.max(0, Math.floor(maxLength))
  return makeFilter<{ readonly length: number }>(
    (input) => input.length <= maxLength,
    {
      expected: `a value with a length of at most ${maxLength}`,
      meta: {
        _tag: "isMaxLength",
        maxLength
      },
      [AST.STRUCTURAL_ANNOTATION_KEY]: true,
      toArbitraryConstraint: {
        string: {
          maxLength
        },
        array: {
          maxLength
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates that a value's length is within the specified range. Works with
 * strings and arrays.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to `minLength`/`maxLength` constraints for strings
 * or `minItems`/`maxItems` constraints for arrays in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies `minLength` and
 * `maxLength` constraints to ensure generated strings or arrays have a length
 * within the specified range.
 *
 * @category Length checks
 * @since 4.0.0
 */
export function isLengthBetween(minimum: number, maximum: number, annotations?: Annotations.Filter) {
  minimum = Math.max(0, Math.floor(minimum))
  maximum = Math.max(0, Math.floor(maximum))
  return makeFilter<{ readonly length: number }>(
    (input) => input.length >= minimum && input.length <= maximum,
    {
      expected: minimum === maximum
        ? `a value with a length of ${minimum}`
        : `a value with a length between ${minimum} and ${maximum}`,
      meta: {
        _tag: "isLengthBetween",
        minimum,
        maximum
      },
      [AST.STRUCTURAL_ANNOTATION_KEY]: true,
      toArbitraryConstraint: {
        string: {
          minLength: minimum,
          maxLength: maximum
        },
        array: {
          minLength: minimum,
          maxLength: maximum
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates that a value has at least the specified size. Works with values
 * that have a `size` property, such as `Set` or `Map`.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check does not have a direct JSON Schema equivalent, as it applies to
 * values with a `size` property rather than standard JSON Schema types.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `minLength`
 * constraint to the array representation to ensure generated values have at
 * least the required size.
 *
 * @category Size checks
 * @since 4.0.0
 */
export function isMinSize(minSize: number, annotations?: Annotations.Filter) {
  minSize = Math.max(0, Math.floor(minSize))
  return makeFilter<{ readonly size: number }>(
    (input) => input.size >= minSize,
    {
      expected: `a value with a size of at least ${minSize}`,
      meta: {
        _tag: "isMinSize",
        minSize
      },
      [AST.STRUCTURAL_ANNOTATION_KEY]: true,
      toArbitraryConstraint: {
        array: {
          minLength: minSize
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates that a value has at most the specified size. Works with values
 * that have a `size` property, such as `Set` or `Map`.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check does not have a direct JSON Schema equivalent, as it applies to
 * values with a `size` property rather than standard JSON Schema types.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `maxLength`
 * constraint to the array representation to ensure generated values have at
 * most the required size.
 *
 * @category Size checks
 * @since 4.0.0
 */
export function isMaxSize(maxSize: number, annotations?: Annotations.Filter) {
  maxSize = Math.max(0, Math.floor(maxSize))
  return makeFilter<{ readonly size: number }>(
    (input) => input.size <= maxSize,
    {
      expected: `a value with a size of at most ${maxSize}`,
      meta: {
        _tag: "isMaxSize",
        maxSize
      },
      [AST.STRUCTURAL_ANNOTATION_KEY]: true,
      toArbitraryConstraint: {
        array: {
          maxLength: maxSize
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates that a value's size is within the specified range. Works with
 * values that have a `size` property, such as `Set` or `Map`.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check does not have a direct JSON Schema equivalent, as it applies to
 * values with a `size` property rather than standard JSON Schema types.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies `minLength` and
 * `maxLength` constraints to ensure generated values have a size within the
 * specified range.
 *
 * @category Size checks
 * @since 4.0.0
 */
export function isSizeBetween(minimum: number, maximum: number, annotations?: Annotations.Filter) {
  minimum = Math.max(0, Math.floor(minimum))
  maximum = Math.max(0, Math.floor(maximum))
  return makeFilter<{ readonly size: number }>(
    (input) => input.size >= minimum && input.size <= maximum,
    {
      expected: minimum === maximum
        ? `a value with a size of ${minimum}`
        : `a value with a size between ${minimum} and ${maximum}`,
      meta: {
        _tag: "isSizeBetween",
        minimum,
        maximum
      },
      [AST.STRUCTURAL_ANNOTATION_KEY]: true,
      toArbitraryConstraint: {
        array: {
          minLength: minimum,
          maxLength: maximum
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates that an object contains at least the specified number of
 * properties. This includes both string and symbol keys when counting
 * properties.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `minProperties` constraint in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `minLength`
 * constraint to the array of entries that is generated before being converted
 * to an object, ensuring the resulting object has at least the required number
 * of properties.
 *
 * @category Object checks
 * @since 4.0.0
 */
export function isMinProperties(minProperties: number, annotations?: Annotations.Filter) {
  minProperties = Math.max(0, Math.floor(minProperties))
  return makeFilter<object>(
    (input) => Reflect.ownKeys(input).length >= minProperties,
    {
      expected: `a value with at least ${minProperties === 1 ? "1 entry" : `${minProperties} entries`}`,
      meta: {
        _tag: "isMinProperties",
        minProperties
      },
      [AST.STRUCTURAL_ANNOTATION_KEY]: true,
      toArbitraryConstraint: {
        array: {
          minLength: minProperties
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates that an object contains at most the specified number of properties.
 * This includes both string and symbol keys when counting properties.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to the `maxProperties` constraint in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies a `maxLength`
 * constraint to the array of entries that is generated before being converted
 * to an object, ensuring the resulting object has at most the required number
 * of properties.
 *
 * @category Object checks
 * @since 4.0.0
 */
export function isMaxProperties(maxProperties: number, annotations?: Annotations.Filter) {
  maxProperties = Math.max(0, Math.floor(maxProperties))
  return makeFilter<object>(
    (input) => Reflect.ownKeys(input).length <= maxProperties,
    {
      expected: `a value with at most ${maxProperties === 1 ? "1 entry" : `${maxProperties} entries`}`,
      meta: {
        _tag: "isMaxProperties",
        maxProperties
      },
      [AST.STRUCTURAL_ANNOTATION_KEY]: true,
      toArbitraryConstraint: {
        array: {
          maxLength: maxProperties
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates that an object contains between `minimum` and `maximum` properties (inclusive).
 * This includes both string and symbol keys when counting properties.
 *
 * **Details**
 *
 * JSON Schema:
 *
 * This check corresponds to `minProperties` and `maxProperties`
 * constraints in JSON Schema.
 *
 * Arbitrary:
 *
 * When generating test data with fast-check, this applies `minLength` and
 * `maxLength` constraints to the array of entries that is generated before
 * being converted to an object.
 *
 * @category Object checks
 * @since 4.0.0
 */
export function isPropertiesLengthBetween(minimum: number, maximum: number, annotations?: Annotations.Filter) {
  minimum = Math.max(0, Math.floor(minimum))
  maximum = Math.max(0, Math.floor(maximum))
  return makeFilter<object>(
    (input) => Reflect.ownKeys(input).length >= minimum && Reflect.ownKeys(input).length <= maximum,
    {
      expected: minimum === maximum
        ? `a value with exactly ${minimum === 1 ? "1 entry" : `${minimum} entries`}`
        : `a value with between ${minimum} and ${maximum} entries`,
      meta: {
        _tag: "isPropertiesLengthBetween",
        minimum,
        maximum
      },
      [AST.STRUCTURAL_ANNOTATION_KEY]: true,
      toArbitraryConstraint: {
        array: {
          minLength: minimum,
          maxLength: maximum
        }
      },
      ...annotations
    }
  )
}

/**
 * Validates that every own property key of an object satisfies the encoded side
 * of the provided key schema.
 *
 * **Details**
 *
 * This check uses `Reflect.ownKeys`, so symbol keys are validated in addition to
 * string property names.
 *
 * JSON Schema:
 * For string property names, this corresponds to the `propertyNames` constraint
 * in JSON Schema.
 *
 * @category Object checks
 * @since 4.0.0
 */
export function isPropertyNames(keySchema: Top, annotations?: Annotations.Filter) {
  const propertyNames = toEncoded(keySchema)
  const parser = Parser._issue(propertyNames.ast)
  return makeFilter<object>(
    (input, ast, options) => {
      const keys = Reflect.ownKeys(input)
      const issues: Array<Issue.Issue> = []
      for (const key of keys) {
        const issue = parser(key, options)
        if (issue !== undefined) {
          issues.push(new Issue.Pointer([key], issue))
          if (options.errors === "first") break
        }
      }
      if (Arr.isArrayNonEmpty(issues)) {
        return new Issue.Composite(ast, Option_.some(input), issues)
      }
      return true
    },
    {
      expected: "an object with property names matching the schema",
      meta: {
        _tag: "isPropertyNames",
        propertyNames: propertyNames.ast
      },
      [AST.STRUCTURAL_ANNOTATION_KEY]: true,
      ...annotations
    }
  )
}

/**
 * Validates that all items in an array are unique according to Effect equality.
 *
 * **Details**
 *
 * JSON Schema:
 * This check corresponds to the `uniqueItems: true` constraint in JSON Schema.
 *
 * Arbitrary:
 * When generating test data with fast-check, this applies a comparator based on
 * Effect equality to ensure generated arrays contain only unique items.
 *
 * @category Array checks
 * @since 4.0.0
 */
export function isUnique<T>(annotations?: Annotations.Filter) {
  const equivalence = Equal.asEquivalence<T>()
  return makeFilter<ReadonlyArray<T>>(
    (input) => Arr.dedupeWith(input, equivalence).length === input.length,
    {
      expected: "an array with unique items",
      meta: {
        _tag: "isUnique"
      },
      toArbitraryConstraint: {
        array: {
          comparator: equivalence
        }
      },
      ...annotations
    }
  )
}

// -----------------------------------------------------------------------------
// Built-in Schemas
// -----------------------------------------------------------------------------

/**
 * Type-level representation of the `NonEmptyString` schema, which validates
 * strings with a length of at least one.
 *
 * @category String
 * @since 3.10.0
 */
export interface NonEmptyString extends String {
  readonly "Rebuild": NonEmptyString
}

/**
 * Schema for non-empty strings. Validates that a string has at least one
 * character.
 *
 * @category String
 * @since 3.10.0
 */
export const NonEmptyString: NonEmptyString = String.check(isNonEmpty())

/**
 * Type-level representation of the `Char` schema, which validates strings whose
 * length is exactly one.
 *
 * @category String
 * @since 3.10.0
 */
export interface Char extends String {
  readonly "Rebuild": Char
}

/**
 * Schema for strings whose JavaScript `length` is exactly `1`.
 *
 * **When to use**
 *
 * Use to validate string values that must have `length === 1`.
 *
 * **Gotchas**
 *
 * This schema uses JavaScript `String.length`, so visible characters made from
 * multiple UTF-16 code units do not satisfy `length === 1`.
 *
 * @see {@link String} for unconstrained string values
 * @see {@link NonEmptyString} for strings with length greater than zero
 * @see {@link isLengthBetween} for the underlying length check
 *
 * @category String
 * @since 3.10.0
 */
export const Char: Char = String.check(isLengthBetween(1, 1))

/**
 * Schema for the `Option<A>` type, representing an optional value that is
 * either `None` or `Some<A>`.
 *
 * **Example** (Option schema)
 *
 * ```ts
 * import { Option, Schema } from "effect"
 *
 * const schema = Schema.Option(Schema.Number)
 *
 * Schema.decodeUnknownSync(schema)(Option.some(1))
 * // => Some(1)
 * Schema.decodeUnknownSync(schema)(Option.none())
 * // => None
 * ```
 *
 * @category Option
 * @since 3.10.0
 */
export interface Option<A extends Top> extends
  declareConstructor<
    Option_.Option<A["Type"]>,
    Option_.Option<A["Encoded"]>,
    readonly [A],
    OptionIso<A>
  >
{
  readonly "Rebuild": Option<A>
  readonly value: A
}

/**
 * Iso representation used for `Option` schemas.
 *
 * **Details**
 *
 * `None` is represented as `{ _tag: "None" }`, while `Some` is represented as
 * `{ _tag: "Some", value }` using the wrapped schema's `Iso` type.
 *
 * @category Option
 * @since 4.0.0
 */
export type OptionIso<A extends Top> =
  | { readonly _tag: "None" }
  | { readonly _tag: "Some"; readonly value: A["Iso"] }

/**
 * Schema for `Option<A>` values.
 *
 * @category Option
 * @since 3.10.0
 */
export function Option<A extends Top>(value: A): Option<A> {
  const schema = declareConstructor<
    Option_.Option<A["Type"]>,
    Option_.Option<A["Encoded"]>,
    OptionIso<A>
  >()(
    [value],
    ([value]) => (input, ast, options) => {
      if (Option_.isOption(input)) {
        if (Option_.isNone(input)) {
          return Effect.succeedNone
        }
        return Effect.mapBothEager(
          Parser.decodeUnknownEffect(value)(input.value, options),
          {
            onSuccess: Option_.some,
            onFailure: (issue) => new Issue.Composite(ast, Option_.some(input), [new Issue.Pointer(["value"], issue)])
          }
        )
      }
      return Effect.fail(new Issue.InvalidType(ast, Option_.some(input)))
    },
    {
      typeConstructor: {
        _tag: "effect/Option"
      },
      generation: {
        runtime: `Schema.Option(?)`,
        Type: `Option.Option<?>`,
        importDeclaration: `import * as Option from "effect/Option"`
      },
      expected: "Option",
      toCodec: ([value]) =>
        link<Option_.Option<A["Encoded"]>>()(
          Union([
            Struct({ _tag: Literal("Some"), value }),
            Struct({ _tag: Literal("None") })
          ]),
          Transformation.transform({
            decode: (e) => e._tag === "None" ? Option_.none() : Option_.some(e.value),
            encode: (o) => (Option_.isSome(o) ? { _tag: "Some", value: o.value } as const : { _tag: "None" } as const)
          })
        ),
      toArbitrary: ([value]) => (fc, ctx) => {
        return fc.oneof(
          ctx?.isSuspend ? { maxDepth: 2, depthIdentifier: "Option" } : {},
          fc.constant(Option_.none()),
          value.map(Option_.some)
        )
      },
      toEquivalence: ([value]) => Option_.makeEquivalence(value),
      toFormatter: ([value]) =>
        Option_.match({
          onNone: () => "none()",
          onSome: (t) => `some(${value(t)})`
        })
    }
  )
  return make(schema.ast, { value })
}

/**
 * Type-level representation of a schema that decodes `null` as `None` and all
 * other values as `Some`.
 *
 * @category Option
 * @since 3.10.0
 */
export interface OptionFromNullOr<S extends Top> extends decodeTo<Option<toType<S>>, NullOr<S>> {
  readonly "Rebuild": OptionFromNullOr<S>
}

/**
 * Decodes a nullable, required value `T` to a required `Option<T>` value.
 *
 * **Details**
 *
 * Decoding:
 * - `null` is decoded as `None`
 * - other values are decoded as `Some`
 *
 * Encoding:
 * - `None` is encoded as `null`
 * - `Some` is encoded as the value
 *
 * @category Option
 * @since 3.10.0
 */
export function OptionFromNullOr<S extends Top>(schema: S): OptionFromNullOr<S> {
  return NullOr(schema).pipe(decodeTo(
    Option(toType(schema)),
    Transformation.optionFromNullOr()
  ))
}

/**
 * Type-level representation of a schema that decodes `undefined` as `None` and
 * all other values as `Some`.
 *
 * @category Option
 * @since 3.10.0
 */
export interface OptionFromUndefinedOr<S extends Top> extends decodeTo<Option<toType<S>>, UndefinedOr<S>> {
  readonly "Rebuild": OptionFromUndefinedOr<S>
}

/**
 * Decodes an undefined-or value `T` to a required `Option<T>` value.
 *
 * **Details**
 *
 * Decoding:
 * - `undefined` is decoded as `None`
 * - other values are decoded as `Some`
 *
 * Encoding:
 * - `None` is encoded as `undefined`
 * - `Some` is encoded as the value
 *
 * @category Option
 * @since 3.10.0
 */
export function OptionFromUndefinedOr<S extends Top>(schema: S): OptionFromUndefinedOr<S> {
  return UndefinedOr(schema).pipe(decodeTo(
    Option(toType(schema)),
    Transformation.optionFromUndefinedOr()
  ))
}

/**
 * Type-level representation of a schema that decodes `null` or `undefined` as
 * `None` and all other values as `Some`.
 *
 * @category Option
 * @since 3.10.0
 */
export interface OptionFromNullishOr<S extends Top> extends decodeTo<Option<toType<S>>, NullishOr<S>> {
  readonly "Rebuild": OptionFromNullishOr<S>
}

/**
 * Decodes a nullish value `T` to a required `Option<T>` value.
 *
 * **Details**
 *
 * Decoding:
 * - `null` and `undefined` are decoded as `None`
 * - other values are decoded as `Some`
 *
 * Encoding:
 * - `None` is encoded as `null` or `undefined` depending on the provided `options.onNoneEncoding` (defaults to `undefined`)
 * - `Some` is encoded as the value
 *
 * @category Option
 * @since 3.10.0
 */
export function OptionFromNullishOr<S extends Top>(
  schema: S,
  options?: {
    onNoneEncoding: null | undefined
  }
): OptionFromNullishOr<S> {
  return NullishOr(schema).pipe(decodeTo(
    Option(toType(schema)),
    Transformation.optionFromNullishOr(options)
  ))
}

/**
 * Type-level representation of a schema that decodes a missing object key as
 * `None` and a present key as `Some`.
 *
 * @category Option
 * @since 4.0.0
 */
export interface OptionFromOptionalKey<S extends Top> extends decodeTo<Option<toType<S>>, optionalKey<S>> {
  readonly "Rebuild": OptionFromOptionalKey<S>
}

/**
 * Decodes an optional value `A` to a required `Option<A>` value.
 *
 * **Details**
 *
 * Decoding:
 * - a missing key is decoded as `None`
 * - a present value is decoded as `Some`
 *
 * Encoding:
 * - `None` is encoded as missing key
 * - `Some` is encoded as the value
 *
 * @category Option
 * @since 4.0.0
 */
export function OptionFromOptionalKey<S extends Top>(schema: S): OptionFromOptionalKey<S> {
  return optionalKey(schema).pipe(decodeTo(
    Option(toType(schema)),
    Transformation.optionFromOptionalKey()
  ))
}

/**
 * Type-level representation of a schema that decodes a missing key or
 * `undefined` value as `None` and other present values as `Some`.
 *
 * @category Option
 * @since 4.0.0
 */
export interface OptionFromOptional<S extends Top> extends decodeTo<Option<toType<S>>, optional<S>> {
  readonly "Rebuild": OptionFromOptional<S>
}

/**
 * Decodes an optional or `undefined` value `A` to an required `Option<A>`
 * value.
 *
 * **Details**
 *
 * Decoding:
 * - a missing key is decoded as `None`
 * - a present key with an `undefined` value is decoded as `None`
 * - all other values are decoded as `Some`
 *
 * Encoding:
 * - `None` is encoded as missing key
 * - `Some` is encoded as the value
 *
 * @category Option
 * @since 4.0.0
 */
export function OptionFromOptional<S extends Top>(schema: S): OptionFromOptional<S> {
  return optional(schema).pipe(decodeTo(
    Option(toType(schema)),
    Transformation.optionFromOptional<any>()
  ))
}

/**
 * Type-level representation of a schema that decodes a missing key, `undefined`,
 * or `null` as `None` and all other present values as `Some`.
 *
 * @category Option
 * @since 4.0.0
 */
export interface OptionFromOptionalNullOr<S extends Top> extends decodeTo<Option<toType<S>>, optional<NullOr<S>>> {
  readonly "Rebuild": OptionFromOptionalNullOr<S>
}

/**
 * Decodes an optional or `null` or `undefined` value `A` to a required `Option<A>`
 * value.
 *
 * **Details**
 *
 * Decoding:
 * - a missing key is decoded as `None`
 * - a present key with an `undefined` value is decoded as `None`
 * - a present key with a `null` value is decoded as `None`
 * - all other values are decoded as `Some`
 *
 * Encoding (controlled by `options.onNoneEncoding`):
 * - `"omit"` (default): `None` is encoded as a missing key
 * - `null`: `None` is encoded as `null`
 * - `undefined`: `None` is encoded as `undefined`
 * - `Some` is always encoded as the value
 *
 * @category Option
 * @since 4.0.0
 */
export function OptionFromOptionalNullOr<S extends Top>(
  schema: S,
  options?: {
    readonly onNoneEncoding: "omit" | null | undefined
  }
): OptionFromOptionalNullOr<S> {
  const onNoneEncoding = options === undefined ? "omit" : options.onNoneEncoding
  const noneValue = onNoneEncoding === null
    ? null as S["Type"] | null | undefined
    : undefined as S["Type"] | null | undefined
  return optional(NullOr(schema)).pipe(decodeTo(
    Option(toType(schema)),
    Transformation.transformOptional<Option_.Option<S["Type"]>, S["Type"] | null | undefined>({
      decode: (oe) => oe.pipe(Option_.filter(Predicate.isNotNullish), Option_.some),
      encode: onNoneEncoding === "omit"
        ? Option_.flatten
        : (ot) => Option_.some(Option_.getOrElse(Option_.flatten(ot), () => noneValue))
    })
  ))
}

/**
 * Schema for the `Result<A, E>` type, representing a computation that either
 * succeeds with `A` or fails with `E`.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface Result<A extends Top, E extends Top> extends
  declareConstructor<
    Result_.Result<A["Type"], E["Type"]>,
    Result_.Result<A["Encoded"], E["Encoded"]>,
    readonly [A, E],
    ResultIso<A, E>
  >
{
  readonly "Rebuild": Result<A, E>
  readonly success: A
  readonly failure: E
}

/**
 * Iso representation used for `Result` schemas.
 *
 * **Details**
 *
 * Successful results are represented as `{ _tag: "Success", success }`, while
 * failed results are represented as `{ _tag: "Failure", failure }`.
 *
 * @category schemas
 * @since 4.0.0
 */
export type ResultIso<A extends Top, E extends Top> =
  | { readonly _tag: "Success"; readonly success: A["Iso"] }
  | { readonly _tag: "Failure"; readonly failure: E["Iso"] }

/**
 * Schema for `Result<A, E>` values.
 *
 * @category schemas
 * @since 4.0.0
 */
export function Result<A extends Top, E extends Top>(
  success: A,
  failure: E
): Result<A, E> {
  const schema = declareConstructor<
    Result_.Result<A["Type"], E["Type"]>,
    Result_.Result<A["Encoded"], E["Encoded"]>,
    ResultIso<A, E>
  >()(
    [success, failure],
    ([success, failure]) => (input, ast, options) => {
      if (!Result_.isResult(input)) {
        return Effect.fail(new Issue.InvalidType(ast, Option_.some(input)))
      }
      switch (input._tag) {
        case "Success":
          return Effect.mapBothEager(Parser.decodeEffect(success)(input.success, options), {
            onSuccess: Result_.succeed,
            onFailure: (issue) => new Issue.Composite(ast, Option_.some(input), [new Issue.Pointer(["success"], issue)])
          })
        case "Failure":
          return Effect.mapBothEager(Parser.decodeEffect(failure)(input.failure, options), {
            onSuccess: Result_.fail,
            onFailure: (issue) => new Issue.Composite(ast, Option_.some(input), [new Issue.Pointer(["failure"], issue)])
          })
      }
    },
    {
      typeConstructor: {
        _tag: "effect/Result"
      },
      generation: {
        runtime: `Schema.Result(?, ?)`,
        Type: `Result.Result<?, ?>`,
        importDeclaration: `import * as Result from "effect/Result"`
      },
      expected: "Result",
      toCodec: ([success, failure]) =>
        link<Result_.Result<A["Encoded"], E["Encoded"]>>()(
          Union([
            Struct({ _tag: Literal("Success"), success }),
            Struct({ _tag: Literal("Failure"), failure })
          ]),
          Transformation.transform({
            decode: (e): Result_.Result<A["Encoded"], E["Encoded"]> =>
              e._tag === "Success" ? Result_.succeed(e.success) : Result_.fail(e.failure),
            encode: (r) =>
              Result_.isSuccess(r)
                ? { _tag: "Success", success: r.success } as const
                : { _tag: "Failure", failure: r.failure } as const
          })
        ),
      toArbitrary: ([success, failure]) => (fc, ctx) => {
        return fc.oneof(
          ctx?.isSuspend ? { maxDepth: 2, depthIdentifier: "Result" } : {},
          success.map(Result_.succeed),
          failure.map(Result_.fail)
        )
      },
      toEquivalence: ([success, failure]) => Result_.makeEquivalence(success, failure),
      toFormatter: ([success, failure]) =>
        Result_.match({
          onSuccess: (t) => `success(${success(t)})`,
          onFailure: (t) => `failure(${failure(t)})`
        })
    }
  )
  return make(schema.ast, { success, failure })
}

/**
 * Schema for the `Redacted<A>` type, providing secure handling of sensitive
 * values. The inner value is hidden from error messages.
 *
 * @category Redacted
 * @since 3.10.0
 */
export interface Redacted<S extends Top> extends
  declareConstructor<
    Redacted_.Redacted<S["Type"]>,
    Redacted_.Redacted<S["Encoded"]>,
    readonly [S]
  >
{
  readonly "Rebuild": Redacted<S>
  readonly value: S
}

/**
 * Schema for values that hide sensitive information from error output and
 * inspection.
 *
 * **Details**
 *
 * If the wrapped schema fails, the issue will be redacted to prevent both
 * the actual value and the schema details from being exposed.
 *
 * Options:
 *
 * - `label`: When provided, the schema will behave as follows:
 *   - Values will be validated against the label in addition to the wrapped schema
 *   - The default JSON serializer will deserialize into a `Redacted` instance with the label
 *   - The arbitrary generator will produce a `Redacted` instance with the label
 *   - The formatter will return the label
 * - `disallowJsonEncode`: When set to `true`, when attempting to encode a `Redacted` instance
 *   into JSON, it will fail with an error. This is useful when the wrapped schema is
 *   sensitive and should not be exposed in JSON.
 *
 * @category Redacted
 * @since 3.10.0
 */
export function Redacted<S extends Top>(value: S, options?: {
  readonly label?: string | undefined
  readonly disallowJsonEncode?: boolean | undefined
}): Redacted<S> {
  const decodeLabel = typeof options?.label === "string"
    ? Parser.decodeUnknownEffect(Literal(options.label))
    : undefined
  const schema = declareConstructor<Redacted_.Redacted<S["Type"]>, Redacted_.Redacted<S["Encoded"]>>()(
    [value],
    ([value]) => (input, ast, poptions) => {
      if (Redacted_.isRedacted(input)) {
        const label: Effect.Effect<void, Issue.Issue, never> = decodeLabel !== undefined
          ? Effect.mapErrorEager(
            decodeLabel(input.label, poptions),
            (issue) => new Issue.Pointer(["label"], issue)
          )
          : Effect.void
        return Effect.flatMapEager(
          label,
          () =>
            Effect.mapBothEager(
              Parser.decodeUnknownEffect(value)(Redacted_.value(input), poptions),
              {
                onSuccess: () => input,
                onFailure: (/** ignore the actual issue because of security reasons */) => {
                  const oinput = Option_.some(input)
                  return new Issue.Composite(ast, oinput, [
                    new Issue.Pointer(["value"], new Issue.InvalidValue(oinput))
                  ])
                }
              }
            )
        )
      }
      return Effect.fail(new Issue.InvalidType(ast, Option_.some(input)))
    },
    {
      typeConstructor: {
        _tag: "effect/Redacted"
      },
      generation: {
        runtime: `Schema.Redacted(?)`,
        Type: `Redacted.Redacted<?>`,
        importDeclaration: `import * as Redacted from "effect/Redacted"`
      },
      expected: "Redacted",
      toCodecJson: ([value]) =>
        link<Redacted_.Redacted<S["Encoded"]>>()(
          redact(value),
          {
            decode: Getter.transform((e) => Redacted_.make(e, { label: options?.label })),
            encode: options?.disallowJsonEncode ?
              Getter.forbidden((oe) =>
                "Cannot serialize Redacted" +
                (Option_.isSome(oe) && typeof oe.value.label === "string" ? ` with label: "${oe.value.label}"` : "")
              ) :
              Getter.transform(Redacted_.value)
          }
        ),
      toArbitrary: ([value]) => () => value.map((a) => Redacted_.make(a, { label: options?.label })),
      toFormatter: () => globalThis.String,
      toEquivalence: ([value]) => Redacted_.makeEquivalence(value)
    }
  )
  return make(schema.ast, { value })
}

/**
 * Type-level representation of a schema that decodes a raw value with the
 * provided schema and wraps the result in `Redacted`.
 *
 * @category Redacted
 * @since 4.0.0
 */
export interface RedactedFromValue<S extends Top>
  extends decodeTo<Redacted<toType<S>>, middlewareDecoding<S, S["DecodingServices"]>>
{
  readonly "Rebuild": RedactedFromValue<S>
}

/**
 * Middleware that wraps decoded errors in `Redacted`, preventing sensitive
 * schema details from leaking in error messages.
 *
 * @category Redacted
 * @since 4.0.0
 */
export function redact<S extends Top>(schema: S): middlewareDecoding<S, S["DecodingServices"]> {
  return schema.pipe(middlewareDecoding(Effect.mapErrorEager(Issue.redact)))
}

/**
 * Decodes a value and wraps it in `Redacted<A>`. Unlike {@link Redacted} which
 * expects the input to already be a `Redacted` instance, this schema decodes
 * the raw value and wraps it.
 *
 * @category Redacted
 * @since 4.0.0
 */
export function RedactedFromValue<S extends Top>(value: S, options?: {
  readonly label?: string | undefined
  readonly disallowEncode?: boolean | undefined
}): RedactedFromValue<S> {
  return redact(value).pipe(
    decodeTo(
      Redacted(toType(value), {
        label: options?.label,
        disallowJsonEncode: options?.disallowEncode
      }),
      {
        decode: Getter.transform((t) => Redacted_.make(t, { label: options?.label })),
        encode: options?.disallowEncode ?
          Getter.forbidden((oe) =>
            "Cannot encode Redacted" +
            (Option_.isSome(oe) && typeof oe.value.label === "string" ? ` with label: "${oe.value.label}"` : "")
          ) :
          Getter.transform(Redacted_.value)
      }
    )
  )
}

/**
 * Schema for a single `Cause.Reason`, representing one reason a fiber may fail:
 * a typed error (`Fail`), an unexpected defect (`Die`), or an interrupt
 * (`Interrupt`).
 *
 * **When to use**
 *
 * Use as the schema type when generic code needs to retain the typed failure
 * and defect schemas for a single cause reason.
 *
 * **Details**
 *
 * The `error` schema validates typed failures and the `defect` schema validates
 * unexpected defects.
 *
 * @see {@link CauseReason} for constructing this schema type
 * @see {@link CauseReasonIso} for the ISO shape of each cause reason
 *
 * @category CauseReason
 * @since 4.0.0
 */
export interface CauseReason<E extends Top, D extends Top> extends
  declareConstructor<
    Cause_.Reason<E["Type"]>,
    Cause_.Reason<E["Encoded"]>,
    readonly [E, D],
    CauseReasonIso<E, D>
  >
{
  readonly "Rebuild": CauseReason<E, D>
  readonly error: E
  readonly defect: D
}

/**
 * Iso representation used for `CauseReason` schemas.
 *
 * **Details**
 *
 * Failures are represented with a `Fail` tag and encoded error, defects with a
 * `Die` tag and encoded defect, and interrupts with an optional `fiberId`.
 *
 * @category CauseReason
 * @since 4.0.0
 */
export type CauseReasonIso<E extends Top, D extends Top> = {
  readonly _tag: "Fail"
  readonly error: E["Iso"]
} | {
  readonly _tag: "Die"
  readonly error: D["Iso"]
} | {
  readonly _tag: "Interrupt"
  readonly fiberId: number | undefined
}

/**
 * Creates a schema for `Cause.Reason` values using separate schemas for typed
 * failures and unexpected defects.
 *
 * **When to use**
 *
 * Use to validate, transform, or serialize individual `Cause.Reason` values
 * when typed failures and unexpected defects need separate schemas.
 *
 * **Details**
 *
 * `Fail` reasons use the `error` schema, `Die` reasons use the `defect` schema,
 * and `Interrupt` reasons carry only an optional fiber id.
 *
 * @see {@link Cause} for constructing schemas for full Cause values
 * @see {@link CauseReasonIso} for the ISO shape of each cause reason
 *
 * @category CauseReason
 * @since 4.0.0
 */
export function CauseReason<E extends Top, D extends Top>(error: E, defect: D): CauseReason<E, D> {
  const schema = declareConstructor<Cause_.Reason<E["Type"]>, Cause_.Reason<E["Encoded"]>, CauseReasonIso<E, D>>()(
    [error, defect],
    ([error, defect]) => (input, ast, options) => {
      if (!Cause_.isReason(input)) {
        return Effect.fail(new Issue.InvalidType(ast, Option_.some(input)))
      }
      switch (input._tag) {
        case "Fail":
          return Effect.mapBothEager(
            Parser.decodeUnknownEffect(error)(input.error, options),
            {
              onSuccess: Cause_.makeFailReason,
              onFailure: (issue) => new Issue.Composite(ast, Option_.some(input), [new Issue.Pointer(["error"], issue)])
            }
          )
        case "Die":
          return Effect.mapBothEager(
            Parser.decodeUnknownEffect(defect)(input.defect, options),
            {
              onSuccess: Cause_.makeDieReason,
              onFailure: (issue) =>
                new Issue.Composite(ast, Option_.some(input), [new Issue.Pointer(["defect"], issue)])
            }
          )
        case "Interrupt":
          return Effect.succeed(input)
      }
    },
    {
      typeConstructor: {
        _tag: "effect/Cause/Failure"
      },
      generation: {
        runtime: `Schema.CauseReason(?, ?)`,
        Type: `Cause.Failure<?, ?>`,
        importDeclaration: `import * as Cause from "effect/Cause"`
      },
      expected: "Cause.Failure",
      toCodec: ([error, defect]) =>
        link<Cause_.Reason<E["Encoded"]>>()(
          Union([
            Struct({ _tag: Literal("Fail"), error }),
            Struct({ _tag: Literal("Die"), defect }),
            Struct({ _tag: Literal("Interrupt"), fiberId: UndefinedOr(Finite) })
          ]),
          Transformation.transform({
            decode: (e) => {
              switch (e._tag) {
                case "Fail":
                  return Cause_.makeFailReason(e.error)
                case "Die":
                  return Cause_.makeDieReason(e.defect)
                case "Interrupt":
                  return Cause_.makeInterruptReason(e.fiberId)
              }
            },
            encode: identity
          })
        ),
      toArbitrary: ([error, defect]) => causeReasonToArbitrary(error, defect),
      toEquivalence: ([error, defect]) => causeReasonToEquivalence(error, defect),
      toFormatter: ([error, defect]) => causeReasonToFormatter(error, defect)
    }
  )
  return make(schema.ast, { error, defect })
}

function causeReasonToArbitrary<E, D>(error: FastCheck.Arbitrary<E>, defect: FastCheck.Arbitrary<D>) {
  return (fc: typeof FastCheck, ctx: Annotations.ToArbitrary.Context | undefined) => {
    return fc.oneof(
      ctx?.isSuspend ? { maxDepth: 2, depthIdentifier: "Cause.Failure" } : {},
      fc.constant(Cause_.makeInterruptReason()),
      fc.integer({ min: 1 }).map(Cause_.makeInterruptReason),
      error.map((e) => Cause_.makeFailReason(e)),
      defect.map((d) => Cause_.makeDieReason(d))
    )
  }
}

function causeReasonToEquivalence<E>(error: Equivalence.Equivalence<E>, defect: Equivalence.Equivalence<unknown>) {
  return (a: Cause_.Reason<E>, b: Cause_.Reason<E>) => {
    if (a._tag !== b._tag) return false
    switch (a._tag) {
      case "Fail":
        return error(a.error, (b as Cause_.Fail<E>).error)
      case "Die":
        return defect(a.defect, (b as Cause_.Die).defect)
      case "Interrupt":
        return a.fiberId === (b as Cause_.Interrupt).fiberId
    }
  }
}

function causeReasonToFormatter<E>(error: Formatter<E>, defect: Formatter<unknown>) {
  return (t: Cause_.Reason<E>) => {
    switch (t._tag) {
      case "Fail":
        return `Fail(${error(t.error)})`
      case "Die":
        return `Die(${defect(t.defect)})`
      case "Interrupt":
        return "Interrupt"
    }
  }
}

/**
 * Schema for `Cause` values, represented as an ordered collection of failure
 * reasons combining typed errors, defects, and interrupts.
 *
 * **When to use**
 *
 * Use as the schema type when generic code needs to retain the typed failure
 * and defect schemas for a full cause.
 *
 * **Details**
 *
 * The `error` schema validates typed failures and the `defect` schema validates
 * unexpected defects.
 *
 * @see {@link Cause} for constructing this schema type
 * @see {@link CauseIso} for the ordered array representation used by the schema ISO
 *
 * @category Cause
 * @since 3.10.0
 */
export interface Cause<E extends Top, D extends Top> extends
  declareConstructor<
    Cause_.Cause<E["Type"]>,
    Cause_.Cause<E["Encoded"]>,
    readonly [E, D],
    CauseIso<E, D>
  >
{
  readonly "Rebuild": Cause<E, D>
  readonly error: E
  readonly defect: D
}

/**
 * Iso representation used for `Cause` schemas: an ordered array of
 * `CauseReasonIso` values.
 *
 * **When to use**
 *
 * Use when working with the ISO shape of a `Cause` schema, such as `toIso`
 * optics or codecs that expose a cause as its ordered array of encoded reasons.
 *
 * @see {@link Cause} for constructing schemas for full Cause values
 * @see {@link CauseReasonIso} for the ISO shape of each array element
 *
 * @category Cause
 * @since 4.0.0
 */
export type CauseIso<E extends Top, D extends Top> = ReadonlyArray<CauseReasonIso<E, D>>

/**
 * Creates a schema for `Cause` values using separate schemas for typed failures
 * and unexpected defects.
 *
 * **When to use**
 *
 * Use to validate, transform, or serialize Effect failure causes when typed
 * failures and unexpected defects need separate schemas.
 *
 * **Details**
 *
 * The `error` schema is applied to `Fail` reasons and the `defect` schema is
 * applied to `Die` reasons. Interrupt reasons do not use either schema and
 * carry only an optional fiber id.
 *
 * @see {@link CauseReason} for the schema used by each individual cause reason
 * @see {@link CauseIso} for the ordered array representation used by the schema ISO
 *
 * @category Cause
 * @since 3.10.0
 */
export function Cause<E extends Top, D extends Top>(error: E, defect: D): Cause<E, D> {
  const schema = declareConstructor<Cause_.Cause<E["Type"]>, Cause_.Cause<E["Encoded"]>, CauseIso<E, D>>()(
    [error, defect],
    ([error, defect]) => {
      const failures = ArraySchema(CauseReason(error, defect))
      return (input, ast, options) => {
        if (!Cause_.isCause(input)) {
          return Effect.fail(new Issue.InvalidType(ast, Option_.some(input)))
        }
        return Effect.mapBothEager(Parser.decodeUnknownEffect(failures)(input.reasons, options), {
          onSuccess: Cause_.fromReasons,
          onFailure: (issue) => new Issue.Composite(ast, Option_.some(input), [new Issue.Pointer(["failures"], issue)])
        })
      }
    },
    {
      typeConstructor: {
        _tag: "effect/Cause"
      },
      generation: {
        runtime: `Schema.Cause(?, ?)`,
        Type: `Cause.Cause<?, ?>`,
        importDeclaration: `import * as Cause from "effect/Cause"`
      },
      expected: "Cause",
      toCodec: ([error, defect]) =>
        link<Cause_.Cause<E["Encoded"]>>()(
          ArraySchema(CauseReason(error, defect)),
          Transformation.transform({
            decode: Cause_.fromReasons,
            encode: ({ reasons: failures }) => failures
          })
        ),
      toArbitrary: ([error, defect]) => causeToArbitrary(error, defect),
      toEquivalence: ([error, defect]) => causeToEquivalence(error, defect),
      toFormatter: ([error, defect]) => causeToFormatter(error, defect)
    }
  )
  return make(schema.ast, { error, defect })
}

function causeToArbitrary<E, D>(error: FastCheck.Arbitrary<E>, defect: FastCheck.Arbitrary<D>) {
  return (fc: typeof FastCheck, ctx: Annotations.ToArbitrary.Context | undefined) => {
    return fc.array(causeReasonToArbitrary(error, defect)(fc, ctx)).map(Cause_.fromReasons)
  }
}

function causeToEquivalence<E>(error: Equivalence.Equivalence<E>, defect: Equivalence.Equivalence<unknown>) {
  const failures = Equivalence.Array(causeReasonToEquivalence(error, defect))
  return (a: Cause_.Cause<E>, b: Cause_.Cause<E>) => failures(a.reasons, b.reasons)
}

function causeToFormatter<E>(error: Formatter<E>, defect: Formatter<unknown>) {
  const causeReason = causeReasonToFormatter(error, defect)
  return (t: Cause_.Cause<E>) => `Cause([${t.reasons.map(causeReason).join(", ")}])`
}

/**
 * Type-level representation of the schema for JavaScript `Error` instances.
 *
 * @category Error
 * @since 4.0.0
 */
export interface Error extends instanceOf<globalThis.Error> {
  readonly "Rebuild": Error
}

const ErrorJsonEncoded = Struct({
  message: String,
  name: optionalKey(String),
  stack: optionalKey(String)
})

/**
 * Schema for JavaScript `Error` objects.
 *
 * **Details**
 *
 * Default JSON serializer:
 * Encodes an `Error` as an object with `message` and optional `name` properties,
 * and decodes that object back into an `Error`. The stack trace is omitted from
 * the encoded form for security.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Error: Error = instanceOf(globalThis.Error, {
  typeConstructor: {
    _tag: "Error"
  },
  generation: {
    runtime: `Schema.Error`,
    Type: `globalThis.Error`
  },
  expected: "Error",
  toCodecJson: () => link<globalThis.Error>()(ErrorJsonEncoded, Transformation.errorFromErrorJsonEncoded()),
  toArbitrary: () => (fc) => fc.string().map((message) => new globalThis.Error(message))
})

/**
 * Schema for JavaScript `Error` objects that preserves stack traces in the JSON
 * encoded form.
 *
 * **Details**
 *
 * Default JSON serializer:
 * Encodes an `Error` as an object with `message`, optional `name`, and optional
 * `stack` properties, and decodes that object back into an `Error`.
 *
 * @category schemas
 * @since 4.0.0
 */
export const ErrorWithStack: Error = instanceOf(globalThis.Error, {
  typeConstructor: {
    _tag: "ErrorWithStack"
  },
  generation: {
    runtime: `Schema.ErrorWithStack`,
    Type: `globalThis.Error`
  },
  expected: "Error",
  toCodecJson: () =>
    link<globalThis.Error>()(
      ErrorJsonEncoded,
      Transformation.errorFromErrorJsonEncoded({
        includeStack: true
      })
    ),
  toArbitrary: () => (fc) => fc.string().map((message) => new globalThis.Error(message))
})

/**
 * Type-level representation of the `Defect` schema, which accepts JavaScript
 * `Error` values and arbitrary unknown defect values.
 *
 * @category Defect
 * @since 3.10.0
 */
export interface Defect extends
  Union<
    readonly [
      decodeTo<
        Error,
        Struct<{
          readonly message: String
          readonly name: optionalKey<String>
          readonly stack: optionalKey<String>
        }>
      >,
      decodeTo<Unknown, Any>
    ]
  >
{
  readonly "Rebuild": Defect
}

const defectTransformation = new Transformation.Transformation(
  Getter.passthrough(),
  Getter.transform((u) => {
    try {
      return JSON.parse(JSON.stringify(u))
    } catch {
      return format(u)
    }
  })
)

/**
 * Schema for defect values, accepting either JavaScript `Error` values encoded
 * with `message` and optional `name`, or arbitrary unknown defect values.
 *
 * **Details**
 *
 * Default JSON serializer:
 * Unknown defects are serialized with `JSON.stringify` when possible and fall
 * back to Effect's formatted representation when JSON serialization fails.
 *
 * @category constructors
 * @since 3.10.0
 */
export const Defect: Defect = Union([
  ErrorJsonEncoded.pipe(decodeTo(Error, Transformation.errorFromErrorJsonEncoded())),
  Any.pipe(decodeTo(
    Unknown.annotate({
      toCodecJson: () => link<unknown>()(Any, defectTransformation),
      toArbitrary: () => (fc) => fc.json()
    }),
    defectTransformation
  ))
])

/**
 * Schema for defects that also includes stack traces in the encoded form.
 *
 * @category Defect
 * @since 4.0.0
 */
export const DefectWithStack: Defect = Union([
  ErrorJsonEncoded.pipe(decodeTo(
    ErrorWithStack,
    Transformation.errorFromErrorJsonEncoded({
      includeStack: true
    })
  )),
  Any.pipe(decodeTo(
    Unknown.annotate({
      toCodecJson: () => link<unknown>()(Any, defectTransformation),
      toArbitrary: () => (fc) => fc.json()
    }),
    defectTransformation
  ))
])

/**
 * Schema for `Exit` values, representing either a success with value `A` or a
 * failure with a `Cause` containing typed errors and defects.
 *
 * @category Exit
 * @since 3.10.0
 */
export interface Exit<A extends Top, E extends Top, D extends Top> extends
  declareConstructor<
    Exit_.Exit<A["Type"], E["Type"]>,
    Exit_.Exit<A["Encoded"], E["Encoded"]>,
    readonly [A, E, D],
    ExitIso<A, E, D>
  >
{
  readonly "Rebuild": Exit<A, E, D>
  readonly value: A
  readonly error: E
  readonly defect: D
}

/**
 * Iso representation used for `Exit` schemas.
 *
 * **Details**
 *
 * Successful exits are represented as `{ _tag: "Success", value }`, while failed
 * exits are represented as `{ _tag: "Failure", cause }`.
 *
 * @category Exit
 * @since 4.0.0
 */
export type ExitIso<A extends Top, E extends Top, D extends Top> = {
  readonly _tag: "Success"
  readonly value: A["Iso"]
} | {
  readonly _tag: "Failure"
  readonly cause: CauseIso<E, D>
}

/**
 * Creates a schema for `Exit` values using schemas for the success value, typed
 * failure, and unexpected defect channels.
 *
 * @category Exit
 * @since 3.10.0
 */
export function Exit<A extends Top, E extends Top, D extends Top>(value: A, error: E, defect: D): Exit<A, E, D> {
  const schema = declareConstructor<
    Exit_.Exit<A["Type"], E["Type"]>,
    Exit_.Exit<A["Encoded"], E["Encoded"]>,
    ExitIso<A, E, D>
  >()(
    [value, error, defect],
    ([value, error, defect]) => {
      const cause = Cause(error, defect)
      return (input, ast, options) => {
        if (!Exit_.isExit(input)) {
          return Effect.fail(new Issue.InvalidType(ast, Option_.some(input)))
        }
        switch (input._tag) {
          case "Success":
            return Effect.mapBothEager(
              Parser.decodeUnknownEffect(value)(input.value, options),
              {
                onSuccess: Exit_.succeed,
                onFailure: (issue) =>
                  new Issue.Composite(ast, Option_.some(input), [new Issue.Pointer(["value"], issue)])
              }
            )
          case "Failure":
            return Effect.mapBothEager(
              Parser.decodeUnknownEffect(cause)(input.cause, options),
              {
                onSuccess: Exit_.failCause,
                onFailure: (issue) =>
                  new Issue.Composite(ast, Option_.some(input), [new Issue.Pointer(["cause"], issue)])
              }
            )
        }
      }
    },
    {
      typeConstructor: {
        _tag: "effect/Exit"
      },
      generation: {
        runtime: `Schema.Exit(?, ?, ?)`,
        Type: `Exit.Exit<?, ?, ?>`,
        importDeclaration: `import * as Exit from "effect/Exit"`
      },
      expected: "Exit",
      toCodec: ([value, error, defect]) =>
        link<Exit_.Exit<A["Encoded"], E["Encoded"]>>()(
          Union([
            Struct({ _tag: Literal("Success"), value }),
            Struct({ _tag: Literal("Failure"), cause: Cause(error, defect) })
          ]),
          Transformation.transform({
            decode: (e): Exit_.Exit<A["Encoded"], E["Encoded"]> =>
              e._tag === "Success" ? Exit_.succeed(e.value) : Exit_.failCause(e.cause),
            encode: (exit) =>
              Exit_.isSuccess(exit)
                ? { _tag: "Success", value: exit.value } as const
                : { _tag: "Failure", cause: exit.cause } as const
          })
        ),
      toArbitrary: ([value, error, defect]) => (fc, ctx) =>
        fc.oneof(
          ctx?.isSuspend ? { maxDepth: 2, depthIdentifier: "Exit" } : {},
          value.map((v) => Exit_.succeed(v)),
          causeToArbitrary(error, defect)(fc, ctx).map((cause) => Exit_.failCause(cause))
        ),
      toEquivalence: ([value, error, defect]) => {
        const cause = causeToEquivalence(error, defect)
        return (a, b) => {
          if (a._tag !== b._tag) return false
          switch (a._tag) {
            case "Success":
              return value(a.value, (b as Exit_.Success<A["Type"]>).value)
            case "Failure":
              return cause(a.cause, (b as Exit_.Failure<E["Type"], D["Type"]>).cause)
          }
        }
      },
      toFormatter: ([value, error, defect]) => {
        const cause = causeToFormatter(error, defect)
        return (t) => {
          switch (t._tag) {
            case "Success":
              return `Exit.Success(${value(t.value)})`
            case "Failure":
              return `Exit.Failure(${cause(t.cause)})`
          }
        }
      }
    }
  )
  return make(schema.ast, { value, error, defect })
}

/**
 * Type-level representation of a `ReadonlyMap` schema whose keys and values are
 * validated by the provided schemas.
 *
 * **When to use**
 *
 * Use as a type annotation for a `ReadonlyMap` schema when exposing or returning
 * the schema while preserving its key schema, value schema, and ISO
 * representation.
 *
 * @see {@link ReadonlyMap} for constructing this schema type from key and value schemas
 * @see {@link ReadonlyMapIso} for the readonly tuple-array ISO representation used by this schema
 *
 * @category ReadonlyMap
 * @since 4.0.0
 */
export interface $ReadonlyMap<Key extends Top, Value extends Top> extends
  declareConstructor<
    globalThis.ReadonlyMap<Key["Type"], Value["Type"]>,
    globalThis.ReadonlyMap<Key["Encoded"], Value["Encoded"]>,
    readonly [Key, Value],
    ReadonlyMapIso<Key, Value>
  >
{
  readonly "Rebuild": $ReadonlyMap<Key, Value>
  readonly key: Key
  readonly value: Value
}

/**
 * Iso representation used for `ReadonlyMap` schemas: an array of readonly
 * `[key, value]` tuples using each entry schema's `Iso` type.
 *
 * @category ReadonlyMap
 * @since 4.0.0
 */
export type ReadonlyMapIso<Key extends Top, Value extends Top> = ReadonlyArray<readonly [Key["Iso"], Value["Iso"]]>

/**
 * Schema for readonly maps whose keys and values conform to the provided
 * schemas.
 *
 * @category ReadonlyMap
 * @since 3.10.0
 */
export function ReadonlyMap<Key extends Top, Value extends Top>(key: Key, value: Value): $ReadonlyMap<Key, Value> {
  const schema = declareConstructor<
    globalThis.ReadonlyMap<Key["Type"], Value["Type"]>,
    globalThis.ReadonlyMap<Key["Encoded"], Value["Encoded"]>,
    ReadonlyMapIso<Key, Value>
  >()(
    [key, value],
    ([key, value]) => {
      const array = ArraySchema(Tuple([key, value]))
      return (input, ast, options) => {
        if (input instanceof globalThis.Map) {
          return Effect.mapBothEager(
            Parser.decodeUnknownEffect(array)([...input], options),
            {
              onSuccess: (array: ReadonlyArray<readonly [Key["Type"], Value["Type"]]>) => new globalThis.Map(array),
              onFailure: (issue) =>
                new Issue.Composite(ast, Option_.some(input), [new Issue.Pointer(["entries"], issue)])
            }
          )
        }
        return Effect.fail(new Issue.InvalidType(ast, Option_.some(input)))
      }
    },
    {
      typeConstructor: {
        _tag: "ReadonlyMap"
      },
      generation: {
        runtime: `Schema.ReadonlyMap(?, ?)`,
        Type: `globalThis.ReadonlyMap<?, ?>`
      },
      expected: "ReadonlyMap",
      toCodec: ([key, value]) =>
        link<globalThis.Map<Key["Encoded"], Value["Encoded"]>>()(
          ArraySchema(Tuple([key, value])),
          Transformation.transform({
            decode: (e) => new globalThis.Map(e),
            encode: (map) => [...map.entries()]
          })
        ),
      toArbitrary: ([key, value]) => (fc, ctx) => {
        return fc.oneof(
          ctx?.isSuspend ? { maxDepth: 2, depthIdentifier: "ReadonlyMap" } : {},
          fc.constant([]),
          fc.array(fc.tuple(key, value), ctx?.constraints?.array)
        ).map((as) => new globalThis.Map(as))
      },
      toEquivalence: ([key, value]) => Equal.makeCompareMap(key, value),
      toFormatter: ([key, value]) => (t) => {
        const size = t.size
        if (size === 0) {
          return "ReadonlyMap(0) {}"
        }
        const entries = globalThis.Array.from(t.entries()).sort().map(([k, v]) => `${key(k)} => ${value(v)}`)
        return `ReadonlyMap(${size}) { ${entries.join(", ")} }`
      }
    }
  )
  return make(schema.ast, { key, value })
}

/**
 * Schema for an Effect `HashMap` where keys and values must conform to the
 * provided schemas.
 *
 * @category HashMap
 * @since 3.10.0
 */
export interface HashMap<Key extends Top, Value extends Top> extends
  declareConstructor<
    HashMap_.HashMap<Key["Type"], Value["Type"]>,
    HashMap_.HashMap<Key["Encoded"], Value["Encoded"]>,
    readonly [Key, Value],
    HashMapIso<Key, Value>
  >
{
  readonly "Rebuild": HashMap<Key, Value>
  readonly key: Key
  readonly value: Value
}

/**
 * Iso representation used for `HashMap` schemas: an array of readonly
 * `[key, value]` tuples using each entry schema's `Iso` type.
 *
 * @category HashMap
 * @since 4.0.0
 */
export type HashMapIso<Key extends Top, Value extends Top> = ReadonlyArray<readonly [Key["Iso"], Value["Iso"]]>

/**
 * Schema for hash maps whose keys and values conform to the provided schemas.
 *
 * @category HashMap
 * @since 3.10.0
 */
export function HashMap<Key extends Top, Value extends Top>(key: Key, value: Value): HashMap<Key, Value> {
  const schema = declareConstructor<
    HashMap_.HashMap<Key["Type"], Value["Type"]>,
    HashMap_.HashMap<Key["Encoded"], Value["Encoded"]>,
    HashMapIso<Key, Value>
  >()(
    [key, value],
    ([key, value]) => {
      const entries = ArraySchema(Tuple([key, value]))
      return (input, ast, options) => {
        if (HashMap_.isHashMap(input)) {
          return Effect.mapBothEager(
            Parser.decodeUnknownEffect(entries)(HashMap_.toEntries(input), options),
            {
              onSuccess: HashMap_.fromIterable,
              onFailure: (issue) =>
                new Issue.Composite(ast, Option_.some(input), [new Issue.Pointer(["entries"], issue)])
            }
          )
        }
        return Effect.fail(new Issue.InvalidType(ast, Option_.some(input)))
      }
    },
    {
      typeConstructor: {
        _tag: "effect/HashMap"
      },
      generation: {
        runtime: `Schema.HashMap(?, ?)`,
        Type: `HashMap.HashMap<?, ?>`,
        importDeclaration: `import * as HashMap from "effect/HashMap"`
      },
      expected: "HashMap",
      toCodec: ([key, value]) =>
        link<HashMap_.HashMap<Key["Encoded"], Value["Encoded"]>>()(
          ArraySchema(Tuple([key, value])),
          Transformation.transform({
            decode: HashMap_.fromIterable,
            encode: HashMap_.toEntries
          })
        ),
      toArbitrary: ([key, value]) => (fc, ctx) => {
        return fc.oneof(
          ctx?.isSuspend ? { maxDepth: 2, depthIdentifier: "HashMap" } : {},
          fc.constant([]),
          fc.array(fc.tuple(key, value), ctx?.constraints?.array)
        ).map(HashMap_.fromIterable)
      },
      toEquivalence: ([key, value]) => Equal.makeCompareMap(key, value),
      toFormatter: ([key, value]) => (t) => {
        const size = HashMap_.size(t)
        if (size === 0) {
          return "HashMap(0) {}"
        }
        const entries = HashMap_.toEntries(t).sort().map(([k, v]) => `${key(k)} => ${value(v)}`)
        return `HashMap(${size}) { ${entries.join(", ")} }`
      }
    }
  )
  return make(schema.ast, { key, value })
}

/**
 * Type-level representation of a `ReadonlySet` schema whose values are validated
 * by the provided element schema.
 *
 * **When to use**
 *
 * Use to name or constrain the schema type produced by `ReadonlySet` when
 * generic code needs to retain the element schema type.
 *
 * @see {@link ReadonlySet} for constructing this schema type
 * @see {@link ReadonlySetIso} for the array representation used by this schema's ISO
 *
 * @category ReadonlySet
 * @since 4.0.0
 */
export interface $ReadonlySet<Value extends Top> extends
  declareConstructor<
    globalThis.ReadonlySet<Value["Type"]>,
    globalThis.ReadonlySet<Value["Encoded"]>,
    readonly [Value],
    ReadonlySetIso<Value>
  >
{
  readonly "Rebuild": $ReadonlySet<Value>
  readonly value: Value
}

/**
 * Iso representation used for `ReadonlySet` schemas: an array of element values
 * using the element schema's `Iso` type.
 *
 * @category ReadonlySet
 * @since 4.0.0
 */
export type ReadonlySetIso<Value extends Top> = ReadonlyArray<Value["Iso"]>

/**
 * Schema for readonly sets whose values conform to the provided element schema.
 *
 * @category ReadonlySet
 * @since 3.10.0
 */
export function ReadonlySet<Value extends Top>(value: Value): $ReadonlySet<Value> {
  const schema = declareConstructor<
    globalThis.ReadonlySet<Value["Type"]>,
    globalThis.ReadonlySet<Value["Encoded"]>,
    ReadonlySetIso<Value>
  >()(
    [value],
    ([value]) => {
      const array = ArraySchema(value)
      return (input, ast, options) => {
        if (input instanceof globalThis.Set) {
          return Effect.mapBothEager(
            Parser.decodeUnknownEffect(array)([...input], options),
            {
              onSuccess: (array: ReadonlyArray<Value["Type"]>) => new globalThis.Set(array),
              onFailure: (issue) =>
                new Issue.Composite(ast, Option_.some(input), [new Issue.Pointer(["values"], issue)])
            }
          )
        }
        return Effect.fail(new Issue.InvalidType(ast, Option_.some(input)))
      }
    },
    {
      typeConstructor: {
        _tag: "ReadonlySet"
      },
      generation: {
        runtime: `Schema.ReadonlySet(?)`,
        Type: `globalThis.ReadonlySet<?>`
      },
      expected: "ReadonlySet",
      toCodec: ([value]) =>
        link<globalThis.Set<Value["Encoded"]>>()(
          ArraySchema(value),
          Transformation.transform({
            decode: (e) => new globalThis.Set(e),
            encode: (set) => [...set.values()]
          })
        ),
      toArbitrary: ([value]) => (fc, ctx) => {
        return fc.oneof(
          ctx?.isSuspend ? { maxDepth: 2, depthIdentifier: "ReadonlySet" } : {},
          fc.constant([]),
          fc.array(value, ctx?.constraints?.array)
        ).map((as) => new globalThis.Set(as))
      },
      toEquivalence: ([value]) => Equal.makeCompareSet(value),
      toFormatter: ([value]) => (t) => {
        const size = t.size
        if (size === 0) {
          return "ReadonlySet(0) {}"
        }
        const values = globalThis.Array.from(t.values()).sort().map((v) => `${value(v)}`)
        return `ReadonlySet(${size}) { ${values.join(", ")} }`
      }
    }
  )
  return make(schema.ast, { value })
}

/**
 * Schema for an Effect `HashSet` where values must conform to the provided
 * schema.
 *
 * @category HashSet
 * @since 3.10.0
 */
export interface HashSet<Value extends Top> extends
  declareConstructor<
    HashSet_.HashSet<Value["Type"]>,
    HashSet_.HashSet<Value["Encoded"]>,
    readonly [Value],
    HashSetIso<Value>
  >
{
  readonly "Rebuild": HashSet<Value>
  readonly value: Value
}

/**
 * Iso representation used for `HashSet` schemas: an array of element values
 * using the element schema's `Iso` type.
 *
 * @category HashSet
 * @since 4.0.0
 */
export type HashSetIso<Value extends Top> = ReadonlyArray<Value["Iso"]>

/**
 * Schema for hash sets whose values conform to the provided element schema.
 *
 * @category HashSet
 * @since 3.10.0
 */
export function HashSet<Value extends Top>(value: Value): HashSet<Value> {
  const schema = declareConstructor<
    HashSet_.HashSet<Value["Type"]>,
    HashSet_.HashSet<Value["Encoded"]>,
    HashSetIso<Value>
  >()(
    [value],
    ([value]) => {
      const values = ArraySchema(value)
      return (input, ast, options) => {
        if (HashSet_.isHashSet(input)) {
          return Effect.mapBothEager(
            Parser.decodeUnknownEffect(values)(Arr.fromIterable(input), options),
            {
              onSuccess: HashSet_.fromIterable,
              onFailure: (issue) =>
                new Issue.Composite(ast, Option_.some(input), [new Issue.Pointer(["values"], issue)])
            }
          )
        }
        return Effect.fail(new Issue.InvalidType(ast, Option_.some(input)))
      }
    },
    {
      typeConstructor: {
        _tag: "effect/HashSet"
      },
      generation: {
        runtime: `Schema.HashSet(?)`,
        Type: `HashSet.HashSet<?>`
      },
      expected: "HashSet",
      toCodec: ([value]) =>
        link<HashSet_.HashSet<Value["Encoded"]>>()(
          ArraySchema(value),
          Transformation.transform({
            decode: HashSet_.fromIterable,
            encode: Arr.fromIterable
          })
        ),
      toArbitrary: ([value]) => (fc, ctx) => {
        return fc.oneof(
          ctx?.isSuspend ? { maxDepth: 2, depthIdentifier: "HashSet" } : {},
          fc.constant([]),
          fc.array(value, ctx?.constraints?.array)
        ).map(HashSet_.fromIterable)
      },
      toEquivalence: ([value]) => Equal.makeCompareSet(value),
      toFormatter: ([value]) => (t) => {
        const size = HashSet_.size(t)
        if (size === 0) {
          return "HashSet(0) {}"
        }
        const values = globalThis.Array.from(t).sort().map((v) => `${value(v)}`)
        return `HashSet(${size}) { ${values.join(", ")} }`
      }
    }
  )
  return make(schema.ast, { value })
}

/**
 * Schema for an Effect `Chunk` (immutable array-like collection) where values
 * must conform to the provided schema.
 *
 * @category Chunk
 * @since 3.10.0
 */
export interface Chunk<Value extends Top> extends
  declareConstructor<
    Chunk_.Chunk<Value["Type"]>,
    Chunk_.Chunk<Value["Encoded"]>,
    readonly [Value],
    ChunkIso<Value>
  >
{
  readonly "Rebuild": Chunk<Value>
  readonly value: Value
}

/**
 * Iso representation used for `Chunk` schemas: an array of element values using
 * the element schema's `Iso` type.
 *
 * **When to use**
 *
 * Use when annotating type-level helpers that work with the readonly-array ISO
 * shape of a `Chunk` schema.
 *
 * @see {@link Chunk} for the schema interface and constructor that use this ISO representation
 *
 * @category Chunk
 * @since 4.0.0
 */
export type ChunkIso<Value extends Top> = ReadonlyArray<Value["Iso"]>

/**
 * Schema for chunks whose values conform to the provided element schema.
 *
 * @category Chunk
 * @since 3.10.0
 */
export function Chunk<Value extends Top>(value: Value): Chunk<Value> {
  const schema = declareConstructor<
    Chunk_.Chunk<Value["Type"]>,
    Chunk_.Chunk<Value["Encoded"]>,
    ChunkIso<Value>
  >()(
    [value],
    ([value]) => {
      const values = ArraySchema(value)
      return (input, ast, options) => {
        if (Chunk_.isChunk(input)) {
          return Effect.mapBothEager(
            Parser.decodeUnknownEffect(values)(Arr.fromIterable(input), options),
            {
              onSuccess: Chunk_.fromIterable,
              onFailure: (issue) =>
                new Issue.Composite(ast, Option_.some(input), [new Issue.Pointer(["values"], issue)])
            }
          )
        }
        return Effect.fail(new Issue.InvalidType(ast, Option_.some(input)))
      }
    },
    {
      typeConstructor: {
        _tag: "effect/Chunk"
      },
      generation: {
        runtime: `Schema.Chunk(?)`,
        Type: `Chunk.Chunk<?>`
      },
      expected: "Chunk",
      toCodec: ([value]) =>
        link<Chunk_.Chunk<Value["Encoded"]>>()(
          ArraySchema(value),
          Transformation.transform({
            decode: Chunk_.fromIterable,
            encode: Arr.fromIterable
          })
        ),
      toArbitrary: ([value]) => (fc, ctx) => {
        return fc.oneof(
          ctx?.isSuspend ? { maxDepth: 2, depthIdentifier: "Chunk" } : {},
          fc.constant([]),
          fc.array(value, ctx?.constraints?.array)
        ).map(Chunk_.fromIterable)
      },
      toEquivalence: ([value]) => Chunk_.makeEquivalence(value),
      toFormatter: ([value]) => (t) => {
        const size = Chunk_.size(t)
        if (size === 0) {
          return "Chunk(0) {}"
        }
        const values = globalThis.Array.from(t).sort().map((v) => `${value(v)}`)
        return `Chunk(${size}) { ${values.join(", ")} }`
      }
    }
  )
  return make(schema.ast, { value })
}

/**
 * Type-level representation of the schema for JavaScript `RegExp` instances.
 *
 * @category RegExp
 * @since 4.0.0
 */
export interface RegExp extends instanceOf<globalThis.RegExp> {
  readonly "Rebuild": RegExp
}

/**
 * Schema for JavaScript `RegExp` objects.
 *
 * **Details**
 *
 * The default JSON serializer encodes a `RegExp` as `{ source, flags }`.
 *
 * @category RegExp
 * @since 4.0.0
 */
export const RegExp: RegExp = instanceOf(
  globalThis.RegExp,
  {
    typeConstructor: {
      _tag: "RegExp"
    },
    generation: {
      runtime: `Schema.RegExp`,
      Type: `globalThis.RegExp`
    },
    expected: "RegExp",
    toCodecJson: () =>
      link<globalThis.RegExp>()(
        Struct({
          source: String,
          flags: String
        }),
        Transformation.transformOrFail({
          decode: (e) =>
            Effect.try({
              try: () => new globalThis.RegExp(e.source, e.flags),
              catch: (e) => new Issue.InvalidValue(Option_.some(e), { message: globalThis.String(e) })
            }),
          encode: (regExp) =>
            Effect.succeed({
              source: regExp.source,
              flags: regExp.flags
            })
        })
      ),
    toArbitrary: () => (fc) =>
      fc
        .tuple(
          fc.constantFrom(
            ".",
            ".*",
            "\\d+",
            "\\w+",
            "[a-z]+",
            "[A-Z]+",
            "[0-9]+",
            "^[a-zA-Z0-9]+$",
            "^\\d{4}-\\d{2}-\\d{2}$" // date pattern
          ),
          fc
            .uniqueArray(fc.constantFrom("g", "i", "m", "s", "u", "y"), {
              minLength: 0,
              maxLength: 6
            })
            .map((flags) => flags.join(""))
        )
        .map(([source, flags]) => new globalThis.RegExp(source, flags)),
    toEquivalence: () => (a, b) => a.source === b.source && a.flags === b.flags
  }
)

/**
 * Type-level representation of the schema for JavaScript `URL` instances.
 *
 * @category URL
 * @since 4.0.0
 */
export interface URL extends instanceOf<globalThis.URL> {
  readonly "Rebuild": URL
}

const URLString = String.annotate({ expected: "a string that will be decoded as a URL" })

/**
 * Schema for JavaScript `URL` objects.
 *
 * **Details**
 *
 * Default JSON serializer:
 *
 * - encodes `URL` as a `string`
 *
 * @category URL
 * @since 4.0.0
 */
export const URL: URL = instanceOf(
  globalThis.URL,
  {
    typeConstructor: {
      _tag: "URL"
    },
    generation: {
      runtime: `Schema.URL`,
      Type: `globalThis.URL`
    },
    expected: "URL",
    toCodecJson: () =>
      link<globalThis.URL>()(
        URLString,
        Transformation.urlFromString
      ),
    toArbitrary: () => (fc) => fc.webUrl().map((s) => new globalThis.URL(s)),
    toEquivalence: () => (a, b) => a.toString() === b.toString()
  }
)

/**
 * Type-level representation of a transformation schema that decodes valid URL
 * strings into JavaScript `URL` instances.
 *
 * @category URL
 * @since 4.0.0
 */
export interface URLFromString extends decodeTo<URL, String> {
  readonly "Rebuild": URLFromString
}

/**
 * Schema that decodes a `string` into a `URL`.
 *
 * **Details**
 *
 * Decoding:
 * - A **valid** URL `string` is decoded as a `URL`
 *
 * Encoding:
 * - A `URL` is encoded as a `string`
 *
 * @category URL
 * @since 4.0.0
 */
export const URLFromString: URLFromString = URLString.pipe(decodeTo(URL, Transformation.urlFromString))

/**
 * Type-level representation of the schema for JavaScript `Date` instances,
 * including invalid dates.
 *
 * @category Date
 * @since 4.0.0
 */
export interface Date extends instanceOf<globalThis.Date> {
  readonly "Rebuild": Date
}

const DateString = String.annotate({ expected: "a string in ISO 8601 format that will be decoded as a Date" })

/**
 * Schema for JavaScript `Date` objects.
 *
 * **When to use**
 *
 * Use to validate in-memory values that must already be JavaScript `Date`
 * instances.
 *
 * **Details**
 *
 * This schema accepts any `Date` instance, including invalid dates. The default
 * JSON serializer encodes valid dates as ISO 8601 strings; invalid dates encode
 * as `"Invalid Date"`.
 *
 * **Example** (Date schema)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * Schema.decodeUnknownSync(Schema.Date)(new Date("2024-01-01"))
 * // => Date { 2024-01-01T00:00:00.000Z }
 * ```
 *
 * @see {@link DateValid} for accepting only valid Date instances
 *
 * @category Date
 * @since 4.0.0
 */
export const Date: Date = instanceOf(
  globalThis.Date,
  {
    typeConstructor: {
      _tag: "Date"
    },
    generation: {
      runtime: `Schema.Date`,
      Type: `globalThis.Date`
    },
    expected: "Date",
    toCodecJson: () =>
      link<globalThis.Date>()(
        DateString,
        Transformation.dateFromString
      ),
    toArbitrary: () => (fc, ctx) => fc.date(ctx?.constraints?.date)
  }
)

/**
 * Type-level representation of a transformation schema that decodes strings into
 * JavaScript `Date` instances.
 *
 * @category Date
 * @since 3.10.0
 */
export interface DateFromString extends decodeTo<Date, String> {
  readonly "Rebuild": DateFromString
}

/**
 * Schema that decodes a string into a JavaScript `Date`.
 *
 * **When to use**
 *
 * Use to model string-encoded dates that decode to JavaScript `Date` objects
 * and encode back to strings.
 *
 * **Details**
 *
 * Decoding:
 * The string is passed to JavaScript `Date` construction.
 *
 * Encoding:
 * A valid `Date` is encoded as an ISO string; an invalid `Date` is encoded as
 * `"Invalid Date"`.
 *
 * **Gotchas**
 *
 * Invalid date strings can decode to invalid `Date` instances.
 *
 * @see {@link Date} for accepting Date instances directly
 * @see {@link DateValid} for rejecting invalid Date instances
 *
 * @category Date
 * @since 3.10.0
 */
export const DateFromString: DateFromString = DateString.pipe(decodeTo(Date, Transformation.dateFromString))

/**
 * Type-level representation of the `DateValid` schema, which accepts only valid
 * JavaScript `Date` instances.
 *
 * @category Date
 * @since 4.0.0
 */
export interface DateValid extends Date {
  readonly "Rebuild": DateValid
}

/**
 * Schema for **valid** JavaScript `Date` objects.
 *
 * **Details**
 *
 * This schema accepts `Date` instances but rejects invalid dates (such as `new
 * Date("invalid")`).
 *
 * @category Date
 * @since 4.0.0
 */
export const DateValid: DateValid = Date.check(isDateValid())

/**
 * Type-level representation of the schema for Effect `Duration` values.
 *
 * @category Duration
 * @since 3.10.0
 */
export interface Duration extends declare<Duration_.Duration> {
  readonly "Rebuild": Duration
}

/**
 * Schema for `Duration` values.
 *
 * **Details**
 *
 * The default JSON serializer encodes `Duration` as a tagged object with the
 * duration type and value.
 *
 * **Example** (Duration schema)
 *
 * ```ts
 * import { Duration, Schema } from "effect"
 *
 * Schema.decodeUnknownSync(Schema.Duration)(Duration.seconds(5))
 * // => Duration(5s)
 * ```
 *
 * @category Duration
 *
 * @since 3.10.0
 */
export const Duration: Duration = declare(
  Duration_.isDuration,
  {
    typeConstructor: {
      _tag: "effect/Duration"
    },
    generation: {
      runtime: `Schema.Duration`,
      Type: `Duration.Duration`,
      importDeclaration: `import * as Duration from "effect/Duration"`
    },
    expected: "Duration",
    toCodecJson: () =>
      link<Duration_.Duration>()(
        Union([
          Struct({ _tag: Literal("Infinity") }),
          Struct({ _tag: Literal("NegativeInfinity") }),
          Struct({ _tag: Literal("Nanos"), value: BigInt }),
          Struct({ _tag: Literal("Millis"), value: Int })
        ]),
        Transformation.transform({
          decode: (e) => {
            switch (e._tag) {
              case "Infinity":
                return Duration_.infinity
              case "NegativeInfinity":
                return Duration_.negativeInfinity
              case "Nanos":
                return Duration_.nanos(e.value)
              case "Millis":
                return Duration_.millis(e.value)
            }
          },
          encode: (duration) => {
            switch (duration.value._tag) {
              case "Infinity":
                return { _tag: "Infinity" } as const
              case "NegativeInfinity":
                return { _tag: "NegativeInfinity" } as const
              case "Nanos":
                return { _tag: "Nanos", value: duration.value.nanos } as const
              case "Millis":
                return { _tag: "Millis", value: duration.value.millis } as const
            }
          }
        })
      ),
    toArbitrary: () => (fc) =>
      fc.oneof(
        fc.constant(Duration_.infinity),
        fc.constant(Duration_.negativeInfinity),
        fc.bigInt().map(Duration_.nanos),
        fc.maxSafeInteger().map(Duration_.millis)
      ),
    toFormatter: () => globalThis.String,
    toEquivalence: () => Duration_.Equivalence
  }
)

const DurationString = String.annotate({ expected: "a string that will be decoded as a Duration" })

/**
 * Type-level representation of a transformation schema that decodes strings
 * accepted by `Duration.fromInput` into `Duration` values.
 *
 * @category Duration
 * @since 4.0.0
 */
export interface DurationFromString extends decodeTo<Duration, String> {
  readonly "Rebuild": DurationFromString
}

/**
 * Schema that parses a string into a `Duration`.
 *
 * **Details**
 *
 * Decoding:
 * - A `string` is decoded as a `Duration`, accepting any format that
 *   `Duration.fromInput` can parse.
 *
 * Encoding:
 * - A `Duration` is encoded as a parseable `string`.
 *
 * @category Duration
 * @since 4.0.0
 */
export const DurationFromString: DurationFromString = DurationString.pipe(
  decodeTo(Duration, Transformation.durationFromString)
)

/**
 * Type-level representation of a transformation schema that decodes non-negative
 * nanosecond `bigint` values into `Duration` values.
 *
 * @category Duration
 * @since 3.10.0
 */
export interface DurationFromNanos extends decodeTo<Duration, BigInt> {
  readonly "Rebuild": DurationFromNanos
}

const bigint0 = globalThis.BigInt(0)

/**
 * Schema that decodes a non-negative `bigint` into a
 * `Duration`, treating the bigint as nanoseconds.
 *
 * **Details**
 *
 * Decoding:
 * A non-negative `bigint` representing nanoseconds is decoded as a `Duration`.
 *
 * Encoding:
 * Finite durations are encoded as a non-negative `bigint` number of nanoseconds.
 * Encoding fails when the duration cannot be represented as nanoseconds, such as
 * `Duration.infinity`.
 *
 * @category Duration
 * @since 3.10.0
 */
export const DurationFromNanos: DurationFromNanos = BigInt.check(isGreaterThanOrEqualToBigInt(bigint0)).pipe(
  decodeTo(Duration, Transformation.durationFromNanos)
)

/**
 * Type-level representation of a transformation schema that decodes
 * non-negative millisecond numbers into `Duration` values.
 *
 * @category Duration
 * @since 3.10.0
 */
export interface DurationFromMillis extends decodeTo<Duration, Number> {
  readonly "Rebuild": DurationFromMillis
}

/**
 * Schema that decodes a non-negative (possibly infinite)
 * integer into a `Duration`, treating the integer value as the duration in
 * milliseconds.
 *
 * **Details**
 *
 * Decoding:
 * - A non-negative (possibly infinite) integer representing milliseconds is
 *   decoded as a `Duration`
 *
 * Encoding:
 * - A `Duration` is encoded to a non-negative (possibly infinite) integer
 *   representing milliseconds
 *
 * @category Duration
 * @since 3.10.0
 */
export const DurationFromMillis: DurationFromMillis = Number.check(isGreaterThanOrEqualTo(0)).pipe(
  decodeTo(Duration, Transformation.durationFromMillis)
)

/**
 * Type-level representation of the schema for Effect `BigDecimal` values.
 *
 * @category BigDecimal
 * @since 3.10.0
 */
export interface BigDecimal extends declare<BigDecimal_.BigDecimal> {
  readonly "Rebuild": BigDecimal
}

const BigDecimalString = String.annotate({ expected: "a string that will be decoded as a BigDecimal" })

/**
 * Schema for `BigDecimal` values.
 *
 * **When to use**
 *
 * Use when values are already Effect decimal instances and need schema
 * validation, formatting, equivalence, and JSON string serialization.
 *
 * **Details**
 *
 * Default JSON serializer:
 *
 * - encodes `BigDecimal` as a `string`
 *
 * @see {@link BigDecimalFromString} for parsing string input into a BigDecimal
 *
 * @category BigDecimal
 * @since 3.10.0
 */
export const BigDecimal: BigDecimal = declare(
  BigDecimal_.isBigDecimal,
  {
    typeConstructor: {
      _tag: "effect/BigDecimal"
    },
    generation: {
      runtime: `Schema.BigDecimal`,
      Type: `BigDecimal.BigDecimal`,
      importDeclaration: `import * as BigDecimal from "effect/BigDecimal"`
    },
    expected: "BigDecimal",
    toCodecJson: () =>
      link<BigDecimal_.BigDecimal>()(
        BigDecimalString,
        Transformation.bigDecimalFromString
      ),
    toArbitrary: () => (fc) =>
      fc.tuple(fc.bigInt(), fc.integer({ min: 0, max: 20 }))
        .map(([value, scale]) => BigDecimal_.make(value, scale)),
    toFormatter: () => (bd) => BigDecimal_.format(bd),
    toEquivalence: () => BigDecimal_.Equivalence
  }
)

/**
 * Type-level representation of a transformation schema that decodes strings into
 * `BigDecimal` values.
 *
 * @category BigDecimal
 * @since 4.0.0
 */
export interface BigDecimalFromString extends decodeTo<BigDecimal, String> {
  readonly "Rebuild": BigDecimalFromString
}

/**
 * Schema that parses a string into a `BigDecimal`.
 *
 * **When to use**
 *
 * Use to parse decimal or exponent-notation strings into arbitrary-precision
 * BigDecimal values while encoding them back to strings.
 *
 * **Details**
 *
 * Decoding:
 * - A `string` is decoded with `BigDecimal.fromString`.
 *
 * Encoding:
 * - A `BigDecimal` is encoded with `BigDecimal.format`.
 *
 * **Gotchas**
 *
 * An empty string decodes as zero.
 *
 * @see {@link BigDecimal} for validating values that are already BigDecimal values
 * @see {@link BigIntFromString} for parsing base-10 integer strings into bigint values
 * @see {@link NumberFromString} for parsing JavaScript number strings
 *
 * @category BigDecimal
 * @since 4.0.0
 */
export const BigDecimalFromString: BigDecimalFromString = BigDecimalString.pipe(
  decodeTo(BigDecimal, Transformation.bigDecimalFromString)
)

/**
 * Type-level representation of a transformation schema that decodes
 * JSON-encoded strings into `unknown` values.
 *
 * @category JSON
 * @since 4.0.0
 */
export interface UnknownFromJsonString extends fromJsonString<Unknown> {
  readonly "Rebuild": UnknownFromJsonString
}

/**
 * Schema that decodes a JSON-encoded string into an `unknown` value.
 *
 * **Details**
 *
 * Decoding:
 * - A `string` is decoded as an `unknown` value.
 * - If the string is not valid JSON, decoding fails.
 *
 * Encoding:
 * - Any value is encoded as a JSON string using `JSON.stringify`.
 * - If the value is not a valid JSON value, encoding fails.
 *
 * **Example** (Decoding unknown JSON strings)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(`{"a":1,"b":2}`)
 * // => { a: 1, b: 2 }
 * ```
 *
 * @category JSON
 * @since 4.0.0
 */
export const UnknownFromJsonString: UnknownFromJsonString = fromJsonString(Unknown)

/**
 * Type-level representation of a schema that parses a JSON string and then
 * decodes the parsed value with the provided schema.
 *
 * @category JSON
 * @since 4.0.0
 */
export interface fromJsonString<S extends Top> extends decodeTo<S, String> {
  readonly "Rebuild": fromJsonString<S>
}

/**
 * Returns a schema that decodes a JSON string and then decodes the parsed value
 * using the given schema.
 *
 * **Details**
 *
 * This is useful when working with JSON-encoded strings where the actual
 * structure of the value is known and described by an existing schema.
 *
 * The resulting schema first parses the input string as JSON, and then runs the
 * provided schema on the parsed result.
 *
 * JSON Schema generation:
 *
 * When using `fromJsonString` with `draft-2020-12` or `openApi3.1`, the
 * resulting schema will be a JSON Schema with a `contentSchema` property that
 * contains the JSON Schema for the given schema.
 *
 * **Example** (Decoding JSON strings with a schema)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.Struct({ a: Schema.Number })
 * const schemaFromJsonString = Schema.fromJsonString(schema)
 *
 * Schema.decodeUnknownSync(schemaFromJsonString)(`{"a":1,"b":2}`)
 * // => { a: 1 }
 * ```
 *
 * **Example** (Emitting JSON Schema for a JSON string decoder)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const original = Schema.Struct({ a: Schema.String })
 * const schema = Schema.fromJsonString(original)
 *
 * const document = Schema.toJsonSchemaDocument(schema)
 *
 * console.log(JSON.stringify(document, null, 2))
 * // {
 * //   "source": "draft-2020-12",
 * //   "schema": {
 * //     "type": "string",
 * //     "contentMediaType": "application/json",
 * //     "contentSchema": {
 * //       "type": "object",
 * //       "properties": {
 * //         "a": {
 * //           "type": "string"
 * //         }
 * //       },
 * //       "required": [
 * //         "a"
 * //       ],
 * //       "additionalProperties": false
 * //     }
 * //   },
 * //   "definitions": {}
 * // }
 * ```
 *
 * @category JSON
 * @since 4.0.0
 */
export function fromJsonString<S extends Top>(schema: S): fromJsonString<S> {
  return String.annotate({
    expected: "a string that will be decoded as JSON",
    contentMediaType: "application/json",
    contentSchema: AST.toEncoded(schema.ast)
  }).pipe(decodeTo(schema, Transformation.fromJsonString))
}

/**
 * Type-level representation of the schema for JavaScript `File` instances.
 *
 * @category File
 * @since 4.0.0
 */
export interface File extends instanceOf<globalThis.File> {
  readonly "Rebuild": File
}

/**
 * Schema for JavaScript `File` objects.
 *
 * **Details**
 *
 * The default JSON serializer encodes a `File` as `{ data, type, name, lastModified }`
 * where `data` is base64-encoded.
 *
 * @category File
 * @since 4.0.0
 */
export const File: File = instanceOf(globalThis.File, {
  typeConstructor: {
    _tag: "File"
  },
  generation: {
    runtime: `Schema.File`,
    Type: `globalThis.File`
  },
  expected: "File",
  toCodecJson: () =>
    link<globalThis.File>()(
      Struct({
        data: String.check(isBase64()),
        type: String,
        name: String,
        lastModified: Number
      }),
      Transformation.transformOrFail({
        decode: (e) =>
          Result_.match(Encoding.decodeBase64(e.data), {
            onFailure: (error) =>
              Effect.fail(
                new Issue.InvalidValue(Option_.some(e.data), {
                  message: error.message
                })
              ),
            onSuccess: (bytes) => {
              const buffer = new globalThis.Uint8Array(bytes)
              return Effect.succeed(
                new globalThis.File([buffer], e.name, { type: e.type, lastModified: e.lastModified })
              )
            }
          }),
        encode: (file) =>
          Effect.tryPromise({
            try: async () => {
              const bytes = new globalThis.Uint8Array(await file.arrayBuffer())
              return {
                data: Encoding.encodeBase64(bytes),
                type: file.type,
                name: file.name,
                lastModified: file.lastModified
              }
            },
            catch: (e) =>
              new Issue.InvalidValue(Option_.some(file), {
                message: globalThis.String(e)
              })
          })
      })
    )
})

/**
 * Type-level representation of the schema for JavaScript `FormData` instances.
 *
 * @category FormData
 * @since 4.0.0
 */
export interface FormData extends instanceOf<globalThis.FormData> {
  readonly "Rebuild": FormData
}

/**
 * Schema for JavaScript `FormData` objects.
 *
 * **Details**
 *
 * The default JSON serializer encodes a `FormData` as an array of `[key, entry]`
 * pairs where each entry is tagged as `"String"` or `"File"`.
 *
 * @category FormData
 * @since 4.0.0
 */
export const FormData: FormData = instanceOf(globalThis.FormData, {
  typeConstructor: {
    _tag: "FormData"
  },
  generation: {
    runtime: `Schema.FormData`,
    Type: `globalThis.FormData`
  },
  expected: "FormData",
  toCodecJson: () =>
    link<globalThis.FormData>()(
      ArraySchema(
        Tuple([
          String,
          Union([
            Struct({ _tag: tag("String"), value: String }),
            Struct({ _tag: tag("File"), value: File })
          ])
        ])
      ),
      Transformation.transformOrFail({
        decode: (e) => {
          const out = new globalThis.FormData()
          for (const [key, entry] of e) {
            out.append(key, entry.value)
          }
          return Effect.succeed(out)
        },
        encode: (formData) => {
          return Effect.succeed(
            globalThis.Array.from(formData.entries()).map(([key, value]) => {
              if (typeof value === "string") {
                return [key, { _tag: "String", value }] as const
              } else {
                return [key, { _tag: "File", value }] as const
              }
            })
          )
        }
      })
    )
})

/**
 * Type-level representation of a schema that parses `FormData` into a tree
 * record and then decodes it with the provided schema.
 *
 * @category FormData
 * @since 4.0.0
 */
export interface fromFormData<S extends Top> extends decodeTo<S, FormData> {
  readonly "Rebuild": fromFormData<S>
}

/**
 * Schema for decoding `FormData` through a bracket-notation tree.
 *
 * **When to use**
 *
 * Use to decode browser or multipart form data into a structured schema value.
 *
 * **Details**
 *
 * The decoding process has two steps:
 *
 * 1. Parse `FormData` into a nested tree record.
 * 2. Decode the parsed value with the given schema.
 *
 * You can express nested values using bracket notation.
 *
 * If you want to decode values that are not strings, use
 * `Schema.toCodecStringTree` with the `keepDeclarations: true` option.
 * This serializer preserves values such as numbers and `Blob` objects when
 * compatible with the schema.
 *
 * **Example** (Decoding a flat structure)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.fromFormData(
 *   Schema.Struct({
 *     a: Schema.String
 *   })
 * )
 *
 * const formData = new FormData()
 * formData.append("a", "1")
 * formData.append("b", "2")
 *
 * console.log(String(Schema.decodeUnknownExit(schema)(formData)))
 * // Success({"a":"1"})
 * ```
 *
 * **Example** (Nested fields)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.fromFormData(
 *   Schema.Struct({
 *     a: Schema.String,
 *     b: Schema.Struct({
 *       c: Schema.String,
 *       d: Schema.String
 *     })
 *   })
 * )
 *
 * const formData = new FormData()
 * formData.append("a", "1")
 * formData.append("b[c]", "2")
 * formData.append("b[d]", "3")
 *
 * console.log(String(Schema.decodeUnknownExit(schema)(formData)))
 * // Success({"a":"1","b":{"c":"2","d":"3"}})
 * ```
 *
 * **Example** (Parsing non-string values)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.fromFormData(
 *   Schema.toCodecStringTree(
 *     Schema.Struct({
 *       a: Schema.Int
 *     }),
 *     { keepDeclarations: true }
 *   )
 * )
 *
 * const formData = new FormData()
 * formData.append("a", "1")
 *
 * console.log(String(Schema.decodeUnknownExit(schema)(formData)))
 * // Success({"a":1}) // Note: the value is a number
 * ```
 *
 * @category decoding
 * @since 4.0.0
 */
export function fromFormData<S extends Top>(schema: S): fromFormData<S> {
  return FormData.pipe(decodeTo(schema, Transformation.fromFormData))
}

/**
 * Type-level representation of the schema for JavaScript `URLSearchParams`
 * instances.
 *
 * @category URLSearchParams
 * @since 4.0.0
 */
export interface URLSearchParams extends instanceOf<globalThis.URLSearchParams> {
  readonly "Rebuild": URLSearchParams
}

/**
 * Schema for JavaScript `URLSearchParams` objects.
 *
 * **Details**
 *
 * The default JSON serializer encodes a `URLSearchParams` as a query string.
 *
 * @category URLSearchParams
 * @since 4.0.0
 */
export const URLSearchParams: URLSearchParams = instanceOf(globalThis.URLSearchParams, {
  typeConstructor: {
    _tag: "URLSearchParams"
  },
  generation: {
    runtime: `Schema.URLSearchParams`,
    Type: `globalThis.URLSearchParams`
  },
  expected: "URLSearchParams",
  toCodecJson: () =>
    link<globalThis.URLSearchParams>()(
      String.annotate({ expected: "a query string that will be decoded as URLSearchParams" }),
      Transformation.transform({
        decode: (e) => new globalThis.URLSearchParams(e),
        encode: (params) => params.toString()
      })
    )
})

/**
 * Type-level representation of a schema that parses `URLSearchParams` into a
 * tree record and then decodes it with the provided schema.
 *
 * @category URLSearchParams
 * @since 4.0.0
 */
export interface fromURLSearchParams<S extends Top> extends decodeTo<S, URLSearchParams> {
  readonly "Rebuild": fromURLSearchParams<S>
}

/**
 * Schema for decoding `URLSearchParams` through a bracket-notation tree.
 *
 * **When to use**
 *
 * Use to decode query parameters into a structured schema value.
 *
 * **Details**
 *
 * The decoding process has two steps:
 *
 * 1. Parse `URLSearchParams` into a nested tree record.
 * 2. Decode the parsed value with the given schema.
 *
 * You can express nested values using bracket notation.
 *
 * If you want to decode values that are not strings, use
 * `Schema.toCodecStringTree`. This serializer preserves values such as
 * numbers when compatible with the schema.
 *
 * **Example** (Decoding a flat structure)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.fromURLSearchParams(
 *   Schema.Struct({
 *     a: Schema.String
 *   })
 * )
 *
 * const urlSearchParams = new URLSearchParams("a=1&b=2")
 *
 * console.log(String(Schema.decodeUnknownExit(schema)(urlSearchParams)))
 * // Success({"a":"1"})
 * ```
 *
 * **Example** (Nested fields)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.fromURLSearchParams(
 *   Schema.Struct({
 *     a: Schema.String,
 *     b: Schema.Struct({
 *       c: Schema.String,
 *       d: Schema.String
 *     })
 *   })
 * )
 *
 * const urlSearchParams = new URLSearchParams("a=1&b[c]=2&b[d]=3")
 *
 * console.log(String(Schema.decodeUnknownExit(schema)(urlSearchParams)))
 * // Success({"a":"1","b":{"c":"2","d":"3"}})
 * ```
 *
 * **Example** (Parsing non-string values)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const schema = Schema.fromURLSearchParams(
 *   Schema.toCodecStringTree(
 *     Schema.Struct({
 *       a: Schema.Int
 *     })
 *   )
 * )
 *
 * const urlSearchParams = new URLSearchParams("a=1&b=2")
 *
 * console.log(String(Schema.decodeUnknownExit(schema)(urlSearchParams)))
 * // Success({"a":1}) // Note: the value is a number
 * ```
 *
 * @category decoding
 * @since 4.0.0
 */
export function fromURLSearchParams<S extends Top>(schema: S): fromURLSearchParams<S> {
  return URLSearchParams.pipe(decodeTo(schema, Transformation.fromURLSearchParams))
}

/**
 * Type-level representation of the `Finite` number schema, which rejects `NaN`,
 * `Infinity`, and `-Infinity`.
 *
 * @category Number
 * @since 3.10.0
 */
export interface Finite extends Number {
  readonly "Rebuild": Finite
}

/**
 * Schema for finite numbers, rejecting `NaN`, `Infinity`, and `-Infinity`.
 *
 * @category Number
 * @since 3.10.0
 */
export const Finite: Finite = Number.check(isFinite())

/**
 * Type-level representation of the `Int` schema, which accepts only finite
 * integer numbers.
 *
 * @category Number
 * @since 3.10.0
 */
export interface Int extends Number {
  readonly "Rebuild": Int
}

/**
 * Schema for integers, rejecting `NaN`, `Infinity`, and `-Infinity`.
 *
 * @category Number
 * @since 3.10.0
 */
export const Int: Int = Number.check(isInt())

/**
 * Type-level representation of a transformation schema that decodes strings into
 * numbers using JavaScript number coercion.
 *
 * @category Number
 * @since 3.10.0
 */
export interface NumberFromString extends decodeTo<Finite, String> {
  readonly "Rebuild": NumberFromString
}

/**
 * Schema that parses a string into a `number` using JavaScript
 * number coercion.
 *
 * **Details**
 *
 * Decoding:
 * A `string` is decoded as a number, including possible non-finite values such as
 * `NaN`, `Infinity`, and `-Infinity`. Use `FiniteFromString` to reject non-finite
 * numbers.
 *
 * Encoding:
 * A number is encoded as a `string`.
 *
 * @category Number
 * @since 3.10.0
 */
export const NumberFromString: NumberFromString = String.annotate({
  expected: "a string that will be decoded as a number"
}).pipe(decodeTo(Number, Transformation.numberFromString))

/**
 * Type-level representation of a transformation schema that decodes strings into
 * finite numbers.
 *
 * @category Number
 * @since 4.0.0
 */
export interface FiniteFromString extends decodeTo<Finite, String> {
  readonly "Rebuild": FiniteFromString
}

/**
 * Schema that parses a string into a finite number.
 *
 * **Details**
 *
 * Decoding:
 * - A `string` is decoded as a finite number, rejecting `NaN`, `Infinity`, and
 *   `-Infinity` values.
 *
 * Encoding:
 * - A finite number is encoded as a `string`.
 *
 * @category Number
 * @since 4.0.0
 */
export const FiniteFromString: FiniteFromString = String.annotate({
  expected: "a string that will be decoded as a finite number"
}).pipe(decodeTo(Finite, Transformation.numberFromString))

/**
 * Type-level representation of a transformation schema that decodes strings into
 * `bigint` values.
 *
 * @category BigInt
 * @since 4.0.0
 */
export interface BigIntFromString extends decodeTo<BigInt, String> {
  readonly "Rebuild": BigIntFromString
}

/**
 * Schema that parses a string into a `bigint`.
 *
 * **When to use**
 *
 * Use to parse signed base-10 integer strings into bigint values while encoding
 * bigint values back to decimal strings.
 *
 * **Details**
 *
 * Decoding:
 * - A `string` is decoded as a `bigint`.
 *
 * Encoding:
 * - A `bigint` is encoded as a `string`.
 *
 * **Gotchas**
 *
 * Decoding accepts only strings matching `^-?\d+$`.
 *
 * @see {@link isStringBigInt} for the string predicate used by this schema
 * @see {@link BigInt} for validating values that are already bigint values
 * @see {@link NumberFromString} for parsing JavaScript number strings, including non-finite values
 * @see {@link BigDecimalFromString} for parsing decimal number strings
 *
 * @category BigInt
 * @since 4.0.0
 */
export const BigIntFromString: BigIntFromString = make<String>(AST.bigIntString).pipe(
  decodeTo(BigInt, Transformation.bigintFromString)
)

/**
 * Schema interface for `Trimmed`, representing strings with no leading or
 * trailing whitespace.
 *
 * @category String
 * @since 3.10.0
 */
export interface Trimmed extends String {
  readonly "Rebuild": Trimmed
}

/**
 * Schema for strings that contains no leading or trailing whitespaces.
 *
 * @category String
 * @since 3.10.0
 */
export const Trimmed: Trimmed = String.check(isTrimmed())

/**
 * Schema interface for `Trim`, a transformation that trims leading and trailing
 * whitespace while decoding and encodes the trimmed string unchanged.
 *
 * @category String
 * @since 3.10.0
 */
export interface Trim extends decodeTo<Trimmed, String> {
  readonly "Rebuild": Trim
}

/**
 * Schema that trims whitespace from a string.
 *
 * **Details**
 *
 * Decoding:
 * - A `string` is decoded as a string with no leading or trailing whitespaces.
 *
 * Encoding:
 * - The trimmed string is encoded as is.
 *
 * @category String
 * @since 3.10.0
 */
export const Trim: Trim = String.annotate({
  expected: "a string that will be decoded as a trimmed string"
}).pipe(decodeTo(Trimmed, Transformation.trim()))

/**
 * Schema interface for `StringFromBase64`, a transformation between RFC4648
 * base64-encoded strings and UTF-8 strings.
 *
 * @category String
 * @since 3.10.0
 */
export interface StringFromBase64 extends decodeTo<String, String> {
  readonly "Rebuild": StringFromBase64
}

/**
 * Decodes a base64 (RFC4648) encoded string into a UTF-8 string.
 *
 * **Details**
 *
 * Decoding:
 * - A **valid** base64 encoded string is decoded as a UTF-8 `string`.
 *
 * Encoding:
 * - A `string` is encoded as a base64-encoded string.
 *
 * @category String
 * @since 3.10.0
 */
export const StringFromBase64: StringFromBase64 = String.annotate({
  expected: "a base64 encoded string that will be decoded as a UTF-8 string"
}).pipe(
  decodeTo(String, Transformation.stringFromBase64String)
)

/**
 * Schema interface for `StringFromBase64Url`, a transformation between URL-safe
 * base64-encoded strings and UTF-8 strings.
 *
 * @category String
 * @since 3.10.0
 */
export interface StringFromBase64Url extends decodeTo<String, String> {
  readonly "Rebuild": StringFromBase64Url
}

/**
 * Decodes a base64 (URL) encoded string into a UTF-8 string.
 *
 * **Details**
 *
 * Decoding:
 * - A **valid** base64 (URL) encoded string is decoded as a UTF-8 `string`.
 *
 * Encoding:
 * - A `string` is encoded as a base64 (URL) encoded string.
 *
 * @category String
 * @since 3.10.0
 */
export const StringFromBase64Url: StringFromBase64Url = String.annotate({
  expected: "a base64 (URL) encoded string that will be decoded as a UTF-8 string"
}).pipe(
  decodeTo(String, Transformation.stringFromBase64UrlString)
)

/**
 * Schema interface for `StringFromHex`, a transformation between hex-encoded
 * strings and UTF-8 strings.
 *
 * @category String
 * @since 3.10.0
 */
export interface StringFromHex extends decodeTo<String, String> {
  readonly "Rebuild": StringFromHex
}

/**
 * Decodes a hex encoded string into a UTF-8 string.
 *
 * **Details**
 *
 * Decoding:
 * - A **valid** hex encoded string is decoded as a UTF-8 `string`.
 *
 * Encoding:
 * - A `string` is encoded as a hex string.
 *
 * @category String
 * @since 3.10.0
 */
export const StringFromHex: StringFromHex = String.annotate({
  expected: "a hex encoded string that will be decoded as a UTF-8 string"
}).pipe(
  decodeTo(String, Transformation.stringFromHexString)
)

/**
 * Schema interface for `StringFromUriComponent`, a transformation between
 * URI-component encoded strings and UTF-8 strings.
 *
 * @category String
 * @since 3.12.0
 */
export interface StringFromUriComponent extends decodeTo<String, String> {
  readonly "Rebuild": StringFromUriComponent
}

/**
 * Decodes a URI component encoded string into a UTF-8 string.
 * Can be used to store data in a URL.
 *
 * **Details**
 *
 * Decoding:
 * - A **valid** URI component encoded string is decoded as a UTF-8 `string`.
 *
 * Encoding:
 * - A `string` is encoded as a URI component encoded string.
 *
 * **Example** (Decoding URI component strings)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const PaginationSchema = Schema.Struct({
 *   maxItemPerPage: Schema.Number,
 *   page: Schema.Number
 * })
 *
 * const UrlSchema = Schema.StringFromUriComponent.pipe(
 *   Schema.decodeTo(Schema.fromJsonString(PaginationSchema))
 * )
 *
 * console.log(Schema.encodeSync(UrlSchema)({ maxItemPerPage: 10, page: 1 }))
 * // %7B%22maxItemPerPage%22%3A10%2C%22page%22%3A1%7D
 * ```
 *
 * @category String
 * @since 3.12.0
 */
export const StringFromUriComponent: StringFromUriComponent = String.annotate({
  expected: "a URI component encoded string that will be decoded as a UTF-8 string"
}).pipe(
  decodeTo(String, Transformation.stringFromUriComponent)
)

/**
 * Schema for property keys accepted by Effect schemas: finite `number`,
 * `symbol`, or `string`.
 *
 * @category PropertyKey
 * @since 4.0.0
 */
export const PropertyKey = Union([Finite, Symbol, String])

/**
 * Schema for a Standard Schema v1 failure result.
 *
 * **Details**
 *
 * The result contains an `issues` array where each issue has a message and an
 * optional path made of property keys or keyed path segments.
 *
 * @category StandardSchema
 * @since 4.0.0
 */
export const StandardSchemaV1FailureResult = Struct({
  issues: ArraySchema(Struct({
    message: String,
    path: optional(ArraySchema(Union([PropertyKey, Struct({ key: PropertyKey })])))
  }))
})

/**
 * Schema interface for `BooleanFromBit`, a transformation between bit literals
 * `0 | 1` and boolean values.
 *
 * @category Boolean
 * @since 4.0.0
 */
export interface BooleanFromBit extends decodeTo<Boolean, Literals<readonly [0, 1]>> {
  readonly "Rebuild": BooleanFromBit
}

/**
 * Schema for a boolean parsed from 0 or 1.
 *
 * **When to use**
 *
 * Use when decoding data sources that represent booleans as `0 | 1` while
 * keeping boolean values in the decoded model.
 *
 * **Details**
 *
 * Decoding accepts only `0 | 1`, maps `1` to `true`, and maps `0` to `false`.
 * Encoding maps `true` to `1` and `false` to `0`.
 *
 * @see {@link Boolean} for validating values that are already booleans
 * @see {@link Literals} for keeping bit literals instead of decoding them
 *
 * @category Boolean
 * @since 4.0.0
 */
export const BooleanFromBit: BooleanFromBit = Literals([0, 1]).pipe(
  decodeTo(
    Boolean,
    Transformation.transform({
      decode: (bit) => bit === 1,
      encode: (bool) => bool ? 1 : 0
    })
  )
)

/**
 * Schema interface for `Uint8Array`, representing JavaScript `Uint8Array`
 * instances with base64 JSON encoding.
 *
 * @category Uint8Array
 * @since 4.0.0
 */
export interface Uint8Array extends instanceOf<globalThis.Uint8Array<ArrayBufferLike>> {
  readonly "Rebuild": Uint8Array
}

const Base64String = String.annotate({
  expected: "a base64 encoded string that will be decoded as Uint8Array",
  format: "byte",
  contentEncoding: "base64"
})

/**
 * Schema for JavaScript `Uint8Array` objects.
 *
 * **Details**
 *
 * Default JSON serializer:
 *
 * The default JSON serializer encodes Uint8Array as a Base64 encoded string.
 *
 * @category Uint8Array
 * @since 4.0.0
 */
export const Uint8Array: Uint8Array = instanceOf(globalThis.Uint8Array<ArrayBufferLike>, {
  typeConstructor: {
    _tag: "Uint8Array"
  },
  generation: {
    runtime: `Schema.Uint8Array`,
    Type: `globalThis.Uint8Array`
  },
  expected: "Uint8Array",
  toCodecJson: () =>
    link<globalThis.Uint8Array<ArrayBufferLike>>()(
      Base64String,
      Transformation.uint8ArrayFromBase64String
    ),
  toArbitrary: () => (fc) => fc.uint8Array()
})

/**
 * Schema interface for `Uint8ArrayFromBase64`, a transformation between
 * base64-encoded strings and `Uint8Array` values.
 *
 * @category Uint8Array
 * @since 3.10.0
 */
export interface Uint8ArrayFromBase64 extends decodeTo<Uint8Array, String> {
  readonly "Rebuild": Uint8ArrayFromBase64
}

/**
 * Schema that decodes a base64 encoded string into a
 * `Uint8Array`.
 *
 * **Details**
 *
 * Decoding:
 * - A **valid** base64 encoded string is decoded as a `Uint8Array`.
 *
 * Encoding:
 * - A `Uint8Array` is encoded as a base64-encoded string.
 *
 * @category Uint8Array
 * @since 3.10.0
 */
export const Uint8ArrayFromBase64: Uint8ArrayFromBase64 = Base64String.pipe(
  decodeTo(Uint8Array, Transformation.uint8ArrayFromBase64String)
)

/**
 * Schema interface for `Uint8ArrayFromBase64Url`, a transformation between
 * URL-safe base64-encoded strings and `Uint8Array` values.
 *
 * @category Uint8Array
 * @since 3.10.0
 */
export interface Uint8ArrayFromBase64Url extends decodeTo<Uint8Array, String> {
  readonly "Rebuild": Uint8ArrayFromBase64Url
}

/**
 * Schema that decodes a base64 (URL) encoded string into a
 * `Uint8Array`.
 *
 * **Details**
 *
 * Decoding:
 * - A **valid** base64 (URL) encoded string is decoded as a `Uint8Array`.
 *
 * Encoding:
 * - A `Uint8Array` is encoded as a base64 (URL) encoded string.
 *
 * @category Uint8Array
 * @since 3.10.0
 */
export const Uint8ArrayFromBase64Url: Uint8ArrayFromBase64Url = String.annotate({
  expected: "a base64 (URL) encoded string that will be decoded as a Uint8Array"
}).pipe(
  decodeTo(Uint8Array, {
    decode: Getter.decodeBase64Url(),
    encode: Getter.encodeBase64Url()
  })
)

/**
 * Schema interface for `Uint8ArrayFromHex`, a transformation between
 * hex-encoded strings and `Uint8Array` values.
 *
 * @category Uint8Array
 * @since 3.10.0
 */
export interface Uint8ArrayFromHex extends decodeTo<Uint8Array, String> {
  readonly "Rebuild": Uint8ArrayFromHex
}

/**
 * Schema that decodes a hex encoded string into a
 * `Uint8Array`.
 *
 * **Details**
 *
 * Decoding:
 * - A **valid** hex encoded string is decoded as a `Uint8Array`.
 *
 * Encoding:
 * - A `Uint8Array` is encoded as a hex encoded string.
 *
 * @category Uint8Array
 * @since 3.10.0
 */
export const Uint8ArrayFromHex: Uint8ArrayFromHex = String.annotate({
  expected: "a hex encoded string that will be decoded as a Uint8Array"
}).pipe(
  decodeTo(Uint8Array, {
    decode: Getter.decodeHex(),
    encode: Getter.encodeHex()
  })
)

/**
 * Schema interface for `DateTimeUtc`, representing `DateTime.Utc` values with
 * UTC ISO string JSON encoding.
 *
 * @category DateTime
 * @since 3.10.0
 */
export interface DateTimeUtc extends declare<DateTime.Utc> {
  readonly "Rebuild": DateTimeUtc
}

/**
 * Schema for `DateTime.Utc` values.
 *
 * **When to use**
 *
 * Use to validate existing `DateTime.Utc` schema values and use the default JSON
 * codec that represents them as UTC ISO strings.
 *
 * **Details**
 *
 * The default JSON codec decodes UTC ISO strings into `DateTime.Utc` values and
 * encodes `DateTime.Utc` values as UTC ISO strings.
 *
 * @see {@link DateTimeUtcFromString} for decoding date-time strings into UTC values
 * @see {@link DateTimeUtcFromDate} for decoding JavaScript Date values into UTC values
 * @see {@link DateTimeUtcFromMillis} for decoding epoch milliseconds into UTC values
 * @see {@link DateTimeZoned} for preserving zoned DateTime values
 *
 * @category DateTime
 * @since 3.10.0
 */
export const DateTimeUtc: DateTimeUtc = declare(
  (u) => DateTime.isDateTime(u) && DateTime.isUtc(u),
  {
    typeConstructor: {
      _tag: "effect/DateTime.Utc"
    },
    generation: {
      runtime: `Schema.DateTimeUtc`,
      Type: `DateTime.Utc`,
      importDeclaration: `import * as DateTime from "effect/DateTime"`
    },
    expected: "DateTime.Utc",
    toCodecJson: () =>
      link<DateTime.Utc>()(
        String,
        Transformation.dateTimeUtcFromString
      ),
    toArbitrary: () => (fc, ctx) =>
      fc.date({ noInvalidDate: true, ...ctx?.constraints?.date }).map((date) => DateTime.fromDateUnsafe(date)),
    toFormatter: () => (utc) => utc.toString(),
    toEquivalence: () => DateTime.Equivalence
  }
)

/**
 * Schema interface for `DateTimeUtcFromDate`, a transformation from valid
 * JavaScript `Date` values to `DateTime.Utc`.
 *
 * @category DateTime
 * @since 3.12.0
 */
export interface DateTimeUtcFromDate extends decodeTo<DateTimeUtc, Date> {
  readonly "Rebuild": DateTimeUtcFromDate
}

/**
 * Schema that decodes a `Date` into a `DateTime.Utc`.
 *
 * **When to use**
 *
 * Use when a boundary provides valid JavaScript `Date` objects but the decoded
 * model should use `DateTime.Utc`.
 *
 * **Details**
 *
 * Decoding:
 * - A **valid** `Date` is decoded as a `DateTime.Utc`
 *
 * Encoding:
 * - A `DateTime.Utc` is encoded as a `Date`
 *
 * @see {@link DateTimeUtc} for validating values that are already `DateTime.Utc`
 * @see {@link DateTimeUtcFromString} for decoding date-time strings into UTC values
 * @see {@link DateTimeUtcFromMillis} for decoding epoch milliseconds into UTC values
 * @see {@link DateValid} for validating Date instances without converting them
 *
 * @category DateTime
 * @since 3.12.0
 */
export const DateTimeUtcFromDate: DateTimeUtcFromDate = DateValid.pipe(
  decodeTo(DateTimeUtc, {
    decode: Getter.dateTimeUtcFromInput(),
    encode: Getter.transform(DateTime.toDateUtc)
  })
)

/**
 * Schema interface for `DateTimeUtcFromString`, a transformation from date-time
 * strings to `DateTime.Utc`.
 *
 * @category DateTime
 * @since 4.0.0
 */
export interface DateTimeUtcFromString extends decodeTo<DateTimeUtc, String> {
  readonly "Rebuild": DateTimeUtcFromString
}

/**
 * Schema that decodes a date-time string into a `DateTime.Utc`.
 *
 * **Details**
 *
 * Decoding:
 *
 * - A string accepted by `DateTime.make` is parsed and normalized to UTC. Strings
 *   without an explicit zone are interpreted as UTC.
 *
 * Encoding:
 *
 * - A `DateTime.Utc` is encoded as a UTC ISO 8601 string.
 *
 * @category DateTime
 * @since 4.0.0
 */
export const DateTimeUtcFromString: DateTimeUtcFromString = String.annotate({
  expected: "a string that will be decoded as a DateTime.Utc"
}).pipe(
  decodeTo(
    DateTimeUtc,
    Transformation.dateTimeUtcFromString
  )
)

/**
 * Schema interface for `DateTimeUtcFromMillis`, a transformation between epoch
 * milliseconds and `DateTime.Utc` values.
 *
 * @category DateTime
 * @since 4.0.0
 */
export interface DateTimeUtcFromMillis extends decodeTo<instanceOf<DateTime.Utc>, Number> {
  readonly "Rebuild": DateTimeUtcFromMillis
}

/**
 * Schema that decodes a number into a `DateTime.Utc`.
 *
 * **Details**
 *
 * Decoding:
 * - A number of milliseconds since the Unix epoch is decoded as a `DateTime.Utc`
 *
 * Encoding:
 * - A `DateTime.Utc` is encoded as a number of milliseconds since the Unix epoch.
 *
 * @category DateTime
 * @since 4.0.0
 */
export const DateTimeUtcFromMillis: DateTimeUtcFromMillis = Number.pipe(
  decodeTo(DateTimeUtc, {
    decode: Getter.dateTimeUtcFromInput(),
    encode: Getter.transform(DateTime.toEpochMillis)
  })
)

/**
 * Schema interface for `TimeZoneOffset`, representing
 * `DateTime.TimeZone.Offset` values encoded as offset milliseconds.
 *
 * @category DateTime
 * @since 3.10.0
 */
export interface TimeZoneOffset extends declare<DateTime.TimeZone.Offset> {
  readonly "Rebuild": TimeZoneOffset
}

/**
 * Schema for `DateTime.TimeZone.Offset` values.
 *
 * **Details**
 *
 * Default JSON serializer:
 *
 * - encodes `DateTime.TimeZone.Offset` as a number (offset in milliseconds)
 *
 * @category DateTime
 * @since 3.10.0
 */
export const TimeZoneOffset: TimeZoneOffset = declare(
  DateTime.isTimeZoneOffset,
  {
    typeConstructor: {
      _tag: "effect/DateTime.TimeZone.Offset"
    },
    generation: {
      runtime: `Schema.TimeZoneOffset`,
      Type: `DateTime.TimeZone.Offset`,
      importDeclaration: `import * as DateTime from "effect/DateTime"`
    },
    expected: "DateTime.TimeZone.Offset",
    toCodecJson: () =>
      link<DateTime.TimeZone.Offset>()(
        Number,
        Transformation.timeZoneOffsetFromNumber
      ),
    toArbitrary: () => (fc) =>
      fc.integer({ min: -12 * 60 * 60 * 1000, max: 14 * 60 * 60 * 1000 }).map((n) => DateTime.zoneMakeOffset(n)),
    toFormatter: () => (tz) => DateTime.zoneToString(tz),
    toEquivalence: () => (a, b) => a.offset === b.offset
  }
)

/**
 * Schema interface for `TimeZoneNamed`, representing
 * `DateTime.TimeZone.Named` values encoded as IANA time zone identifiers.
 *
 * @category DateTime
 * @since 3.10.0
 */
export interface TimeZoneNamed extends declare<DateTime.TimeZone.Named> {
  readonly "Rebuild": TimeZoneNamed
}

const TimeZoneNamedString = String.annotate({ expected: "an IANA time zone identifier" })

/**
 * Schema for `DateTime.TimeZone.Named` values.
 *
 * **Details**
 *
 * Default JSON serializer:
 *
 * - encodes `DateTime.TimeZone.Named` as a string (IANA time zone identifier)
 *
 * @category DateTime
 * @since 3.10.0
 */
export const TimeZoneNamed: TimeZoneNamed = declare(
  DateTime.isTimeZoneNamed,
  {
    typeConstructor: {
      _tag: "effect/DateTime.TimeZone.Named"
    },
    generation: {
      runtime: `Schema.TimeZoneNamed`,
      Type: `DateTime.TimeZone.Named`,
      importDeclaration: `import * as DateTime from "effect/DateTime"`
    },
    expected: "DateTime.TimeZone.Named",
    toCodecJson: () =>
      link<DateTime.TimeZone.Named>()(
        TimeZoneNamedString,
        Transformation.timeZoneNamedFromString
      ),
    toArbitrary: () => (fc) =>
      fc.constantFrom(
        ...["UTC", "Europe/London", "America/New_York", "Asia/Tokyo", "Australia/Sydney"].map(
          DateTime.zoneMakeNamedUnsafe
        )
      ),
    toFormatter: () => (tz) => DateTime.zoneToString(tz),
    toEquivalence: () => (a, b) => a.id === b.id
  }
)

/**
 * Schema interface for `TimeZoneNamedFromString`, a transformation between IANA
 * time zone identifier strings and `DateTime.TimeZone.Named` values.
 *
 * @category DateTime
 * @since 4.0.0
 */
export interface TimeZoneNamedFromString extends decodeTo<TimeZoneNamed, String> {
  readonly "Rebuild": TimeZoneNamedFromString
}

/**
 * Schema that parses an IANA time zone identifier string into a `DateTime.TimeZone.Named`.
 *
 * **Details**
 *
 * Decoding:
 * - A `string` is decoded as a `DateTime.TimeZone.Named`.
 *
 * Encoding:
 * - A `DateTime.TimeZone.Named` is encoded as a `string`.
 *
 * @category DateTime
 * @since 4.0.0
 */
export const TimeZoneNamedFromString: TimeZoneNamedFromString = TimeZoneNamedString.pipe(
  decodeTo(TimeZoneNamed, Transformation.timeZoneNamedFromString)
)

/**
 * Schema interface for `TimeZone`, representing `DateTime.TimeZone` values
 * encoded as either IANA identifiers or numeric offset strings.
 *
 * @category DateTime
 * @since 3.10.0
 */
export interface TimeZone extends declare<DateTime.TimeZone> {
  readonly "Rebuild": TimeZone
}

const TimeZoneString = String.annotate({
  expected: "a time zone string (IANA identifier or offset like +03:00)"
})

/**
 * Schema for `DateTime.TimeZone` values.
 *
 * **Details**
 *
 * Default JSON serializer:
 *
 * - encodes `DateTime.TimeZone` as a string (IANA identifier or offset like
 *   `+03:00`)
 *
 * @category DateTime
 * @since 3.10.0
 */
export const TimeZone: TimeZone = declare(
  DateTime.isTimeZone,
  {
    typeConstructor: {
      _tag: "effect/DateTime.TimeZone"
    },
    generation: {
      runtime: `Schema.TimeZone`,
      Type: `DateTime.TimeZone`,
      importDeclaration: `import * as DateTime from "effect/DateTime"`
    },
    expected: "DateTime.TimeZone",
    toCodecJson: () =>
      link<DateTime.TimeZone>()(
        TimeZoneString,
        Transformation.timeZoneFromString
      ),
    toArbitrary: () => (fc) =>
      fc.oneof(
        fc.integer({ min: -12 * 60 * 60 * 1000, max: 14 * 60 * 60 * 1000 }).map((n) => DateTime.zoneMakeOffset(n)),
        fc.constantFrom(
          ...["UTC", "Europe/London", "America/New_York", "Asia/Tokyo", "Australia/Sydney"].map(
            DateTime.zoneMakeNamedUnsafe
          )
        )
      ),
    toFormatter: () => (tz) => DateTime.zoneToString(tz),
    toEquivalence: () => (a, b) => DateTime.zoneToString(a) === DateTime.zoneToString(b)
  }
)

/**
 * Schema interface for `TimeZoneFromString`, a transformation from IANA
 * identifier or offset strings to `DateTime.TimeZone` values.
 *
 * @category DateTime
 * @since 4.0.0
 */
export interface TimeZoneFromString extends decodeTo<TimeZone, String> {
  readonly "Rebuild": TimeZoneFromString
}

/**
 * Schema that parses a time zone string into a `DateTime.TimeZone`.
 *
 * **Details**
 *
 * Decoding:
 * - A `string` (IANA identifier or offset like `+03:00`) is decoded as a `DateTime.TimeZone`.
 *
 * Encoding:
 * - A `DateTime.TimeZone` is encoded as a `string`.
 *
 * @category DateTime
 * @since 4.0.0
 */
export const TimeZoneFromString: TimeZoneFromString = TimeZoneString.pipe(
  decodeTo(TimeZone, Transformation.timeZoneFromString)
)

/**
 * Schema interface for `DateTimeZoned`, representing `DateTime.Zoned` values
 * with ISO offset or named-zone string JSON encoding.
 *
 * @category DateTime
 * @since 3.10.0
 */
export interface DateTimeZoned extends declare<DateTime.Zoned> {
  readonly "Rebuild": DateTimeZoned
}

const DateTimeZonedString = String.annotate({
  expected: "a zoned DateTime string (e.g. 2024-01-01T00:00:00.000+00:00[Europe/London])"
})

/**
 * Schema for `DateTime.Zoned` values.
 *
 * **Details**
 *
 * Default JSON serializer:
 *
 * - encodes offset zones as an ISO date-time with a numeric offset, such as
 *   `YYYY-MM-DDTHH:mm:ss.sss+HH:MM`
 * - encodes named zones by appending the IANA identifier in brackets, such as
 *   `YYYY-MM-DDTHH:mm:ss.sss+HH:MM[Time/Zone]`
 *
 * @category DateTime
 * @since 3.10.0
 */
export const DateTimeZoned: DateTimeZoned = declare(
  (u) => DateTime.isDateTime(u) && DateTime.isZoned(u),
  {
    typeConstructor: {
      _tag: "effect/DateTime.Zoned"
    },
    generation: {
      runtime: `Schema.DateTimeZoned`,
      Type: `DateTime.Zoned`,
      importDeclaration: `import * as DateTime from "effect/DateTime"`
    },
    expected: "DateTime.Zoned",
    toCodecJson: () =>
      link<DateTime.Zoned>()(
        DateTimeZonedString,
        Transformation.dateTimeZonedFromString
      ),
    toArbitrary: () => (fc, ctx) =>
      fc.tuple(
        fc.date({
          noInvalidDate: true,
          min: new globalThis.Date(-8640000000000000 + 14 * 60 * 60 * 1000),
          max: new globalThis.Date(8640000000000000 - 14 * 60 * 60 * 1000),
          ...ctx?.constraints?.date
        }),
        fc.constantFrom("UTC", "Europe/London", "America/New_York", "Asia/Tokyo", "Australia/Sydney")
      ).map(([date, zone]) => DateTime.makeZonedUnsafe(date, { timeZone: zone })),
    toFormatter: () => (zoned) => DateTime.formatIsoZoned(zoned),
    toEquivalence: () => DateTime.Equivalence
  }
)

/**
 * Schema interface for `DateTimeZonedFromString`, a transformation between
 * zoned date-time strings and `DateTime.Zoned` values.
 *
 * @category DateTime
 * @since 4.0.0
 */
export interface DateTimeZonedFromString extends decodeTo<DateTimeZoned, String> {
  readonly "Rebuild": DateTimeZonedFromString
}

/**
 * Schema that parses a zoned DateTime string into a `DateTime.Zoned`.
 *
 * **Details**
 *
 * Decoding:
 * - A `string` (e.g. `2024-01-01T00:00:00.000+00:00[Europe/London]`) is decoded as a `DateTime.Zoned`.
 *
 * Encoding:
 * - A `DateTime.Zoned` is encoded as a `string`.
 *
 * @category DateTime
 * @since 4.0.0
 */
export const DateTimeZonedFromString: DateTimeZonedFromString = DateTimeZonedString.pipe(
  decodeTo(DateTimeZoned, Transformation.dateTimeZonedFromString)
)

// -----------------------------------------------------------------------------
// Class
// -----------------------------------------------------------------------------

/**
 * Interface for schema-backed classes created with {@link Class}.
 *
 * **Details**
 *
 * A `Class` is a TypeScript class whose constructor validates its input
 * against a {@link Struct} schema. Instances are always structurally valid.
 *
 * The interface exposes the schema's `fields`, an `identifier` string, and
 * helpers such as `mapFields`, `annotate`, `check`, and `extend`.
 *
 * @category models
 * @since 3.10.0
 */
export interface Class<Self, S extends Top & { readonly fields: Struct.Fields }, Inherited> extends
  Bottom<
    Self,
    S["Encoded"],
    S["DecodingServices"],
    S["EncodingServices"],
    AST.Declaration,
    decodeTo<declareConstructor<Self, S["Encoded"], readonly [S], S["Iso"]>, S>,
    RequiredKeys<S["~type.make.in"]> extends never ? void | S["~type.make.in"] : S["~type.make.in"],
    S["Iso"],
    readonly [S],
    Self,
    S["~type.mutability"],
    S["~type.optionality"],
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{
  new(
    ...args: {} extends S["~type.make.in"] ? [props?: S["~type.make.in"], options?: MakeOptions]
      : [props: S["~type.make.in"], options?: MakeOptions]
  ): S["Type"] & Inherited
  readonly identifier: string
  readonly fields: S["fields"]

  /**
   * Returns a new struct with the fields modified by the provided function.
   *
   * **Details**
   *
   * Options:
   *
   * - `unsafePreserveChecks` - if `true`, keep any `.check(...)` constraints
   *   that were attached to the original struct. Defaults to `false`.
   *
   *   **Warning**: This is an unsafe operation. Since `mapFields`
   *   transformations change the schema type, the original refinement functions
   *   may no longer be valid or safe to apply to the transformed schema. Only
   *   use this option if you have verified that your refinements remain correct
   *   after the transformation.
   */
  mapFields<To extends Struct.Fields>(
    f: (fields: S["fields"]) => To,
    options?: {
      readonly unsafePreserveChecks?: boolean | undefined
    } | undefined
  ): Struct<Simplify<Readonly<To>>>

  extend<Extended = never, Static = {}, Brand = {}>(
    identifier: string
  ): <NewFields extends Struct.Fields>(
    fields: NewFields,
    annotations?: Annotations.Declaration<Extended, readonly [Struct<Simplify<Assign<S["fields"], NewFields>>>]>
  ) => [Extended] extends [never] ? MissingSelfGeneric<"Base.extend"> : InheritStaticMembers<
    Class<Extended, Struct<Simplify<Assign<S["fields"], NewFields>>>, Self & Brand>,
    Static
  >
}

// Merges custom static members from a parent class onto the extended class,
// giving priority to the extended class's own members (e.g. schema-generated statics).
type InheritStaticMembers<C, Static> = C & Pick<Static, Exclude<keyof Static, keyof C>>

const immerable: unique symbol = globalThis.Symbol.for("immer-draftable") as any

function makeClass<
  Self,
  S extends Struct<Struct.Fields>,
  Inherited extends new(...args: ReadonlyArray<any>) => any
>(
  Inherited: Inherited,
  identifier: string,
  struct: S,
  annotations: Annotations.Declaration<Self, readonly [S]> | undefined,
  proto: ((identifier: string) => object) | undefined
): any {
  const getClassSchema = getClassSchemaFactory(struct, identifier, annotations)
  const ClassTypeId = getClassTypeId(identifier) // HMR support

  const out = class extends Inherited {
    constructor(...[input, options]: ReadonlyArray<any>) {
      input = input ?? {}
      const validated = struct.make(input, options)
      super({ ...input, ...validated }, { ...options, disableChecks: true })
    }

    static readonly [TypeId] = TypeId

    get [ClassTypeId]() {
      return ClassTypeId
    }

    static readonly [immerable] = true

    static readonly identifier = identifier
    static readonly fields = struct.fields

    static get ast(): AST.Declaration {
      return getClassSchema(this).ast
    }
    static pipe() {
      return Pipeable.pipeArguments(this, arguments)
    }
    static rebuild(ast: AST.Declaration) {
      return getClassSchema(this).rebuild(ast)
    }
    static make(input: S["~type.make.in"], options?: MakeOptions): Self {
      return new this(input, options)
    }
    static makeOption(input: S["~type.make.in"], options?: MakeOptions): Option_.Option<Self> {
      return Parser.makeOption(getClassSchema(this) as any)(input ?? {}, options) as any
    }
    static makeEffect(input: S["~type.make.in"], options?: MakeOptions): Effect.Effect<Self, SchemaError> {
      return (getClassSchema(this) as any).makeEffect(input ?? {}, options)
    }
    static annotate(annotations: Annotations.Declaration<Self, readonly [S]>) {
      return this.rebuild(AST.annotate(this.ast, annotations))
    }
    static annotateKey(annotations: Annotations.Key<Self>) {
      return this.rebuild(AST.annotateKey(this.ast, annotations))
    }
    static check(...checks: readonly [AST.Check<Self>, ...Array<AST.Check<Self>>]) {
      return this.rebuild(AST.appendChecks(this.ast, checks))
    }
    static extend<Extended>(
      identifier: string
    ): <NewFields extends Struct.Fields>(
      fields: NewFields,
      annotations?: Annotations.Declaration<Extended, readonly [Struct<Simplify<Assign<S["fields"], NewFields>>>]>
    ) => Class<Extended, Struct<Simplify<Assign<S["fields"], NewFields>>>, Self> {
      return (newFields, annotations) => {
        const fields = { ...struct.fields, ...newFields }
        return makeClass(
          this,
          identifier,
          makeStruct(AST.struct(fields, struct.ast.checks, { identifier }), fields),
          annotations,
          proto
        )
      }
    }
    static mapFields<To extends Struct.Fields>(
      f: (fields: S["fields"]) => To,
      options?: {
        readonly unsafePreserveChecks?: boolean | undefined
      } | undefined
    ): Struct<Simplify<Readonly<To>>> {
      return struct.mapFields(f, options)
    }
  }

  if (proto !== undefined) {
    Object.assign(out.prototype, proto(identifier))
  }

  return out
}

function getClassTransformation(self: new(...args: ReadonlyArray<any>) => any) {
  return new Transformation.Transformation<any, any, never, never>(
    Getter.transform((input) => new self(input)),
    Getter.passthrough()
  )
}

function getClassTypeId(identifier: string) {
  return `~effect/Schema/Class/${identifier}`
}

function getClassSchemaFactory<S extends Top>(
  from: S,
  identifier: string,
  annotations: Annotations.Declaration<any, readonly [S]> | undefined
) {
  let memo: decodeTo<declareConstructor<any, S["Encoded"], readonly [S]>, S> | undefined
  return <Self extends (new(...args: ReadonlyArray<any>) => any) & { readonly identifier: string }>(
    self: Self
  ): decodeTo<declareConstructor<Self, S["Encoded"], readonly [S]>, S> => {
    if (memo === undefined) {
      const transformation = getClassTransformation(self)
      const to = make<declareConstructor<Self, S["Encoded"], readonly [S]>>(
        new AST.Declaration(
          [from.ast],
          () => (input, ast) => {
            return input instanceof self ||
                Predicate.hasProperty(input, getClassTypeId(identifier)) ?
              Effect.succeed(input) :
              Effect.fail(new Issue.InvalidType(ast, Option_.some(input)))
          },
          {
            identifier,
            [AST.ClassTypeId]: ([from]: readonly [AST.AST]) => new AST.Link(from, transformation),
            toCodec: ([from]: readonly [Codec<S["Encoded"]>]) => new AST.Link(from.ast, transformation),
            toArbitrary: ([from]: readonly [FastCheck.Arbitrary<S["Type"]>]) => () =>
              from.map((args) => new self(args)),
            toFormatter: ([from]: readonly [Formatter<S["Type"]>]) => (t: Self) => `${self.identifier}(${from(t)})`,
            "~sentinels": AST.collectSentinels(from.ast),
            ...annotations
          }
        )
      )
      memo = from.pipe(decodeTo(to, transformation))
    }
    return memo
  }
}

function isStruct(schema: Struct.Fields | Struct<Struct.Fields>): schema is Struct<Struct.Fields> {
  return isSchema(schema)
}

type MissingSelfGeneric<Usage extends string> =
  `Missing \`Self\` generic - use \`class Self extends ${Usage}<Self>(...)\``

/**
 * Creates a schema-backed class whose constructor validates input against a
 * {@link Struct} schema. Construction throws a {@link SchemaError} on invalid
 * input.
 *
 * **When to use**
 *
 * Use to define a schema-backed data class when you want validated
 * construction, schema-derived decoding/encoding, and class-style methods or
 * inheritance.
 *
 * **Details**
 *
 * Pass the desired class type as the first type parameter. The second optional
 * type parameter can be used to add nominal brands.
 *
 * **Gotchas**
 *
 * Passing `disableChecks` in the options skips constructor validation.
 *
 * **Example** (Basic class)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * class Person extends Schema.Class<Person>("Person")({
 *   name: Schema.String,
 *   age: Schema.Number
 * }) {}
 *
 * const alice = new Person({ name: "Alice", age: 30 })
 * console.log(alice.name) // "Alice"
 * console.log(`${alice}`) // "Person({ name: Alice, age: 30 })"
 * ```
 *
 * **Example** (Extending a class)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * class Animal extends Schema.Class<Animal>("Animal")({
 *   name: Schema.String
 * }) {}
 *
 * class Dog extends Animal.extend<Dog>("Dog")({
 *   breed: Schema.String
 * }) {}
 *
 * const dog = new Dog({ name: "Rex", breed: "Labrador" })
 * console.log(dog.name) // "Rex"
 * console.log(dog.breed) // "Labrador"
 * ```
 *
 * @see {@link TaggedClass} for adding a `_tag` literal field to the class schema
 * @see {@link ErrorClass} for defining schema-backed error classes
 * @see {@link TaggedErrorClass} for defining tagged schema-backed error classes
 *
 * @category constructors
 * @since 3.10.0
 */
export const Class: {
  <Self = never, Brand = {}>(identifier: string): {
    <const Fields extends Struct.Fields>(
      fields: Fields,
      annotations?: Annotations.Declaration<Self, readonly [Struct<Fields>]>
    ): [Self] extends [never] ? MissingSelfGeneric<"Schema.Class"> : Class<Self, Struct<Fields>, Brand>
    <S extends Struct<Struct.Fields>>(
      schema: S,
      annotations?: Annotations.Declaration<Self, readonly [S]>
    ): [Self] extends [never] ? MissingSelfGeneric<"Schema.Class"> : Class<Self, S, Brand>
  }
} = <Self, Brand = {}>(identifier: string) =>
(
  schema: Struct.Fields | Struct<Struct.Fields>,
  annotations?: Annotations.Declaration<Self, readonly [Struct<Struct.Fields>]>
): [Self] extends [never] ? MissingSelfGeneric<"Schema.Class"> : Class<Self, Struct<Struct.Fields>, Brand> => {
  const struct = isStruct(schema) ? schema : Struct(schema)
  return makeClass(
    Data.Class,
    identifier,
    struct,
    annotations,
    (identifier) => ({
      toString() {
        return `${identifier}(${format({ ...this })})`
      }
    })
  )
}

/**
 * Defines a schema-backed class with an automatically populated `_tag` field.
 *
 * **When to use**
 *
 * Use to define class instances that are validated by a schema and participate
 * in tagged union matching.
 *
 * **Details**
 *
 * The optional `identifier` parameter overrides the schema identifier;
 * it defaults to the `tag` value.
 *
 * **Example** (Tagged class)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * class Circle extends Schema.TaggedClass<Circle>()("Circle", {
 *   radius: Schema.Number
 * }) {}
 *
 * const c = new Circle({ radius: 5 })
 * console.log(c._tag) // "Circle"
 * console.log(c.radius) // 5
 * ```
 *
 * @category constructors
 * @since 3.10.0
 */
export const TaggedClass: {
  <Self = never, Brand = {}>(identifier?: string): {
    <Tag extends string, const Fields extends Struct.Fields>(
      tag: Tag,
      fields: Fields,
      annotations?: Annotations.Declaration<Self, readonly [TaggedStruct<Tag, Fields>]>
    ): [Self] extends [never] ? MissingSelfGeneric<"Schema.TaggedClass"> : Class<Self, TaggedStruct<Tag, Fields>, Brand>
    <Tag extends string, S extends Struct<Struct.Fields>>(
      tag: Tag,
      schema: S,
      annotations?: Annotations.Declaration<
        Self,
        readonly [Struct<Simplify<{ readonly _tag: tag<Tag> } & S["fields"]>>]
      >
    ): [Self] extends [never] ? MissingSelfGeneric<"Schema.TaggedClass">
      : Class<Self, Struct<Simplify<{ readonly _tag: tag<Tag> } & S["fields"]>>, Brand>
  }
} = (identifier?: string) => {
  return (
    tagValue: string,
    schema: Struct.Fields | Struct<Struct.Fields>,
    annotations?: Annotations.Declaration<any, readonly [Struct<Struct.Fields>]>
  ): any => {
    const struct = isStruct(schema) ?
      schema.mapFields((fields) => ({ _tag: tag(tagValue), ...fields }), {
        unsafePreserveChecks: true
      }) :
      TaggedStruct(tagValue, schema)
    return Class<any, {}>(identifier ?? tagValue)(
      struct,
      annotations as Annotations.Declaration<any, readonly [typeof struct]>
    )
  }
}

/**
 * Creates a schema-backed error class that can be used as a typed,
 * yieldable error in Effect programs. Combines {@link Class} validation with
 * the `YieldableError` interface so instances can be yielded directly inside
 * `Effect.gen`.
 *
 * **Example** (Schema-backed error)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 *
 * class NotFound extends Schema.ErrorClass<NotFound>("NotFound")({
 *   id: Schema.Number
 * }) {}
 *
 * const program = Effect.gen(function*() {
 *   yield* new NotFound({ id: 1 })
 * })
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const ErrorClass: {
  <Self = never, Brand = {}>(identifier: string): {
    <const Fields extends Struct.Fields>(
      fields: Fields,
      annotations?: Annotations.Declaration<Self, readonly [Struct<Fields>]>
    ): [Self] extends [never] ? MissingSelfGeneric<"Schema.ErrorClass">
      : Class<Self, Struct<Fields>, Cause_.YieldableError & Brand>
    <S extends Struct<Struct.Fields>>(
      schema: S,
      annotations?: Annotations.Declaration<Self, readonly [S]>
    ): [Self] extends [never] ? MissingSelfGeneric<"Schema.ErrorClass"> : Class<Self, S, Cause_.YieldableError & Brand>
  }
} = <Self, Brand = {}>(identifier: string) =>
(
  schema: Struct.Fields | Struct<Struct.Fields>,
  annotations?: Annotations.Declaration<Self, readonly [Struct<Struct.Fields>]>
): [Self] extends [never] ? MissingSelfGeneric<"Schema.ErrorClass">
  : Class<Self, Struct<Struct.Fields>, Cause_.YieldableError & Brand> =>
{
  const struct = isStruct(schema) ? schema : Struct(schema)
  const self = makeClass(
    core.Error,
    identifier,
    struct,
    annotations,
    (identifier) => ({
      name: identifier
    })
  )
  return self
}

/**
 * Defines a schema-backed yieldable error class with an automatically populated
 * `_tag` field.
 *
 * **When to use**
 *
 * Use to define typed errors that are schema validated, yielded in `Effect.gen`,
 * and matched as tagged union members.
 *
 * **Example** (Tagged error class)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 *
 * class NotFound extends Schema.TaggedErrorClass<NotFound>()("NotFound", {
 *   id: Schema.Number
 * }) {}
 *
 * const program = Effect.gen(function*() {
 *   yield* new NotFound({ id: 42 })
 * })
 * ```
 *
 * @category constructors
 * @since 3.10.0
 */
export const TaggedErrorClass: {
  <Self = never, Brand = {}>(identifier?: string): {
    <Tag extends string, const Fields extends Struct.Fields>(
      tag: Tag,
      fields: Fields,
      annotations?: Annotations.Declaration<Self, readonly [TaggedStruct<Tag, Fields>]>
    ): [Self] extends [never] ? MissingSelfGeneric<"Schema.TaggedErrorClass">
      : Class<Self, TaggedStruct<Tag, Fields>, Cause_.YieldableError & Brand>
    <Tag extends string, S extends Struct<Struct.Fields>>(
      tag: Tag,
      schema: S,
      annotations?: Annotations.Declaration<
        Self,
        readonly [Struct<Simplify<{ readonly _tag: tag<Tag> } & S["fields"]>>]
      >
    ): [Self] extends [never] ? MissingSelfGeneric<"Schema.TaggedErrorClass">
      : Class<Self, Struct<Simplify<{ readonly _tag: tag<Tag> } & S["fields"]>>, Cause_.YieldableError & Brand>
  }
} = (identifier?: string) => {
  return (
    tagValue: string,
    schema: Struct.Fields | Struct<Struct.Fields>,
    annotations?: Annotations.Declaration<any, readonly [Struct<Struct.Fields>]>
  ): any => {
    const struct = isStruct(schema) ?
      schema.mapFields((fields) => ({ _tag: tag(tagValue), ...fields }), {
        unsafePreserveChecks: true
      }) :
      TaggedStruct(tagValue, schema)
    return ErrorClass<any, {}>(identifier ?? tagValue)(
      struct,
      annotations as Annotations.Declaration<any, readonly [typeof struct]>
    )
  }
}

// -----------------------------------------------------------------------------
// Arbitrary
// -----------------------------------------------------------------------------

/**
 * A thunk that, given the `fast-check` module, returns an `Arbitrary<T>`.
 * Use this type when you need to defer instantiation of the arbitrary, for
 * example to support recursive schemas.
 *
 * @category Arbitrary
 * @since 4.0.0
 */
export type LazyArbitrary<T> = (fc: typeof FastCheck) => FastCheck.Arbitrary<T>

/**
 * Derives a {@link LazyArbitrary} from a schema. The result is memoized so
 * repeated calls with the same schema are cheap.
 *
 * **Details**
 *
 * Prefer {@link toArbitrary} when you just need the arbitrary directly.
 *
 * @category Arbitrary
 * @since 4.0.0
 */
export function toArbitraryLazy<S extends Top>(schema: S): LazyArbitrary<S["Type"]> {
  const lawc = InternalArbitrary.memoized(schema.ast)
  return (fc) => lawc(fc, {})
}

/**
 * Derives a `fast-check` `Arbitrary` from a schema for property-based
 * testing. The derived arbitrary generates values that satisfy the schema.
 *
 * **Example** (Generating arbitrary values)
 *
 * ```ts
 * import { Schema } from "effect"
 * import * as FastCheck from "fast-check"
 *
 * const PersonArb = Schema.toArbitrary(
 *   Schema.Struct({ name: Schema.String, age: Schema.Number })
 * )
 *
 * // Sample a random value
 * const sample = FastCheck.sample(PersonArb, 1)[0]
 * console.log(typeof sample.name) // "string"
 * ```
 *
 * @category Arbitrary
 * @since 4.0.0
 */
export function toArbitrary<S extends Top>(schema: S): FastCheck.Arbitrary<S["Type"]> {
  return toArbitraryLazy(schema)(FastCheck)
}

// -----------------------------------------------------------------------------
// Formatter
// -----------------------------------------------------------------------------

/**
 * Attaches a custom formatter used by `toFormatter`.
 *
 * **Details**
 *
 * Use this when the formatter derived from the schema structure is not suitable.
 * The annotation is applied through this helper because adding it directly to
 * `Annotations.Bottom` would make schemas invariant.
 *
 * @category Formatter
 * @since 4.0.0
 */
export function overrideToFormatter<S extends Top>(toFormatter: () => Formatter<S["Type"]>) {
  return (self: S): S["Rebuild"] => {
    return self.annotate({ toFormatter })
  }
}

/**
 * Derives a string formatter function from a schema. The formatter converts
 * a value to its human-readable string representation, recursing into structs,
 * arrays, and unions.
 *
 * **Details**
 *
 * The optional `onBefore` hook lets you intercept specific AST nodes before
 * the default formatting logic runs.
 *
 * @category Formatter
 * @since 4.0.0
 */
export function toFormatter<T>(schema: Schema<T>, options?: {
  readonly onBefore?:
    | ((ast: AST.AST, recur: (ast: AST.AST) => Formatter<any>) => Formatter<any> | undefined)
    | undefined
}): Formatter<T> {
  return recur(schema.ast)

  function recur(ast: AST.AST): Formatter<T> {
    // ---------------------------------------------
    // handle annotation
    // ---------------------------------------------
    const annotation = InternalAnnotations.resolve(ast)?.["toFormatter"]
    if (typeof annotation === "function") {
      return annotation(AST.isDeclaration(ast) ? ast.typeParameters.map(recur) : [])
    }
    // ---------------------------------------------
    // handle onBefore
    // ---------------------------------------------
    if (options?.onBefore) {
      const onBefore = options.onBefore(ast, recur)
      if (onBefore !== undefined) {
        return onBefore
      }
    }
    // ---------------------------------------------
    // handle base case
    // ---------------------------------------------
    return on(ast)
  }

  function on(ast: AST.AST): Formatter<any> {
    switch (ast._tag) {
      default:
        return format
      case "Never":
        return () => "never"
      case "Void":
        return () => "void"
      case "Arrays": {
        const elements = ast.elements.map(recur)
        const rest = ast.rest.map(recur)
        return (t) => {
          const out: Array<string> = []
          let i = 0
          // ---------------------------------------------
          // handle elements
          // ---------------------------------------------
          for (; i < elements.length; i++) {
            if (t.length < i + 1) {
              if (AST.isOptional(ast.elements[i])) {
                continue
              }
            } else {
              out.push(elements[i](t[i]))
            }
          }
          // ---------------------------------------------
          // handle rest element
          // ---------------------------------------------
          if (rest.length > 0) {
            const [head, ...tail] = rest
            for (; i < t.length - tail.length; i++) {
              out.push(head(t[i]))
            }
            // ---------------------------------------------
            // handle post rest elements
            // ---------------------------------------------
            for (let j = 0; j < tail.length; j++) {
              i += j
              out.push(tail[j](t[i]))
            }
          }

          return "[" + out.join(", ") + "]"
        }
      }
      case "Objects": {
        const propertySignatures = ast.propertySignatures.map((ps) => recur(ps.type))
        const indexSignatures = ast.indexSignatures.map((is) => recur(is.type))
        if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0) {
          return format
        }
        return (t) => {
          const out: Array<string> = []
          const visited = new Set<PropertyKey>()
          // ---------------------------------------------
          // handle property signatures
          // ---------------------------------------------
          for (let i = 0; i < propertySignatures.length; i++) {
            const ps = ast.propertySignatures[i]
            const name = ps.name
            visited.add(name)
            if (AST.isOptional(ps.type) && !Object.hasOwn(t, name)) {
              continue
            }
            out.push(`${formatPropertyKey(name)}: ${propertySignatures[i](t[name])}`)
          }
          // ---------------------------------------------
          // handle index signatures
          // ---------------------------------------------
          for (let i = 0; i < indexSignatures.length; i++) {
            const keys = AST.getIndexSignatureKeys(t, ast.indexSignatures[i].parameter)
            for (const key of keys) {
              if (visited.has(key)) {
                continue
              }
              visited.add(key)
              out.push(`${formatPropertyKey(key)}: ${indexSignatures[i](t[key])}`)
            }
          }

          return out.length > 0 ? "{ " + out.join(", ") + " }" : "{}"
        }
      }
      case "Union": {
        const getCandidates = (t: any) => AST.getCandidates(t, ast.types)
        return (t) => {
          const candidates = getCandidates(t)
          const refinements = candidates.map(Parser._is)
          for (let i = 0; i < candidates.length; i++) {
            const is = refinements[i]
            if (is(t)) {
              return recur(candidates[i])(t)
            }
          }
          return format(t)
        }
      }
      case "Suspend": {
        const get = AST.memoizeThunk(() => recur(ast.thunk()))
        return (t) => get()(t)
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Equivalence
// -----------------------------------------------------------------------------

/**
 * Overrides the equivalence derivation for a schema by supplying a custom
 * `Equivalence`.
 *
 * **When to use**
 *
 * Use when the default structural equivalence derived by {@link toEquivalence}
 * is not appropriate for a type.
 *
 * @category Equivalence
 * @since 4.0.0
 */
export function overrideToEquivalence<S extends Top>(toEquivalence: () => Equivalence.Equivalence<S["Type"]>) {
  return (self: S): S["Rebuild"] => self.annotate({ toEquivalence })
}

/**
 * Derives an `Equivalence` from a schema. Two values are considered equal when
 * every field (and nested field) compares equal according to the schema
 * structure.
 *
 * **Example** (Struct equivalence)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const eq = Schema.toEquivalence(Schema.Struct({ id: Schema.Number, name: Schema.String }))
 *
 * console.log(eq({ id: 1, name: "Alice" }, { id: 1, name: "Alice" })) // true
 * console.log(eq({ id: 1, name: "Alice" }, { id: 2, name: "Alice" })) // false
 * ```
 *
 * @category Equivalence
 * @since 4.0.0
 */
export function toEquivalence<T>(schema: Schema<T>): Equivalence.Equivalence<T> {
  return InternalEquivalence.toEquivalence(schema.ast)
}

// -----------------------------------------------------------------------------
// Representation
// -----------------------------------------------------------------------------

/**
 * Derives an intermediate `SchemaRepresentation.Document` from a schema. This
 * document is used internally by {@link toJsonSchemaDocument} and related
 * functions to produce JSON Schema output.
 *
 * @category Representation
 * @since 4.0.0
 */
export function toRepresentation(schema: Top): SchemaRepresentation.Document {
  return InternalStandard.fromAST(schema.ast)
}

// -----------------------------------------------------------------------------
// JsonSchema
// -----------------------------------------------------------------------------

/**
 * Options for {@link toJsonSchemaDocument}.
 *
 * @category JsonSchema
 * @since 4.0.0
 */
export interface ToJsonSchemaOptions {
  /**
   * Controls how additional properties are handled while resolving the JSON
   * schema.
   *
   * **Details**
   *
   * Possible values include:
   * - `false`: Disallow additional properties (default)
   * - `true`: Allow additional properties
   * - `JsonSchema`: Use the provided JSON Schema for additional properties
   */
  readonly additionalProperties?: boolean | JsonSchema.JsonSchema | undefined
  /**
   * Controls whether to generate descriptions for checks (if the user has not
   * provided them) based on the `expected` annotation of the check.
   */
  readonly generateDescriptions?: boolean | undefined
  /**
   * A predicate that controls which additional annotation keys (beyond the
   * standard JSON Schema keys) are included in the generated output.
   *
   * **When to use**
   *
   * Use when you need to include non-standard annotation keys in the generated
   * JSON Schema, such as Monaco Editor properties (`markdownDescription`,
   * `defaultSnippets`) or vendor extensions (`x-*`).
   *
   * **Details**
   *
   * Standard JSON Schema keys (`title`, `description`, `default`, `examples`,
   * `readOnly`, `writeOnly`, `format`, `contentEncoding`, `contentMediaType`,
   * `contentSchema`) are always included. This predicate is checked for any
   * *other* annotation key.
   *
   * **Gotchas**
   *
   * Prefer whitelisting the custom annotation keys you want to emit instead of
   * using a broad predicate such as `() => true`, because broad predicates can
   * include Effect-specific annotations that are preserved for internal schema
   * generation.
   *
   * **Example** (Including custom annotations)
   *
   * ```ts
   * import { Schema } from "effect"
   *
   * const schema = Schema.String.annotate({
   *   description: "A name",
   *   markdownDescription: "The **name** field"
   * })
   *
   * const doc = Schema.toJsonSchemaDocument(schema, {
   *   includeAnnotationKey: (key) =>
   *     key === "markdownDescription" || key.startsWith("x-")
   * })
   *
   * console.log(doc.schema)
   * // {
   * //   type: "string",
   * //   description: "A name",
   * //   markdownDescription: "The **name** field"
   * // }
   * ```
   */
  readonly includeAnnotationKey?: ((key: string) => boolean) | undefined
}

/**
 * Returns a JSON Schema document using draft 2020-12.
 *
 * **Details**
 *
 * The `options` parameter controls generation details such as additional
 * properties and synthesized check descriptions; it does not change the draft
 * target.
 *
 * @category JsonSchema
 * @since 4.0.0
 */
export function toJsonSchemaDocument(schema: Top, options?: ToJsonSchemaOptions): JsonSchema.Document<"draft-2020-12"> {
  const sd = toRepresentation(schema)
  const jd = InternalStandard.toJsonSchemaDocument(sd, options)
  return {
    dialect: "draft-2020-12",
    schema: jd.schema,
    definitions: jd.definitions
  }
}

// -----------------------------------------------------------------------------
// Canonical Codecs
// -----------------------------------------------------------------------------

/**
 * Derives a canonical JSON codec from a schema. The encoded form is `Json`, and
 * decoding produces the schema's `Type`.
 *
 * @category Canonical Codecs
 * @since 4.0.0
 */
export function toCodecJson<T, E, RD, RE>(schema: Codec<T, E, RD, RE>): Codec<T, Json, RD, RE> {
  return make(toCodecJsonTop(schema.ast))
}

const toCodecJsonTop = AST.toCodec((ast) => {
  const out = toCodecJsonBase(ast, toCodecJsonTop)
  return out !== ast && AST.isOptional(ast) ? AST.optionalKeyLastLink(out) : out
})

function toCodecJsonBase(ast: AST.AST, recur: (ast: AST.AST) => AST.AST): AST.AST {
  switch (ast._tag) {
    case "Declaration": {
      const getLink = ast.annotations?.toCodecJson ?? ast.annotations?.toCodec
      if (Predicate.isFunction(getLink)) {
        const tps = AST.isDeclaration(ast)
          ? ast.typeParameters.map((tp) => InternalSchema.make(AST.toEncoded(tp)))
          : []
        const link = getLink(tps)
        const to = recur(link.to)
        return AST.replaceEncoding(ast, to === link.to ? [link] : [new AST.Link(to, link.transformation)])
      }
      return AST.replaceEncoding(ast, [AST.unknownToNull])
    }
    case "Unknown":
    case "ObjectKeyword":
      return AST.replaceEncoding(ast, [AST.unknownToJson])
    case "Undefined":
    case "Void":
    case "Literal":
    case "Number":
      return ast.toCodecJson()
    case "UniqueSymbol":
    case "Symbol":
    case "BigInt":
      return ast.toCodecStringTree()
    case "Objects": {
      if (ast.propertySignatures.some((ps) => typeof ps.name !== "string")) {
        throw new globalThis.Error("Objects property names must be strings", { cause: ast })
      }
      return ast.recur(recur)
    }
    case "Union": {
      const sortedTypes = InternalSchema.jsonReorder(ast.types)
      if (sortedTypes !== ast.types) {
        return new AST.Union(
          sortedTypes,
          ast.mode,
          ast.annotations,
          ast.checks,
          ast.encoding,
          ast.context
        ).recur(recur)
      }
      return ast.recur(recur)
    }
    case "Arrays":
    case "Suspend":
      return ast.recur(recur)
  }
  // `Schema.Any` is used as an escape hatch
  return ast
}

/**
 * Derives an isomorphism codec from a schema. The encoded form is the
 * schema's `Iso` type — the intermediate representation used for round-tripping.
 *
 * @category Canonical Codecs
 * @since 4.0.0
 */
export function toCodecIso<S extends Top>(schema: S): Codec<S["Type"], S["Iso"]> {
  return make(toCodecIsoTop(AST.toType(schema.ast)))
}

const toCodecIsoTop = memoize((ast: AST.AST): AST.AST => {
  const out = toCodecIsoBase(ast, toCodecIsoTop)
  return out !== ast && AST.isOptional(ast) ? AST.optionalKeyLastLink(out) : out
})

function toCodecIsoBase(ast: AST.AST, recur: (ast: AST.AST) => AST.AST): AST.AST {
  switch (ast._tag) {
    case "Declaration": {
      const getLink = ast.annotations?.toCodecIso ?? ast.annotations?.toCodec
      if (Predicate.isFunction(getLink)) {
        const link = getLink(ast.typeParameters.map((tp) => InternalSchema.make(tp)))
        const to = recur(link.to)
        return AST.replaceEncoding(ast, to === link.to ? [link] : [new AST.Link(to, link.transformation)])
      }
      return ast
    }
    case "Arrays":
    case "Objects":
    case "Union":
    case "Suspend":
      return ast.recur(recur)
  }
  return ast
}

/**
 * A {@link Tree} of `string | undefined` nodes. Leaf values are either a
 * string representation or `undefined` for opaque/declaration types.
 *
 * @category Canonical Codecs
 * @since 4.0.0
 */
export type StringTree = Tree<string | undefined>

/**
 * Converts a schema to the StringTree canonical codec, where every leaf value
 * becomes a string while preserving the original structure.
 *
 * **Details**
 *
 * Declarations are converted to `undefined` (unless they have a
 * `toCodecJson` or `toCodec` annotation).
 *
 * Options:
 *
 * - `keepDeclarations`: if `true`, it **does not** convert declarations to
 *   `undefined` but instead keeps them as they are (unless they have a
 *   `toCodecJson` or `toCodec` annotation).
 *
 *    Defaults to `false`.
 *
 * @category Canonical Codecs
 * @since 4.0.0
 */
export function toCodecStringTree<T, E, RD, RE>(schema: Codec<T, E, RD, RE>): Codec<T, StringTree, RD, RE>
export function toCodecStringTree<T, E, RD, RE>(
  schema: Codec<T, E, RD, RE>,
  options: { readonly keepDeclarations: true } // Used in FormData
): Codec<T, unknown, RD, RE>
export function toCodecStringTree<T, E, RD, RE>(
  schema: Codec<T, E, RD, RE>,
  options?: { readonly keepDeclarations?: boolean | undefined }
): Codec<T, unknown, RD, RE> {
  return make(
    toCodecEnsureArray(
      options?.keepDeclarations === true
        ? serializerStringTreeKeepDeclarations(schema.ast)
        : serializerStringTree(schema.ast)
    )
  )
}

type XmlEncoderOptions = {
  /** Root element name for the returned XML string. Default: "root" */
  readonly rootName?: string | undefined
  /** When an array doesn't have a natural item name, use this. Default: "item" */
  readonly arrayItemName?: string | undefined
  /** Pretty-print output. Default: true */
  readonly pretty?: boolean | undefined
  /** Indentation used when pretty-printing. Default: "  " (two spaces) */
  readonly indent?: string | undefined
  /** Sort object keys for stable output. Default: true */
  readonly sortKeys?: boolean | undefined
}

/**
 * Derives an XML encoder from a codec.
 *
 * **Details**
 *
 * The returned function encodes a value through `toCodecStringTree` and returns
 * an `Effect` that succeeds with the XML string or fails with `SchemaError` if
 * codec encoding fails.
 *
 * @category Canonical Codecs
 * @since 4.0.0
 */
export function toEncoderXml<T, E, RD, RE>(
  codec: Codec<T, E, RD, RE>,
  options?: XmlEncoderOptions
) {
  const rootName = InternalAnnotations.resolveIdentifier(codec.ast) ?? InternalAnnotations.resolveTitle(codec.ast)
  const serialize = encodeEffect(toCodecStringTree(codec))
  return (t: T): Effect.Effect<string, SchemaError, RE> =>
    serialize(t).pipe(Effect.map((stringTree) => stringTreeToXml(stringTree, { rootName, ...options })))
}

function stringTreeToXml(value: StringTree, options: XmlEncoderOptions): string {
  const rootName = options.rootName ?? "root"
  const arrayItemName = options.arrayItemName ?? "item"
  const pretty = options.pretty ?? true
  const indent = options.indent ?? "  "
  const sortKeys = options.sortKeys ?? true

  const seen = new Set<object>()
  const lines: Array<string> = []

  recur(rootName, value, 0)
  return lines.join(pretty ? "\n" : "")

  function push(depth: number, text: string): void {
    lines.push(pretty ? indent.repeat(depth) + text : text)
  }

  function recur(tagName: string, node: StringTree, depth: number, originalNameForMeta?: string): void {
    const { attrs, safe } = xml.tagInfo(tagName, originalNameForMeta)

    if (node === undefined) {
      push(depth, `<${safe}${attrs}/>`)
    } else if (typeof node === "string") {
      push(depth, `<${safe}${attrs}>${xml.escapeText(node)}</${safe}>`)
    } else if (typeof node !== "object" || node === null) {
      push(depth, `<${safe}${attrs}>${xml.escapeText(format(node))}</${safe}>`)
    } else {
      if (seen.has(node)) throw new globalThis.Error("Cycle detected while serializing to XML.", { cause: node })
      seen.add(node)
      try {
        if (globalThis.globalThis.Array.isArray(node)) {
          if (node.length === 0) {
            push(depth, `<${safe}${attrs}/>`)
            return
          }
          push(depth, `<${safe}${attrs}>`)
          for (const item of node) recur(arrayItemName, item, depth + 1)
          push(depth, `</${safe}>`)
          return
        }

        const obj = node as Record<string, StringTree>
        const keys = Object.keys(obj)
        if (sortKeys) keys.sort()

        if (keys.length === 0) {
          push(depth, `<${safe}${attrs}/>`)
          return
        }

        push(depth, `<${safe}${attrs}>`)
        for (const k of keys) {
          recur(xml.parseTagName(k).safe, obj[k], depth + 1, k)
        }
        push(depth, `</${safe}>`)
      } finally {
        seen.delete(node)
      }
    }
  }
}

const xml = {
  escapeText(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  },
  escapeAttribute(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  },
  parseTagName(name: string): { safe: string; changed: boolean } {
    const original = name
    let safe = name
    if (!/^[A-Za-z_]/.test(safe)) safe = "_" + safe
    safe = safe.replace(/[^A-Za-z0-9._-]/g, "_")
    if (/^xml/i.test(safe)) safe = "_" + safe
    return { safe, changed: safe !== original }
  },
  tagInfo(name: string, original?: string): { safe: string; attrs: string } {
    const { changed, safe } = xml.parseTagName(name)
    const needsMeta = changed || (original && original !== name)
    const attrs = needsMeta ? ` data-name="${xml.escapeAttribute(original ?? name)}"` : ""
    return { safe, attrs }
  }
}

function getStringTreePriority(ast: AST.AST): number {
  switch (ast._tag) {
    case "Null":
    case "Boolean":
    case "Number":
    case "BigInt":
    case "Symbol":
    case "UniqueSymbol":
      return 0
    default:
      return 1
  }
}

const treeReorder = InternalSchema.makeReorder(getStringTreePriority)

function serializerTree(
  ast: AST.AST,
  recur: (ast: AST.AST) => AST.AST,
  onMissingAnnotation: (ast: AST.AST) => AST.AST
): AST.AST {
  switch (ast._tag) {
    case "Declaration": {
      const getLink = ast.annotations?.toCodecJson ?? ast.annotations?.toCodec
      if (Predicate.isFunction(getLink)) {
        const tps = AST.isDeclaration(ast)
          ? ast.typeParameters.map((tp) => make(recur(AST.toEncoded(tp))))
          : []
        const link = getLink(tps)
        const to = recur(link.to)
        return AST.replaceEncoding(ast, to === link.to ? [link] : [new AST.Link(to, link.transformation)])
      }
      return onMissingAnnotation(ast)
    }
    case "Null":
      return AST.replaceEncoding(ast, [nullToString])
    case "Boolean":
      return AST.replaceEncoding(ast, [booleanToString])
    case "Unknown":
    case "ObjectKeyword":
      return AST.replaceEncoding(ast, [AST.unknownToStringTree])
    case "Enum":
    case "Number":
    case "Literal":
    case "UniqueSymbol":
    case "Symbol":
    case "BigInt":
      return ast.toCodecStringTree()
    case "Objects": {
      if (ast.propertySignatures.some((ps) => typeof ps.name !== "string")) {
        throw new globalThis.Error("Objects property names must be strings", { cause: ast })
      }
      return ast.recur(recur)
    }
    case "Union": {
      const sortedTypes = treeReorder(ast.types)
      if (sortedTypes !== ast.types) {
        return new AST.Union(
          sortedTypes,
          ast.mode,
          ast.annotations,
          ast.checks,
          ast.encoding,
          ast.context
        ).recur(recur)
      }
      return ast.recur(recur)
    }
    case "Arrays":
    case "Suspend":
      return ast.recur(recur)
  }
  // `Schema.Any` is used as an escape hatch
  return ast
}

const nullToString = new AST.Link(
  new AST.Literal("null"),
  new Transformation.Transformation(
    Getter.transform(() => null),
    Getter.transform(() => "null")
  )
)

const booleanToString = new AST.Link(
  new AST.Union([new AST.Literal("true"), new AST.Literal("false")], "anyOf"),
  new Transformation.Transformation(
    Getter.transform((s) => s === "true"),
    Getter.String()
  )
)

const serializerStringTree = AST.toCodec((ast) => {
  const out = serializerTree(ast, serializerStringTree, (ast) => AST.replaceEncoding(ast, [unknownToUndefined]))
  if (out !== ast && AST.isOptional(ast)) {
    return AST.optionalKeyLastLink(out)
  }
  return out
})

const unknownToUndefined = new AST.Link(
  AST.undefined,
  new Transformation.Transformation(
    Getter.passthrough(),
    Getter.transform(() => undefined)
  )
)

const serializerStringTreeKeepDeclarations = AST.toCodec((ast) => {
  const out = serializerTree(ast, serializerStringTreeKeepDeclarations, identity)
  if (out !== ast && AST.isOptional(ast)) {
    return AST.optionalKeyLastLink(out)
  }
  return out
})

const SERIALIZER_ENSURE_ARRAY = "~effect/Schema/SERIALIZER_ENSURE_ARRAY"

const toCodecEnsureArray = AST.toCodec((ast) => {
  if (AST.isUnion(ast) && ast.annotations?.[SERIALIZER_ENSURE_ARRAY]) {
    return ast
  }
  const out = onSerializerEnsureArray(ast)
  if (AST.isArrays(out)) {
    const ensure = new AST.Union(
      [
        out,
        AST.decodeTo(
          AST.string,
          out,
          new Transformation.Transformation(
            Getter.split(),
            Getter.passthrough()
          )
        )
      ],
      "anyOf",
      { [SERIALIZER_ENSURE_ARRAY]: true }
    )
    return AST.isOptional(ast) ? AST.optionalKey(ensure) : ensure
  }
  return out
})

function onSerializerEnsureArray(ast: AST.AST): AST.AST {
  switch (ast._tag) {
    default:
      return ast
    case "Declaration":
    case "Arrays":
    case "Objects":
    case "Union":
    case "Suspend":
      return ast.recur(toCodecEnsureArray)
  }
}

// -----------------------------------------------------------------------------
// Optic APIs
// -----------------------------------------------------------------------------

/**
 * Derives an `Iso` optic from a schema that isomorphically converts between
 * the schema's `Type` and its `Iso` (intermediate / serialized form).
 *
 * @category Optic
 * @since 4.0.0
 */
export function toIso<S extends Top>(schema: S): Optic_.Iso<S["Type"], S["Iso"]> {
  const serializer = toCodecIso(schema)
  return Optic_.makeIso(Parser.encodeSync(serializer), Parser.decodeSync(serializer))
}

/**
 * Returns an identity `Iso` over the schema's source (`Type`) side.
 *
 * @category Optic
 * @since 4.0.0
 */
export function toIsoSource<S extends Top>(_: S): Optic_.Iso<S["Type"], S["Type"]> {
  return Optic_.id()
}

/**
 * Returns an identity `Iso` over the schema's focus (`Iso`) side.
 *
 * @category Optic
 * @since 4.0.0
 */
export function toIsoFocus<S extends Top>(_: S): Optic_.Iso<S["Iso"], S["Iso"]> {
  return Optic_.id()
}

/**
 * The schema type returned by {@link overrideToCodecIso}. Carries a custom
 * `Iso` type parameter and exposes the original `schema`.
 *
 * @category Optic
 * @since 4.0.0
 */
export interface overrideToCodecIso<S extends Top, Iso> extends
  Bottom<
    S["Type"],
    S["Encoded"],
    S["DecodingServices"],
    S["EncodingServices"],
    S["ast"],
    overrideToCodecIso<S, Iso>,
    S["~type.make.in"],
    Iso,
    S["~type.parameters"],
    S["~type.make"],
    S["~type.mutability"],
    S["~type.optionality"],
    S["~type.constructor.default"],
    S["~encoded.mutability"],
    S["~encoded.optionality"]
  >
{
  readonly schema: S
}

/**
 * Overrides a schema's derived ISO codec with an explicit target codec.
 *
 * **When to use**
 *
 * Use to provide a custom ISO transformation when the default derivation is not
 * appropriate.
 *
 * **Details**
 *
 * The resulting schema carries a custom `Iso` type parameter and uses the
 * provided `decode` and `encode` getters to transform between the schema type
 * and the target codec.
 *
 * @category Optic
 * @since 4.0.0
 */
export function overrideToCodecIso<S extends Top, Iso>(
  to: Codec<Iso>,
  transformation: {
    readonly decode: Getter.Getter<S["Type"], Iso>
    readonly encode: Getter.Getter<Iso, S["Type"]>
  }
) {
  return (schema: S): overrideToCodecIso<S, Iso> => {
    return make(
      AST.annotate(schema.ast, {
        toCodecIso: () => new AST.Link(to.ast, Transformation.make(transformation))
      }),
      { schema }
    )
  }
}

// -----------------------------------------------------------------------------
// Differ APIs
// -----------------------------------------------------------------------------

/**
 * Derives a JSON Patch differ from a codec. Serializes values to JSON (via
 * {@link toCodecJson}), computes RFC 6902 JSON Patch operations between old
 * and new values, and can apply patches back to the typed value.
 *
 * @category JsonPatch
 * @since 4.0.0
 */
export function toDifferJsonPatch<T, E>(schema: Codec<T, E>): Differ<T, JsonPatch.JsonPatch> {
  const serializer = toCodecJson(schema)
  const get = Parser.encodeSync(serializer)
  const set = Parser.decodeSync(serializer)
  return {
    empty: [],
    diff: (oldValue, newValue) => JsonPatch.get(get(oldValue), get(newValue)),
    combine: (first, second) => [...first, ...second],
    patch: (oldValue, patch) => {
      const value = get(oldValue)
      const patched = JsonPatch.apply(patch, value)
      return Object.is(patched, value) ? oldValue : set(patched)
    }
  }
}

/**
 * Recursive tree type whose leaves are `Node` values and whose branches are
 * readonly arrays or string-keyed records of child trees.
 *
 * @category Tree
 * @since 4.0.0
 */
export type Tree<Node> = Node | TreeRecord<Node> | ReadonlyArray<Tree<Node>>

/**
 * A record node in a {@link Tree}: an object mapping string keys to child
 * `Tree` nodes.
 *
 * @category Tree
 * @since 4.0.0
 */
export interface TreeRecord<A> {
  readonly [x: string]: Tree<A>
}

/**
 * Creates a recursive schema for a {@link Tree} of values described by `node`.
 * The resulting schema accepts a single node value, an array of trees, or an
 * object whose values are trees.
 *
 * @category Tree
 * @since 4.0.0
 */
export function Tree<S extends Top>(node: S) {
  const Tree$ref = suspend((): Codec<
    Tree<S["Type"]>,
    Tree<S["Encoded"]>,
    S["DecodingServices"],
    S["EncodingServices"]
  > => Tree)
  const Tree = Union([
    node,
    ArraySchema(Tree$ref),
    Record(String, Tree$ref)
  ])
  return Tree
}

/**
 * Recursive TypeScript type for any valid immutable JSON value: `null`,
 * `number`, `boolean`, `string`, a readonly array of `Json` values, or a
 * readonly record of `string → Json`. For the corresponding schema, see the
 * {@link Json} const.
 *
 * @category JSON
 * @since 4.0.0
 */
export type Json = null | number | boolean | string | JsonArray | JsonObject

/**
 * A readonly array of {@link Json} values.
 *
 * @category JSON
 * @since 4.0.0
 */
export interface JsonArray extends ReadonlyArray<Json> {}

/**
 * A readonly record whose values are {@link Json} values.
 *
 * @category JSON
 * @since 4.0.0
 */
export interface JsonObject {
  readonly [x: string]: Json
}

/**
 * Schema that accepts and validates any immutable JSON-compatible value.
 *
 * **Example** (Validating a JSON value)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * const result = Schema.decodeUnknownOption(Schema.Json)({ key: [1, true, null] })
 * console.log(result._tag) // "Some"
 * ```
 *
 * @category JSON
 * @since 4.0.0
 */
export const Json: Codec<Json> = make(AST.Json)

/**
 * Recursive TypeScript type for mutable JSON values: `null`, `number`,
 * `boolean`, `string`, mutable arrays, or mutable string-keyed records.
 *
 * @category JSON
 * @since 4.0.0
 */
export type MutableJson = null | number | boolean | string | MutableJsonArray | MutableJsonObject

/**
 * A mutable array of {@link MutableJson} values.
 *
 * @category JSON
 * @since 4.0.0
 */
export interface MutableJsonArray extends Array<MutableJson> {}

/**
 * A mutable record whose values are {@link MutableJson} values.
 *
 * @category JSON
 * @since 4.0.0
 */
export interface MutableJsonObject {
  [x: string]: MutableJson
}

/**
 * Schema that accepts any mutable JSON-compatible value. See {@link Json} for
 * the immutable variant.
 *
 * @category JSON
 * @since 4.0.0
 */
export const MutableJson: Codec<MutableJson> = make(AST.MutableJson)

// -----------------------------------------------------------------------------
// Annotations
// -----------------------------------------------------------------------------

/**
 * Resolves the typed annotations from a schema. The term "resolve" (rather
 * than "get") reflects the lookup strategy: if the schema has checks, the
 * annotations are taken from the last check; otherwise they are taken from
 * the base schema instance.
 *
 * @category Schema Resolvers
 * @since 4.0.0
 */
export function resolveAnnotations<S extends Top>(
  schema: S
): Annotations.Bottom<S["Type"], S["~type.parameters"]> | undefined {
  return InternalAnnotations.resolve(schema.ast)
}

/**
 * Resolves the context (key-level) annotations from a schema. Context
 * annotations are those attached via `annotateKey` and live on the AST's
 * `context` rather than on the schema node itself.
 *
 * @category Schema Resolvers
 * @since 4.0.0
 */
export function resolveAnnotationsKey<S extends Top>(schema: S): Annotations.Key<S["Type"]> | undefined {
  return schema.ast.context?.annotations
}

/**
 * The `Annotations` namespace groups all annotation interfaces used to attach
 * metadata to schemas. Annotations control documentation, validation messages,
 * JSON Schema generation, equivalence, arbitrary generation, and more.
 *
 * **Details**
 *
 * Use {@link resolveAnnotations} to read the annotations attached to a schema at
 * runtime.
 *
 * @since 3.10.0
 */
export declare namespace Annotations {
  /**
   * This interface is used to define the annotations that can be attached to a
   * schema. You can extend this interface to define your own annotations.
   *
   * **Details**
   *
   * Note that both a missing key or `undefined` is used to indicate that the
   * annotation is not present.
   *
   * This means that can remove any annotation by setting it to `undefined`.
   *
   * **Example** (Defining your own annotations)
   *
   * ```ts
   * import { Schema } from "effect"
   *
   * // Extend the Annotations interface with a custom `version` annotation
   * declare module "effect/Schema" {
   *   namespace Annotations {
   *     interface Annotations {
   *       readonly version?:
   *         | readonly [major: number, minor: number, patch: number]
   *         | undefined
   *     }
   *   }
   * }
   *
   * // The `version` annotation is now recognized by the TypeScript compiler
   * const schema = Schema.String.annotate({ version: [1, 2, 0] })
   *
   * // const version: readonly [major: number, minor: number, patch: number] | undefined
   * const version = Schema.resolveAnnotations(schema)?.["version"]
   *
   * if (version) {
   *   // Access individual parts of the version
   *   console.log(version[1])
   *   // Output: 2
   * }
   * ```
   *
   * @category models
   * @since 3.10.0
   */
  export interface Annotations {
    readonly [x: string]: unknown
  }

  /**
   * Annotations shared by all schema nodes. These map to common JSON Schema /
   * OpenAPI fields: `title`, `description`, `format`, etc.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Augment extends Annotations {
    /**
     * Human-readable description of what a value is expected to satisfy.
     *
     * **Details**
     *
     * For filter and refinement failures, the default formatter uses
     * `message` first, then `expected`, and finally falls back to `<filter>`.
     *
     * Use this to name a failed filter in the default message:
     * `Expected <expected>, got <actual>`.
     */
    readonly expected?: string | undefined
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly documentation?: string | undefined
    readonly readOnly?: boolean | undefined
    readonly writeOnly?: boolean | undefined
    readonly format?: string | undefined
    readonly contentEncoding?: string | undefined
    readonly contentMediaType?: string | undefined
  }

  /**
   * Extends {@link Augment} with type-parametric `default` and `examples` fields.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Documentation<T> extends Augment {
    readonly default?: T | undefined
    readonly examples?: ReadonlyArray<T> | undefined
  }

  /**
   * Annotations for struct property schemas. Extends {@link Documentation}
   * with an optional `messageMissingKey` to override the error message when
   * the property key is absent during decoding.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Key<T> extends Documentation<T> {
    /**
     * The message to use when a key is missing.
     */
    readonly messageMissingKey?: string | undefined
  }

  /**
   * Base annotations shared by all composite schema nodes. Extends
   * {@link Documentation} with error messages, branding, parse options, and
   * arbitrary generation hooks. {@link Declaration} and other annotation
   * interfaces build on top of this.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Bottom<T, TypeParameters extends ReadonlyArray<Top>> extends Documentation<T> {
    /**
     * Complete message to use when this schema node reports an issue.
     *
     * **Details**
     *
     * This replaces the default message for matching issue types instead of
     * only changing the expected label. For a filter or refinement failure,
     * annotate the filter with `message` to replace the whole filter failure
     * message, or `expected` to keep the default
     * `Expected <expected>, got <actual>` shape.
     */
    readonly message?: string | undefined
    /**
     * The message to use when a key is unexpected.
     */
    readonly messageUnexpectedKey?: string | undefined
    /**
     * Stable identifier for this schema node.
     *
     * **Details**
     *
     * Identifiers are used by schema tooling, including JSON Schema
     * generation, to name references. The default formatter also uses
     * `identifier` as the expected label for type-level failures, such as
     * `Expected UserId, got null`.
     *
     * `identifier` does not name a failed filter or refinement. If the base
     * type matches and a filter fails, put `expected` or `message` on the
     * filter/refinement instead.
     */
    readonly identifier?: string | undefined
    readonly parseOptions?: AST.ParseOptions | undefined
    /**
     * Optional metadata used to identify or extend the filter with custom data.
     */
    readonly meta?: Meta | undefined
    /**
     * Accumulated brands when multiple brands are added with `Schema.brand`.
     */
    readonly brands?: ReadonlyArray<string> | undefined
    readonly toArbitrary?:
      | ToArbitrary.Declaration<T, TypeParameters>
      | undefined
  }

  /**
   * Helpers for projecting declaration type-parameter schemas into decoded or
   * encoded codec arrays used by annotation hooks.
   *
   * @since 4.0.0
   */
  export namespace TypeParameters {
    /**
     * Maps declaration type-parameter schemas to codecs for their decoded `Type`
     * values.
     *
     * @category utility types
     * @since 3.10.0
     */
    export type Type<TypeParameters extends ReadonlyArray<Top>> = {
      readonly [K in keyof TypeParameters]: Codec<TypeParameters[K]["Type"]>
    }
    /**
     * Maps declaration type-parameter schemas to codecs for their `Encoded` values.
     *
     * @category utility types
     * @since 3.10.0
     */
    export type Encoded<TypeParameters extends ReadonlyArray<Top>> = {
      readonly [K in keyof TypeParameters]: Codec<TypeParameters[K]["Encoded"]>
    }
  }

  /**
   * Full annotation set for `Declaration` schema nodes — used when defining
   * custom, opaque schema types via `Schema.declare`. Extends {@link Bottom}
   * with optional codec, arbitrary, equivalence, and formatter hooks so that
   * derived capabilities (JSON encoding, property testing, etc.) can be
   * provided for the custom type.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Declaration<T, TypeParameters extends ReadonlyArray<Top> = readonly []>
    extends Bottom<T, TypeParameters>
  {
    readonly toCodec?:
      | ((typeParameters: TypeParameters.Encoded<TypeParameters>) => AST.Link)
      | undefined
    readonly toCodecJson?:
      | ((typeParameters: TypeParameters.Encoded<TypeParameters>) => AST.Link)
      | undefined
    readonly toCodecIso?:
      | ((typeParameters: TypeParameters.Type<TypeParameters>) => AST.Link)
      | undefined
    readonly toArbitrary?: ToArbitrary.Declaration<T, TypeParameters> | undefined
    readonly toEquivalence?: ToEquivalence.Declaration<T, TypeParameters> | undefined
    readonly toFormatter?: ToFormatter.Declaration<T, TypeParameters> | undefined
    readonly typeConstructor?: {
      readonly _tag: string
    } | undefined
    readonly generation?: {
      readonly runtime: string
      readonly Type: string
      readonly Encoded?: string | undefined
      readonly importDeclaration?: string | undefined
    } | undefined
    /**
     * Used to collect sentinels from a Declaration AST.
     *
     * @internal
     */
    readonly "~sentinels"?: ReadonlyArray<AST.Sentinel> | undefined
  }

  /**
   * Annotations for filter schema nodes (created via `Schema.filter`). Extends
   * {@link Augment} with an optional error message, identifier, and metadata.
   * Filters are intentionally non-parametric to keep them covariant.
   *
   * @category models
   * @since 3.10.0
   */
  export interface Filter extends Augment {
    /**
     * Complete message to use when this filter or refinement fails.
     *
     * **Details**
     *
     * The default formatter checks filter annotations in this order:
     * `message`, then `expected`, then `<filter>`.
     */
    readonly message?: string | undefined
    /**
     * Stable identifier for the schema after this filter is attached.
     *
     * **Details**
     *
     * This can affect schema tooling such as JSON Schema generation and
     * type-level failures before the filter runs, but it does not name the
     * failed filter itself. For filter failure messages, use `expected` or
     * `message`.
     */
    readonly identifier?: string | undefined
    /**
     * Optional metadata used to identify or extend the filter with custom data.
     */
    readonly meta?: Meta | undefined
    readonly toArbitraryConstraint?:
      | ToArbitrary.Constraint
      | undefined
    /**
     * Marks the filter as *structural*, meaning it applies to the shape or
     * structure of the container (e.g., array length, object keys) rather than
     * the contents.
     *
     * **Details**
     *
     * Example: `minLength` on an array is a structural filter.
     */
    readonly "~structural"?: boolean | undefined
  }

  /**
   * Types used by arbitrary-derivation annotations to configure `toArbitrary`
   * hooks and carry merged fast-check constraints.
   *
   * @since 4.0.0
   */
  export namespace ToArbitrary {
    /**
     * fast-check string constraints plus optional regular-expression pattern strings
     * used when deriving string arbitraries from schema checks.
     *
     * @category models
     * @since 4.0.0
     */
    export interface StringConstraints extends FastCheck.StringSharedConstraints {
      readonly patterns?: readonly [string, ...Array<string>]
    }

    /**
     * fast-check floating-point constraints plus `isInteger`, which switches
     * derived number arbitraries to integer generation.
     *
     * @category models
     * @since 4.0.0
     */
    export interface NumberConstraints extends FastCheck.FloatConstraints {
      readonly isInteger?: boolean
    }

    /**
     * fast-check bigint constraints used when deriving arbitraries for bigint
     * schemas.
     *
     * @category models
     * @since 4.0.0
     */
    export interface BigIntConstraints extends FastCheck.BigIntConstraints {}

    /**
     * fast-check array constraints plus an optional comparator used when deriving
     * unique-array arbitraries.
     *
     * @category models
     * @since 4.0.0
     */
    export interface ArrayConstraints extends FastCheck.ArrayConstraints {
      readonly comparator?: (a: any, b: any) => boolean
    }

    /**
     * fast-check date constraints used when deriving arbitraries for `Date` and
     * DateTime schemas.
     *
     * @category models
     * @since 4.0.0
     */
    export interface DateConstraints extends FastCheck.DateConstraints {}

    /**
     * Grouped arbitrary-generation constraints accumulated from schema checks and
     * passed to `toArbitrary` derivation.
     *
     * @category models
     * @since 4.0.0
     */
    export interface Constraint {
      readonly string?: StringConstraints | undefined
      readonly number?: NumberConstraints | undefined
      readonly bigint?: BigIntConstraints | undefined
      readonly array?: ArrayConstraints | undefined
      readonly date?: DateConstraints | undefined
    }

    /**
     * Context passed to arbitrary-derivation hooks, including accumulated
     * constraints and an `isSuspend` flag used to limit recursion for suspended
     * schemas.
     *
     * @category models
     * @since 3.10.0
     */
    export interface Context {
      /**
       * This flag is set to `true` when the current schema is a suspend. The goal
       * is to avoid infinite recursion when generating arbitrary values for
       * suspends, so implementations should try to avoid excessive recursion.
       */
      readonly isSuspend?: boolean | undefined
      readonly constraints?: ToArbitrary.Constraint | undefined
    }

    /**
     * Hook signature for declaration schema arbitrary annotations.
     *
     * **Details**
     *
     * Given arbitraries for any type parameters, returns a function that receives the
     * fast-check module and derivation context and produces an arbitrary for `T`.
     *
     * @category models
     * @since 4.0.0
     */
    export interface Declaration<T, TypeParameters extends ReadonlyArray<Top>> {
      (
        /* Arbitraries for any type parameters of the schema (if present) */
        typeParameters: { readonly [K in keyof TypeParameters]: FastCheck.Arbitrary<TypeParameters[K]["Type"]> }
      ): (fc: typeof FastCheck, context: Context) => FastCheck.Arbitrary<T>
    }
  }

  /**
   * Types used by formatter annotations to customize formatter derivation for
   * declaration schemas.
   *
   * @since 4.0.0
   */
  export namespace ToFormatter {
    /**
     * Hook signature for declaration schema formatter annotations.
     *
     * **Details**
     *
     * Given formatters for any type parameters, returns a formatter for `T`.
     *
     * @category models
     * @since 4.0.0
     */
    export interface Declaration<T, TypeParameters extends ReadonlyArray<Top>> {
      (
        /* Formatters for any type parameters of the schema (if present) */
        typeParameters: { readonly [K in keyof TypeParameters]: Formatter<TypeParameters[K]["Type"]> }
      ): Formatter<T>
    }
  }

  /**
   * Types used by equivalence annotations to customize equivalence derivation for
   * declaration schemas.
   *
   * @since 4.0.0
   */
  export namespace ToEquivalence {
    /**
     * Hook signature for declaration schema equivalence annotations.
     *
     * **Details**
     *
     * Given equivalences for any type parameters, returns an `Equivalence` for `T`.
     *
     * @category models
     * @since 4.0.0
     */
    export interface Declaration<T, TypeParameters extends ReadonlyArray<Top>> {
      (
        /* Equivalences for any type parameters of the schema (if present) */
        typeParameters: { readonly [K in keyof TypeParameters]: Equivalence.Equivalence<TypeParameters[K]["Type"]> }
      ): Equivalence.Equivalence<T>
    }
  }

  /**
   * Annotations that can be attached to schema issues.
   *
   * **Details**
   *
   * The optional `message` field overrides the default issue message.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Issue extends Annotations {
    readonly message?: string | undefined
  }

  /**
   * Registry of metadata payloads emitted by built-in schema filters and checks.
   *
   * **Details**
   *
   * Do not augment this interface with custom metadata; extend `MetaDefinitions`
   * instead.
   *
   * @category models
   * @since 4.0.0
   */
  export interface BuiltInMetaDefinitions {
    // String Meta
    readonly isStringFinite: {
      readonly _tag: "isStringFinite"
      readonly regExp: globalThis.RegExp
    }
    readonly isStringBigInt: {
      readonly _tag: "isStringBigInt"
      readonly regExp: globalThis.RegExp
    }
    readonly isStringSymbol: {
      readonly _tag: "isStringSymbol"
      readonly regExp: globalThis.RegExp
    }
    readonly isMinLength: {
      readonly _tag: "isMinLength"
      readonly minLength: number
    }
    readonly isMaxLength: {
      readonly _tag: "isMaxLength"
      readonly maxLength: number
    }
    readonly isLengthBetween: {
      readonly _tag: "isLengthBetween"
      readonly minimum: number
      readonly maximum: number
    }
    readonly isPattern: {
      readonly _tag: "isPattern"
      readonly regExp: globalThis.RegExp
    }
    readonly isTrimmed: {
      readonly _tag: "isTrimmed"
      readonly regExp: globalThis.RegExp
    }
    readonly isUUID: {
      readonly _tag: "isUUID"
      readonly regExp: globalThis.RegExp
      readonly version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | undefined
    }
    readonly isULID: {
      readonly _tag: "isULID"
      readonly regExp: globalThis.RegExp
    }
    readonly isBase64: {
      readonly _tag: "isBase64"
      readonly regExp: globalThis.RegExp
    }
    readonly isBase64Url: {
      readonly _tag: "isBase64Url"
      readonly regExp: globalThis.RegExp
    }
    readonly isStartsWith: {
      readonly _tag: "isStartsWith"
      readonly startsWith: string
      readonly regExp: globalThis.RegExp
    }
    readonly isEndsWith: {
      readonly _tag: "isEndsWith"
      readonly endsWith: string
      readonly regExp: globalThis.RegExp
    }
    readonly isIncludes: {
      readonly _tag: "isIncludes"
      readonly includes: string
      readonly regExp: globalThis.RegExp
    }
    readonly isUppercased: {
      readonly _tag: "isUppercased"
      readonly regExp: globalThis.RegExp
    }
    readonly isLowercased: {
      readonly _tag: "isLowercased"
      readonly regExp: globalThis.RegExp
    }
    readonly isCapitalized: {
      readonly _tag: "isCapitalized"
      readonly regExp: globalThis.RegExp
    }
    readonly isUncapitalized: {
      readonly _tag: "isUncapitalized"
      readonly regExp: globalThis.RegExp
    }
    // Number Meta
    readonly isFinite: {
      readonly _tag: "isFinite"
    }
    readonly isInt: {
      readonly _tag: "isInt"
    }
    readonly isMultipleOf: {
      readonly _tag: "isMultipleOf"
      readonly divisor: number
    }
    readonly isGreaterThan: {
      readonly _tag: "isGreaterThan"
      readonly exclusiveMinimum: number
    }
    readonly isGreaterThanOrEqualTo: {
      readonly _tag: "isGreaterThanOrEqualTo"
      readonly minimum: number
    }
    readonly isLessThan: {
      readonly _tag: "isLessThan"
      readonly exclusiveMaximum: number
    }
    readonly isLessThanOrEqualTo: {
      readonly _tag: "isLessThanOrEqualTo"
      readonly maximum: number
    }
    readonly isBetween: {
      readonly _tag: "isBetween"
      readonly minimum: number
      readonly maximum: number
      readonly exclusiveMinimum?: boolean | undefined
      readonly exclusiveMaximum?: boolean | undefined
    }
    // BigInt Meta
    readonly isGreaterThanBigInt: {
      readonly _tag: "isGreaterThanBigInt"
      readonly exclusiveMinimum: bigint
    }
    readonly isGreaterThanOrEqualToBigInt: {
      readonly _tag: "isGreaterThanOrEqualToBigInt"
      readonly minimum: bigint
    }
    readonly isLessThanBigInt: {
      readonly _tag: "isLessThanBigInt"
      readonly exclusiveMaximum: bigint
    }
    readonly isLessThanOrEqualToBigInt: {
      readonly _tag: "isLessThanOrEqualToBigInt"
      readonly maximum: bigint
    }
    readonly isBetweenBigInt: {
      readonly _tag: "isBetweenBigInt"
      readonly minimum: bigint
      readonly maximum: bigint
      readonly exclusiveMinimum?: boolean | undefined
      readonly exclusiveMaximum?: boolean | undefined
    }
    // Date Meta
    readonly isDateValid: {
      readonly _tag: "isDateValid"
    }
    readonly isGreaterThanDate: {
      readonly _tag: "isGreaterThanDate"
      readonly exclusiveMinimum: globalThis.Date
    }
    readonly isGreaterThanOrEqualToDate: {
      readonly _tag: "isGreaterThanOrEqualToDate"
      readonly minimum: globalThis.Date
    }
    readonly isLessThanDate: {
      readonly _tag: "isLessThanDate"
      readonly exclusiveMaximum: globalThis.Date
    }
    readonly isLessThanOrEqualToDate: {
      readonly _tag: "isLessThanOrEqualToDate"
      readonly maximum: globalThis.Date
    }
    readonly isBetweenDate: {
      readonly _tag: "isBetweenDate"
      readonly minimum: globalThis.Date
      readonly maximum: globalThis.Date
      readonly exclusiveMinimum?: boolean | undefined
      readonly exclusiveMaximum?: boolean | undefined
    }
    // Objects Meta
    readonly isMinProperties: {
      readonly _tag: "isMinProperties"
      readonly minProperties: number
    }
    readonly isMaxProperties: {
      readonly _tag: "isMaxProperties"
      readonly maxProperties: number
    }
    readonly isPropertiesLengthBetween: {
      readonly _tag: "isPropertiesLengthBetween"
      readonly minimum: number
      readonly maximum: number
    }
    readonly isPropertyNames: {
      readonly _tag: "isPropertyNames"
      readonly propertyNames: AST.AST
    }
    // Arrays Meta
    readonly isUnique: {
      readonly _tag: "isUnique"
    }
    // Declaration Meta
    readonly isMinSize: {
      readonly _tag: "isMinSize"
      readonly minSize: number
    }
    readonly isMaxSize: {
      readonly _tag: "isMaxSize"
      readonly maxSize: number
    }
    readonly isSizeBetween: {
      readonly _tag: "isSizeBetween"
      readonly minimum: number
      readonly maximum: number
    }
  }

  /**
   * Union of all metadata payloads defined by `BuiltInMetaDefinitions`.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type BuiltInMeta = BuiltInMetaDefinitions[keyof BuiltInMetaDefinitions]

  /**
   * Augmentable registry of schema filter metadata payloads.
   *
   * **Details**
   *
   * Extend this interface to add custom values accepted by annotation `meta`
   * fields.
   *
   * @category models
   * @since 4.0.0
   */
  export interface MetaDefinitions extends BuiltInMetaDefinitions {}

  /**
   * Union of built-in and user-augmented schema filter metadata payloads.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Meta = MetaDefinitions[keyof MetaDefinitions]
}
