/**
 * Serializable intermediate representation (IR) of Effect Schema types.
 *
 * `SchemaRepresentation` sits between the internal `SchemaAST` and external
 * formats (JSON Schema, generated TypeScript code, serialized JSON). A
 * {@link Representation} is a discriminated union describing the *shape* of a
 * schema — its types, checks, annotations, and references — in a form that
 * can be round-tripped through JSON and used for code generation.
 *
 * ## Mental model
 *
 * - **Representation**: A tagged union (`_tag`) of all supported schema shapes:
 *   primitives, literals, objects, arrays, unions, declarations, references,
 *   and suspensions.
 * - **Document**: A single {@link Representation} paired with a map of named
 *   {@link References} (analogous to JSON Schema `$defs`).
 * - **MultiDocument**: Like `Document` but holds one or more representations
 *   sharing the same references.
 * - **Check / Filter / FilterGroup**: Validation constraints (min length,
 *   pattern, integer, etc.) attached to types that support them.
 * - **Meta types**: Typed metadata for checks on each category — e.g.
 *   {@link StringMeta}, {@link NumberMeta}, {@link ArraysMeta}.
 * - **Reviver**: A callback used by {@link toSchema} and {@link toCodeDocument}
 *   to handle `Declaration` nodes (custom types like `Option`, `Date`, etc.).
 * - **Code / CodeDocument**: Output of {@link toCodeDocument} — TypeScript
 *   source strings for runtime schemas and their type-level counterparts.
 *
 * ## Common tasks
 *
 * - Convert a Schema AST to a Document → {@link fromAST}
 * - Convert multiple ASTs to a MultiDocument → {@link fromASTs}
 * - Reconstruct a runtime Schema from a Document → {@link toSchema}
 * - Convert a Document to JSON Schema → {@link toJsonSchemaDocument}
 * - Convert a MultiDocument to JSON Schema → {@link toJsonSchemaMultiDocument}
 * - Parse a JSON Schema document into a Document → {@link fromJsonSchemaDocument}
 * - Parse a JSON Schema multi-document → {@link fromJsonSchemaMultiDocument}
 * - Generate TypeScript code from a MultiDocument → {@link toCodeDocument}
 * - Serialize/deserialize a Document as JSON → {@link DocumentFromJson}
 * - Serialize/deserialize a MultiDocument as JSON → {@link MultiDocumentFromJson}
 * - Wrap a Document as a MultiDocument → {@link toMultiDocument}
 *
 * ## Gotchas
 *
 * - `Declaration` nodes require a {@link Reviver} to reconstruct complex types
 *   (e.g. `Option`, `Date`). Without one, `toSchema` falls back to the
 *   declaration's `encodedSchema`. Use {@link toSchemaDefaultReviver} for
 *   built-in Effect types.
 * - `Reference` nodes are resolved against the `references` map in the
 *   `Document`. An unresolvable `$ref` throws at runtime.
 * - `Suspend` wraps a single `thunk` representation; it is used for recursive
 *   schemas. Circular references are handled by lazy resolution in
 *   {@link toSchema}.
 * - The `$`-prefixed exports (e.g. {@link $Representation}, {@link $Document})
 *   are Schema codecs for the representation types themselves — use them to
 *   validate or encode/decode representation data, not application data.
 *
 * ## Quickstart
 *
 * **Example** (Round-trip through JSON)
 *
 * ```ts
 * import { Schema, SchemaRepresentation } from "effect"
 *
 * const Person = Schema.Struct({
 *   name: Schema.String,
 *   age: Schema.Int
 * })
 *
 * // Schema AST → Document
 * const doc = SchemaRepresentation.fromAST(Person.ast)
 *
 * // Document → JSON Schema
 * const jsonSchema = SchemaRepresentation.toJsonSchemaDocument(doc)
 *
 * // Document → runtime Schema
 * const reconstructed = SchemaRepresentation.toSchema(doc)
 * ```
 *
 * ## See also
 *
 * - {@link Representation} — the core tagged union
 * - {@link Document} — single-schema container
 * - {@link fromAST} — entry point from Schema AST
 * - {@link toSchema} — reconstruct a runtime Schema
 * - {@link toCodeDocument} — generate TypeScript code
 *
 * @since 4.0.0
 */
import * as Arr from "./Array.ts"
import { format, formatPropertyKey } from "./Formatter.ts"
import { collectBrands } from "./internal/schema/annotations.ts"
import * as InternalRepresentation from "./internal/schema/representation.ts"
import { unescapeToken } from "./JsonPointer.ts"
import type * as JsonSchema from "./JsonSchema.ts"
import * as Option from "./Option.ts"
import * as Predicate from "./Predicate.ts"
import * as Rec from "./Record.ts"
import * as Schema from "./Schema.ts"
import type * as AST from "./SchemaAST.ts"
import * as Getter from "./SchemaGetter.ts"

// -----------------------------------------------------------------------------
// specification
// -----------------------------------------------------------------------------

/**
 * A custom type declaration, such as `Date`, `Option`, or `ReadonlySet`.
 *
 * **When to use**
 *
 * Use when inspecting or transforming non-primitive schema types.
 *
 * **Details**
 *
 * `typeParameters` holds the inner type arguments, such as the `A` in
 * `Option<A>`. `encodedSchema` is the fallback representation when no
 * {@link Reviver} recognizes this declaration. `annotations.typeConstructor`
 * identifies the declaration kind, such as `{ _tag: "effect/Option" }`.
 *
 * @see {@link Reviver}
 * @see {@link toSchemaDefaultReviver}
 *
 * @category models
 * @since 4.0.0
 */
export interface Declaration {
  readonly _tag: "Declaration"
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly typeParameters: ReadonlyArray<Representation>
  readonly checks: ReadonlyArray<Check<DeclarationMeta>>
  readonly encodedSchema: Representation
}

/**
 * A lazily resolved representation used for recursive schemas.
 *
 * **Details**
 *
 * `thunk` points to the actual representation, possibly via a
 * {@link Reference}. `checks` is always empty on `Suspend` nodes.
 *
 * @see {@link Reference}
 *
 * @category models
 * @since 4.0.0
 */
export interface Suspend {
  readonly _tag: "Suspend"
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly checks: readonly []
  readonly thunk: Representation
}

/**
 * A named reference to a definition in the {@link References} map.
 *
 * **Details**
 *
 * `$ref` is the key into `Document.references` or `MultiDocument.references`.
 * References are resolved lazily by {@link toSchema} and
 * {@link toCodeDocument}.
 *
 * **Gotchas**
 *
 * Resolution throws at runtime if the key is not found in the references map.
 *
 * @see {@link References}
 * @see {@link Document}
 *
 * @category models
 * @since 4.0.0
 */
export interface Reference {
  readonly _tag: "Reference"
  readonly $ref: string
}

/**
 * The `null` type.
 *
 * @category models
 * @since 4.0.0
 */
export interface Null {
  readonly _tag: "Null"
  readonly annotations?: Schema.Annotations.Annotations | undefined
}

/**
 * The `undefined` type.
 *
 * @category models
 * @since 4.0.0
 */
export interface Undefined {
  readonly _tag: "Undefined"
  readonly annotations?: Schema.Annotations.Annotations | undefined
}

/**
 * The `void` type.
 *
 * @category models
 * @since 4.0.0
 */
export interface Void {
  readonly _tag: "Void"
  readonly annotations?: Schema.Annotations.Annotations | undefined
}

/**
 * The `never` type (no valid values).
 *
 * @category models
 * @since 4.0.0
 */
export interface Never {
  readonly _tag: "Never"
  readonly annotations?: Schema.Annotations.Annotations | undefined
}

/**
 * The `unknown` type (any value accepted).
 *
 * @category models
 * @since 4.0.0
 */
export interface Unknown {
  readonly _tag: "Unknown"
  readonly annotations?: Schema.Annotations.Annotations | undefined
}

/**
 * The `any` type.
 *
 * @category models
 * @since 4.0.0
 */
export interface Any {
  readonly _tag: "Any"
  readonly annotations?: Schema.Annotations.Annotations | undefined
}

/**
 * The `string` type with optional validation checks.
 *
 * **Details**
 *
 * `checks` holds string-specific constraints, such as min/max length, pattern,
 * and UUID checks. `contentMediaType` and `contentSchema` indicate that the
 * string contains encoded data, such as `"application/json"` with a nested
 * schema.
 *
 * @see {@link StringMeta}
 * @see {@link Check}
 *
 * @category models
 * @since 4.0.0
 */
export interface String {
  readonly _tag: "String"
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly checks: ReadonlyArray<Check<StringMeta>>
  readonly contentMediaType?: string | undefined
  readonly contentSchema?: Representation | undefined
}

/**
 * The `number` type with optional validation checks.
 *
 * **Details**
 *
 * `checks` holds number-specific constraints, such as int, finite, min, max,
 * multipleOf, and between checks.
 *
 * @see {@link NumberMeta}
 *
 * @category models
 * @since 4.0.0
 */
export interface Number {
  readonly _tag: "Number"
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly checks: ReadonlyArray<Check<NumberMeta>>
}

/**
 * The `boolean` type.
 *
 * @category models
 * @since 4.0.0
 */
export interface Boolean {
  readonly _tag: "Boolean"
  readonly annotations?: Schema.Annotations.Annotations | undefined
}

/**
 * The `bigint` type with optional validation checks.
 *
 * @see {@link BigIntMeta}
 *
 * @category models
 * @since 4.0.0
 */
export interface BigInt {
  readonly _tag: "BigInt"
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly checks: ReadonlyArray<Check<BigIntMeta>>
}

/**
 * The `symbol` type.
 *
 * @category models
 * @since 4.0.0
 */
export interface Symbol {
  readonly _tag: "Symbol"
  readonly annotations?: Schema.Annotations.Annotations | undefined
}

/**
 * A specific literal value (`string`, `number`, `boolean`, or `bigint`).
 *
 * @category models
 * @since 4.0.0
 */
export interface Literal {
  readonly _tag: "Literal"
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly literal: string | number | boolean | bigint
}

/**
 * A specific unique `symbol` value.
 *
 * @category models
 * @since 4.0.0
 */
export interface UniqueSymbol {
  readonly _tag: "UniqueSymbol"
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly symbol: symbol
}

/**
 * The `object` keyword type (matches any non-primitive).
 *
 * @category models
 * @since 4.0.0
 */
export interface ObjectKeyword {
  readonly _tag: "ObjectKeyword"
  readonly annotations?: Schema.Annotations.Annotations | undefined
}

/**
 * A TypeScript-style enum. Each entry is a `[name, value]` pair.
 *
 * @category models
 * @since 4.0.0
 */
export interface Enum {
  readonly _tag: "Enum"
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly enums: ReadonlyArray<readonly [string, string | number]>
}

/**
 * A template literal type composed of a sequence of parts (literals, strings,
 * numbers, etc.).
 *
 * @category models
 * @since 4.0.0
 */
export interface TemplateLiteral {
  readonly _tag: "TemplateLiteral"
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly parts: ReadonlyArray<Representation>
}

/**
 * An array or tuple type.
 *
 * **Details**
 *
 * `elements` are the fixed positional elements, or tuple prefix, and each may
 * be optional. `rest` contains the variadic tail types; a single-element
 * `rest` with no `elements` produces a plain `Array<T>`. `checks` holds
 * array-specific constraints, such as minLength, maxLength, and unique checks.
 *
 * @see {@link Element}
 * @see {@link ArraysMeta}
 *
 * @category models
 * @since 4.0.0
 */
export interface Arrays {
  readonly _tag: "Arrays"
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly elements: ReadonlyArray<Element>
  readonly rest: ReadonlyArray<Representation>
  readonly checks: ReadonlyArray<Check<ArraysMeta>>
}

/**
 * A positional element within an {@link Arrays} tuple.
 *
 * **Details**
 *
 * `isOptional` indicates whether this element can be absent. `type` is the
 * schema representation for this element's value.
 *
 * @see {@link Arrays}
 *
 * @category models
 * @since 4.0.0
 */
export interface Element {
  readonly isOptional: boolean
  readonly type: Representation
  readonly annotations?: Schema.Annotations.Annotations | undefined
}

/**
 * An object/struct type with named properties and optional index signatures.
 *
 * **Details**
 *
 * `propertySignatures` are the explicitly named fields. `indexSignatures`
 * define catch-all key/value types, such as `Record<string, T>`. `checks`
 * holds object-specific constraints, such as minProperties and maxProperties.
 *
 * @see {@link PropertySignature}
 * @see {@link IndexSignature}
 * @see {@link ObjectsMeta}
 *
 * @category models
 * @since 4.0.0
 */
export interface Objects {
  readonly _tag: "Objects"
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly propertySignatures: ReadonlyArray<PropertySignature>
  readonly indexSignatures: ReadonlyArray<IndexSignature>
  readonly checks: ReadonlyArray<Check<ObjectsMeta>>
}

/**
 * A named property within an {@link Objects} representation.
 *
 * **Details**
 *
 * `name` is the property key, which can be a string, number, or symbol.
 * `isOptional` indicates whether the key can be absent. `isMutable` indicates
 * whether the property is mutable rather than readonly.
 *
 * @see {@link Objects}
 *
 * @category models
 * @since 4.0.0
 */
export interface PropertySignature {
  readonly name: PropertyKey
  readonly type: Representation
  readonly isOptional: boolean
  readonly isMutable: boolean
  readonly annotations?: Schema.Annotations.Annotations | undefined
}

/**
 * An index signature, such as `[key: string]: number`, within an
 * {@link Objects}.
 *
 * **Details**
 *
 * `parameter` is the key type representation. `type` is the value type
 * representation.
 *
 * @see {@link Objects}
 *
 * @category models
 * @since 4.0.0
 */
export interface IndexSignature {
  readonly parameter: Representation
  readonly type: Representation
}

/**
 * A union of multiple representations.
 *
 * **Details**
 *
 * `types` are the union members. `mode` controls JSON Schema output as either
 * `"anyOf"` (the default) or mutually exclusive `"oneOf"`.
 *
 * @category models
 * @since 4.0.0
 */
export interface Union {
  readonly _tag: "Union"
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly types: ReadonlyArray<Representation>
  readonly mode: "anyOf" | "oneOf"
}

/**
 * The core tagged union of all supported schema shapes.
 *
 * **Details**
 *
 * Each variant has a `_tag` discriminator. Switch on `_tag` to handle each
 * shape. Most variants carry optional `annotations` and some carry `checks`
 * for validation constraints.
 *
 * @see {@link Document}
 * @see {@link fromAST}
 *
 * @category models
 * @since 4.0.0
 */
export type Representation =
  | Declaration
  | Reference
  | Suspend
  | Null
  | Undefined
  | Void
  | Never
  | Unknown
  | Any
  | String
  | Number
  | Boolean
  | BigInt
  | Symbol
  | Literal
  | UniqueSymbol
  | ObjectKeyword
  | Enum
  | TemplateLiteral
  | Arrays
  | Objects
  | Union

/**
 * A validation constraint attached to a type. Either a single {@link Filter}
 * or a {@link FilterGroup} combining multiple checks.
 *
 * @see {@link Filter}
 * @see {@link FilterGroup}
 *
 * @category models
 * @since 4.0.0
 */
export type Check<M> = Filter<M> | FilterGroup<M>

/**
 * A single validation constraint with typed metadata describing the check
 * (e.g. `{ _tag: "isMinLength", minLength: 3 }`).
 *
 * @see {@link Check}
 *
 * @category models
 * @since 4.0.0
 */
export interface Filter<M> {
  readonly _tag: "Filter"
  readonly annotations?: Schema.Annotations.Filter | undefined
  readonly meta: M
}

/**
 * A group of validation constraints that are logically combined. Contains
 * at least one {@link Check}.
 *
 * @see {@link Check}
 *
 * @category models
 * @since 4.0.0
 */
export interface FilterGroup<M> {
  readonly _tag: "FilterGroup"
  readonly annotations?: Schema.Annotations.Filter | undefined
  readonly checks: readonly [Check<M>, ...Array<Check<M>>]
}

/**
 * Metadata union for string-specific validation checks (minLength, maxLength,
 * pattern, UUID, trimmed, etc.).
 *
 * @see {@link String}
 * @see {@link Check}
 *
 * @category models
 * @since 4.0.0
 */
export type StringMeta = Schema.Annotations.BuiltInMetaDefinitions[
  | "isStringFinite"
  | "isStringBigInt"
  | "isStringSymbol"
  | "isMinLength"
  | "isMaxLength"
  | "isPattern"
  | "isLengthBetween"
  | "isTrimmed"
  | "isUUID"
  | "isULID"
  | "isBase64"
  | "isBase64Url"
  | "isStartsWith"
  | "isEndsWith"
  | "isIncludes"
  | "isUppercased"
  | "isLowercased"
  | "isCapitalized"
  | "isUncapitalized"
]

/**
 * Metadata union for number-specific validation checks (int, finite,
 * min, max, multipleOf, between).
 *
 * @see {@link Number}
 * @see {@link Check}
 *
 * @category models
 * @since 4.0.0
 */
export type NumberMeta = Schema.Annotations.BuiltInMetaDefinitions[
  | "isInt"
  | "isFinite"
  | "isMultipleOf"
  | "isGreaterThanOrEqualTo"
  | "isLessThanOrEqualTo"
  | "isGreaterThan"
  | "isLessThan"
  | "isBetween"
]

/**
 * Metadata union for bigint-specific validation checks (min, max, between).
 *
 * @see {@link BigInt}
 * @see {@link Check}
 *
 * @category models
 * @since 4.0.0
 */
export type BigIntMeta = Schema.Annotations.BuiltInMetaDefinitions[
  | "isGreaterThanOrEqualToBigInt"
  | "isLessThanOrEqualToBigInt"
  | "isGreaterThanBigInt"
  | "isLessThanBigInt"
  | "isBetweenBigInt"
]

/**
 * Metadata union for array-specific validation checks (minLength, maxLength,
 * length, unique).
 *
 * @see {@link Arrays}
 * @see {@link Check}
 *
 * @category models
 * @since 4.0.0
 */
export type ArraysMeta = Schema.Annotations.BuiltInMetaDefinitions[
  | "isMinLength"
  | "isMaxLength"
  | "isLengthBetween"
  | "isUnique"
]

/**
 * Metadata union for object-specific validation checks (minProperties,
 * maxProperties, propertiesLength, propertyNames).
 *
 * @see {@link Objects}
 * @see {@link Check}
 *
 * @category models
 * @since 4.0.0
 */
export type ObjectsMeta =
  | Schema.Annotations.BuiltInMetaDefinitions[
    | "isMinProperties"
    | "isMaxProperties"
    | "isPropertiesLengthBetween"
  ]
  | { readonly _tag: "isPropertyNames"; readonly propertyNames: Representation }

/**
 * Metadata union for Date-specific validation checks (valid, min, max, between).
 *
 * @see {@link Declaration}
 * @see {@link DeclarationMeta}
 *
 * @category models
 * @since 4.0.0
 */
export type DateMeta = Schema.Annotations.BuiltInMetaDefinitions[
  | "isDateValid"
  | "isGreaterThanDate"
  | "isGreaterThanOrEqualToDate"
  | "isLessThanDate"
  | "isLessThanOrEqualToDate"
  | "isBetweenDate"
]

/**
 * Metadata union for size-based validation checks (minSize, maxSize, size).
 * Used for collection types like `Set`, `Map`.
 *
 * @see {@link Declaration}
 * @see {@link DeclarationMeta}
 *
 * @category models
 * @since 4.0.0
 */
export type SizeMeta = Schema.Annotations.BuiltInMetaDefinitions[
  | "isMinSize"
  | "isMaxSize"
  | "isSizeBetween"
]

/**
 * Metadata union for {@link Declaration} checks — either {@link DateMeta}
 * or {@link SizeMeta}.
 *
 * @category models
 * @since 4.0.0
 */
export type DeclarationMeta = DateMeta | SizeMeta

/** @internal */
export type Meta = StringMeta | NumberMeta | BigIntMeta | ArraysMeta | ObjectsMeta | DeclarationMeta

/**
 * A string-keyed map of named {@link Representation} definitions. Used by
 * {@link Document} and {@link MultiDocument} for `$ref` resolution (analogous
 * to JSON Schema `$defs`).
 *
 * @see {@link Reference}
 * @see {@link Document}
 *
 * @category models
 * @since 4.0.0
 */
export interface References {
  readonly [$ref: string]: Representation
}

/**
 * A single {@link Representation} together with its named {@link References}.
 *
 * **When to use**
 *
 * Use when representing a single Schema AST together with its named references
 * before reconstructing a runtime Schema, converting to JSON Schema, or
 * wrapping it as a {@link MultiDocument}.
 *
 * @see {@link MultiDocument}
 * @see {@link fromAST}
 *
 * @category models
 * @since 4.0.0
 */
export type Document = {
  readonly representation: Representation
  readonly references: References
}

/**
 * One or more {@link Representation}s sharing a common {@link References} map.
 *
 * **When to use**
 *
 * Use when you use {@link fromASTs} to create this from multiple Schema ASTs,
 * {@link toCodeDocument} to generate TypeScript code, and
 * {@link toJsonSchemaMultiDocument} to convert to JSON Schema.
 *
 * @see {@link Document}
 * @see {@link fromASTs}
 *
 * @category models
 * @since 4.0.0
 */
export type MultiDocument = {
  readonly representations: readonly [Representation, ...Array<Representation>]
  readonly references: References
}

// -----------------------------------------------------------------------------
// schemas
// -----------------------------------------------------------------------------

const Representation$ref = Schema.suspend(() => $Representation)

const toJsonAnnotationsBlacklist: Set<string> = new Set([
  ...InternalRepresentation.fromASTBlacklist,
  "expected",
  "contentMediaType",
  "contentSchema"
])

/**
 * A tree of primitive values used to serialize annotations to JSON.
 *
 * @category Tree
 * @since 4.0.0
 */
export type PrimitiveTree = Schema.Tree<null | number | boolean | bigint | symbol | string>

/**
 * Schema for {@link PrimitiveTree}.
 *
 * **When to use**
 *
 * Use to validate recursive annotation metadata trees whose leaves are `null`,
 * `number`, `boolean`, `bigint`, `symbol`, or `string`.
 *
 * @see {@link PrimitiveTree} for the recursive tree type accepted by this codec
 * @see {@link $Annotations} for the annotation codec that filters values through this codec
 *
 * @category schemas
 * @since 4.0.0
 */
export const $PrimitiveTree: Schema.Codec<PrimitiveTree> = Schema.Tree(
  Schema.Union([
    Schema.Null,
    Schema.Number, // allows NaN, Infinity, -Infinity
    Schema.Boolean,
    Schema.BigInt,
    Schema.Symbol,
    Schema.String
  ])
)

const isPrimitiveTree = Schema.is($PrimitiveTree)

/**
 * Schema for serializing public `Schema.Annotations.Annotations` values. It
 * filters out internal annotation keys and non-primitive values during
 * encoding.
 *
 * **When to use**
 *
 * Use to serialize schema annotations in representation schemas while retaining
 * only primitive-tree metadata.
 *
 * **Details**
 *
 * Decoding is passthrough. Encoding removes internal annotation keys and values
 * that are not accepted by `$PrimitiveTree`.
 *
 * @see {@link $PrimitiveTree} for the codec used to filter annotation values
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Annotations = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.encodeTo(Schema.Record(Schema.String, $PrimitiveTree), {
    decode: Getter.passthrough(),
    encode: Getter.transformOptional(Option.flatMap((r) => {
      const out: Record<string, typeof $PrimitiveTree["Type"]> = {}
      for (const [k, v] of Object.entries(r)) {
        if (!toJsonAnnotationsBlacklist.has(k) && isPrimitiveTree(v)) {
          out[k] = v
        }
      }
      return Rec.isEmptyRecord(out) ? Option.none() : Option.some(out)
    }))
  })
).annotate({ identifier: "Annotations" })

/**
 * Schema for the {@link Null} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Null = Schema.Struct({
  _tag: Schema.tag("Null"),
  annotations: Schema.optional($Annotations)
}).annotate({ identifier: "Null" })

/**
 * Schema for the {@link Undefined} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Undefined = Schema.Struct({
  _tag: Schema.tag("Undefined"),
  annotations: Schema.optional($Annotations)
}).annotate({ identifier: "Undefined" })

/**
 * Schema for the {@link Void} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Void = Schema.Struct({
  _tag: Schema.tag("Void"),
  annotations: Schema.optional($Annotations)
}).annotate({ identifier: "Void" })

/**
 * Schema for the {@link Never} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Never = Schema.Struct({
  _tag: Schema.tag("Never"),
  annotations: Schema.optional($Annotations)
}).annotate({ identifier: "Never" })

/**
 * Schema for the {@link Unknown} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Unknown = Schema.Struct({
  _tag: Schema.tag("Unknown"),
  annotations: Schema.optional($Annotations)
}).annotate({ identifier: "Unknown" })

/**
 * Schema for the {@link Any} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Any = Schema.Struct({
  _tag: Schema.tag("Any"),
  annotations: Schema.optional($Annotations)
}).annotate({ identifier: "Any" })

const $IsStringFinite = Schema.Struct({
  _tag: Schema.tag("isStringFinite"),
  regExp: Schema.RegExp
}).annotate({ identifier: "IsStringFinite" })

const $IsStringBigInt = Schema.Struct({
  _tag: Schema.tag("isStringBigInt"),
  regExp: Schema.RegExp
}).annotate({ identifier: "IsStringBigInt" })

const $IsStringSymbol = Schema.Struct({
  _tag: Schema.tag("isStringSymbol"),
  regExp: Schema.RegExp
}).annotate({ identifier: "IsStringSymbol" })

const $IsTrimmed = Schema.Struct({
  _tag: Schema.tag("isTrimmed"),
  regExp: Schema.RegExp
}).annotate({ identifier: "IsTrimmed" })

const $IsUUID = Schema.Struct({
  _tag: Schema.tag("isUUID"),
  regExp: Schema.RegExp,
  version: Schema.UndefinedOr(Schema.Literals([1, 2, 3, 4, 5, 6, 7, 8]))
}).annotate({ identifier: "IsUUID" })

const $IsULID = Schema.Struct({
  _tag: Schema.tag("isULID"),
  regExp: Schema.RegExp
}).annotate({ identifier: "IsULID" })

const $IsBase64 = Schema.Struct({
  _tag: Schema.tag("isBase64"),
  regExp: Schema.RegExp
}).annotate({ identifier: "IsBase64" })

const $IsBase64Url = Schema.Struct({
  _tag: Schema.tag("isBase64Url"),
  regExp: Schema.RegExp
}).annotate({ identifier: "IsBase64Url" })

const $IsStartsWith = Schema.Struct({
  _tag: Schema.tag("isStartsWith"),
  startsWith: Schema.String,
  regExp: Schema.RegExp
}).annotate({ identifier: "IsStartsWith" })

const $IsEndsWith = Schema.Struct({
  _tag: Schema.tag("isEndsWith"),
  endsWith: Schema.String,
  regExp: Schema.RegExp
}).annotate({ identifier: "IsEndsWith" })

const $IsIncludes = Schema.Struct({
  _tag: Schema.tag("isIncludes"),
  includes: Schema.String,
  regExp: Schema.RegExp
}).annotate({ identifier: "IsIncludes" })

const $IsUppercased = Schema.Struct({
  _tag: Schema.tag("isUppercased"),
  regExp: Schema.RegExp
}).annotate({ identifier: "IsUppercased" })

const $IsLowercased = Schema.Struct({
  _tag: Schema.tag("isLowercased"),
  regExp: Schema.RegExp
}).annotate({ identifier: "IsLowercased" })

const $IsCapitalized = Schema.Struct({
  _tag: Schema.tag("isCapitalized"),
  regExp: Schema.RegExp
}).annotate({ identifier: "IsCapitalized" })

const $IsUncapitalized = Schema.Struct({
  _tag: Schema.tag("isUncapitalized"),
  regExp: Schema.RegExp
}).annotate({ identifier: "IsUncapitalized" })

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const $IsMinLength = Schema.Struct({
  _tag: Schema.tag("isMinLength"),
  minLength: NonNegativeInt
}).annotate({ identifier: "IsMinLength" })

const $IsMaxLength = Schema.Struct({
  _tag: Schema.tag("isMaxLength"),
  maxLength: NonNegativeInt
}).annotate({ identifier: "IsMaxLength" })

const $IsLengthBetween = Schema.Struct({
  _tag: Schema.tag("isLengthBetween"),
  minimum: NonNegativeInt,
  maximum: NonNegativeInt
}).annotate({ identifier: "IsLengthBetween" })

const $IsPattern = Schema.Struct({
  _tag: Schema.tag("isPattern"),
  regExp: Schema.RegExp
}).annotate({ identifier: "IsPattern" })

/**
 * Schema for {@link StringMeta}.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $StringMeta = Schema.Union([
  $IsStringFinite,
  $IsStringBigInt,
  $IsStringSymbol,
  $IsTrimmed,
  $IsUUID,
  $IsULID,
  $IsBase64,
  $IsBase64Url,
  $IsStartsWith,
  $IsEndsWith,
  $IsIncludes,
  $IsUppercased,
  $IsLowercased,
  $IsCapitalized,
  $IsUncapitalized,
  $IsMinLength,
  $IsMaxLength,
  $IsPattern,
  $IsLengthBetween
]).annotate({ identifier: "StringMeta" })

function makeCheck<T>(meta: Schema.Codec<T>, identifier: string) {
  const Check$ref = Schema.suspend(() => Check)
  const Check: Schema.Codec<Check<T>> = Schema.Union([
    Schema.Struct({
      _tag: Schema.tag("Filter"),
      annotations: Schema.optional($Annotations),
      meta
    }).annotate({ identifier: `${identifier}Filter` }),
    Schema.Struct({
      _tag: Schema.tag("FilterGroup"),
      annotations: Schema.optional($Annotations),
      checks: Schema.NonEmptyArray(Check$ref)
    }).annotate({ identifier: `${identifier}FilterGroup` })
  ]).annotate({ identifier: `${identifier}Check` })
  return Check
}

/**
 * Schema for the {@link String} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $String = Schema.Struct({
  _tag: Schema.tag("String"),
  annotations: Schema.optional($Annotations),
  checks: Schema.Array(makeCheck($StringMeta, "String")),
  contentMediaType: Schema.optional(Schema.String),
  contentSchema: Schema.optional(Representation$ref)
}).annotate({ identifier: "String" })

const $IsInt = Schema.Struct({
  _tag: Schema.tag("isInt")
}).annotate({ identifier: "IsInt" })

const $IsMultipleOf = Schema.Struct({
  _tag: Schema.tag("isMultipleOf"),
  divisor: Schema.Finite
}).annotate({ identifier: "IsMultipleOf" })

const $IsFinite = Schema.Struct({
  _tag: Schema.tag("isFinite")
}).annotate({ identifier: "IsFinite" })

const $IsGreaterThan = Schema.Struct({
  _tag: Schema.tag("isGreaterThan"),
  exclusiveMinimum: Schema.Finite
}).annotate({ identifier: "IsGreaterThan" })

const $IsGreaterThanOrEqualTo = Schema.Struct({
  _tag: Schema.tag("isGreaterThanOrEqualTo"),
  minimum: Schema.Finite
}).annotate({ identifier: "IsGreaterThanOrEqualTo" })

const $IsLessThan = Schema.Struct({
  _tag: Schema.tag("isLessThan"),
  exclusiveMaximum: Schema.Finite
}).annotate({ identifier: "IsLessThan" })

const $IsLessThanOrEqualTo = Schema.Struct({
  _tag: Schema.tag("isLessThanOrEqualTo"),
  maximum: Schema.Finite
}).annotate({ identifier: "IsLessThanOrEqualTo" })

const $IsBetween = Schema.Struct({
  _tag: Schema.tag("isBetween"),
  minimum: Schema.Finite,
  maximum: Schema.Finite,
  exclusiveMinimum: Schema.optional(Schema.Boolean),
  exclusiveMaximum: Schema.optional(Schema.Boolean)
}).annotate({ identifier: "IsBetween" })

/**
 * Schema for {@link NumberMeta}.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $NumberMeta = Schema.Union([
  $IsInt,
  $IsMultipleOf,
  $IsFinite,
  $IsGreaterThan,
  $IsGreaterThanOrEqualTo,
  $IsLessThan,
  $IsLessThanOrEqualTo,
  $IsBetween
]).annotate({ identifier: "NumberMeta" })

/**
 * Schema for the {@link Number} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Number = Schema.Struct({
  _tag: Schema.tag("Number"),
  annotations: Schema.optional($Annotations),
  checks: Schema.Array(makeCheck($NumberMeta, "Number"))
}).annotate({ identifier: "Number" })

/**
 * Schema for the {@link Boolean} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Boolean = Schema.Struct({
  _tag: Schema.tag("Boolean"),
  annotations: Schema.optional($Annotations)
}).annotate({ identifier: "Boolean" })

const $IsGreaterThanBigInt = Schema.Struct({
  _tag: Schema.tag("isGreaterThanBigInt"),
  exclusiveMinimum: Schema.BigInt
}).annotate({ identifier: "IsGreaterThanBigInt" })

const $IsGreaterThanOrEqualToBigInt = Schema.Struct({
  _tag: Schema.tag("isGreaterThanOrEqualToBigInt"),
  minimum: Schema.BigInt
}).annotate({ identifier: "IsGreaterThanOrEqualToBigInt" })

const $IsLessThanBigInt = Schema.Struct({
  _tag: Schema.tag("isLessThanBigInt"),
  exclusiveMaximum: Schema.BigInt
}).annotate({ identifier: "IsLessThanBigInt" })

const $IsLessThanOrEqualToBigInt = Schema.Struct({
  _tag: Schema.tag("isLessThanOrEqualToBigInt"),
  maximum: Schema.BigInt
}).annotate({ identifier: "IsLessThanOrEqualToBigInt" })

const $IsBetweenBigInt = Schema.Struct({
  _tag: Schema.tag("isBetweenBigInt"),
  minimum: Schema.BigInt,
  maximum: Schema.BigInt,
  exclusiveMinimum: Schema.optional(Schema.Boolean),
  exclusiveMaximum: Schema.optional(Schema.Boolean)
}).annotate({ identifier: "IsBetweenBigInt" })

const $BigIntMeta = Schema.Union([
  $IsGreaterThanBigInt,
  $IsGreaterThanOrEqualToBigInt,
  $IsLessThanBigInt,
  $IsLessThanOrEqualToBigInt,
  $IsBetweenBigInt
]).annotate({ identifier: "BigIntMeta" })

/**
 * Schema for the {@link BigInt} representation node.
 *
 * **When to use**
 *
 * Use to encode, decode, or validate serialized `BigInt` representation nodes,
 * not application `bigint` values.
 *
 * **Details**
 *
 * Accepts representation nodes with `_tag: "BigInt"`, optional annotations,
 * and bigint-specific validation metadata in `checks`.
 *
 * @see {@link BigIntMeta} for the metadata accepted by the `checks` array
 *
 * @category schemas
 * @since 4.0.0
 */
export const $BigInt = Schema.Struct({
  _tag: Schema.tag("BigInt"),
  annotations: Schema.optional($Annotations),
  checks: Schema.Array(makeCheck($BigIntMeta, "BigInt"))
}).annotate({ identifier: "BigInt" })

/**
 * Schema for the {@link Symbol} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Symbol = Schema.Struct({
  _tag: Schema.tag("Symbol"),
  annotations: Schema.optional($Annotations)
}).annotate({ identifier: "Symbol" })

/**
 * Schema for the literal value types allowed in a {@link Literal} node
 * (string, finite number, boolean, or bigint).
 *
 * @category schemas
 * @since 4.0.0
 */
export const $LiteralValue = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.BigInt
]).annotate({ identifier: "LiteralValue" })

/**
 * Schema for the {@link Literal} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Literal = Schema.Struct({
  _tag: Schema.tag("Literal"),
  annotations: Schema.optional($Annotations),
  literal: $LiteralValue
}).annotate({ identifier: "Literal" })

/**
 * Schema for the {@link UniqueSymbol} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $UniqueSymbol = Schema.Struct({
  _tag: Schema.tag("UniqueSymbol"),
  annotations: Schema.optional($Annotations),
  symbol: Schema.Symbol
}).annotate({ identifier: "UniqueSymbol" })

/**
 * Schema for the {@link ObjectKeyword} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $ObjectKeyword = Schema.Struct({
  _tag: Schema.tag("ObjectKeyword"),
  annotations: Schema.optional($Annotations)
}).annotate({ identifier: "ObjectKeyword" })

/**
 * Schema for the {@link Enum} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Enum = Schema.Struct({
  _tag: Schema.tag("Enum"),
  annotations: Schema.optional($Annotations),
  enums: Schema.Array(
    Schema.Tuple([
      Schema.String,
      Schema.Union([
        Schema.String,
        Schema.Number // NaN, Infinity, -Infinity are allowed enum values
      ])
    ])
  )
}).annotate({ identifier: "Enum" })

/**
 * Schema for the {@link TemplateLiteral} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $TemplateLiteral = Schema.Struct({
  _tag: Schema.tag("TemplateLiteral"),
  annotations: Schema.optional($Annotations),
  parts: Schema.Array(Representation$ref)
}).annotate({ identifier: "TemplateLiteral" })

/**
 * Schema for the {@link Element} type (positional tuple element).
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Element = Schema.Struct({
  isOptional: Schema.Boolean,
  type: Representation$ref,
  annotations: Schema.optional($Annotations)
}).annotate({ identifier: "Element" })

const $IsUnique = Schema.Struct({
  _tag: Schema.tag("isUnique")
}).annotate({ identifier: "IsUnique" })

const $ArraysMeta = Schema.Union([
  $IsMinLength,
  $IsMaxLength,
  $IsLengthBetween,
  $IsUnique
]).annotate({ identifier: "ArraysMeta" })

/**
 * Schema for the {@link Arrays} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Arrays = Schema.Struct({
  _tag: Schema.tag("Arrays"),
  annotations: Schema.optional($Annotations),
  elements: Schema.Array($Element),
  rest: Schema.Array(Representation$ref),
  checks: Schema.Array(makeCheck($ArraysMeta, "Arrays"))
}).annotate({ identifier: "Arrays" })

/**
 * Schema for the {@link PropertySignature} type.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $PropertySignature = Schema.Struct({
  annotations: Schema.optional($Annotations),
  name: Schema.PropertyKey,
  type: Representation$ref,
  isOptional: Schema.Boolean,
  isMutable: Schema.Boolean
}).annotate({ identifier: "PropertySignature" })

/**
 * Schema for the {@link IndexSignature} type.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $IndexSignature = Schema.Struct({
  parameter: Representation$ref,
  type: Representation$ref
}).annotate({ identifier: "IndexSignature" })

const $IsMinProperties = Schema.Struct({
  _tag: Schema.tag("isMinProperties"),
  minProperties: NonNegativeInt
}).annotate({ identifier: "IsMinProperties" })

const $IsMaxProperties = Schema.Struct({
  _tag: Schema.tag("isMaxProperties"),
  maxProperties: NonNegativeInt
}).annotate({ identifier: "IsMaxProperties" })

const $IsPropertiesLengthBetween = Schema.Struct({
  _tag: Schema.tag("isPropertiesLengthBetween"),
  minimum: NonNegativeInt,
  maximum: NonNegativeInt
}).annotate({ identifier: "IsPropertiesLengthBetween" })

const $IsPropertyNames = Schema.Struct({
  _tag: Schema.tag("isPropertyNames"),
  propertyNames: Representation$ref
}).annotate({ identifier: "IsPropertyNames" })

/**
 * Schema for {@link ObjectsMeta}.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $ObjectsMeta = Schema.Union([
  $IsMinProperties,
  $IsMaxProperties,
  $IsPropertiesLengthBetween,
  $IsPropertyNames
]).annotate({ identifier: "ObjectsMeta" })

/**
 * Schema for the {@link Objects} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Objects = Schema.Struct({
  _tag: Schema.tag("Objects"),
  annotations: Schema.optional($Annotations),
  propertySignatures: Schema.Array($PropertySignature),
  indexSignatures: Schema.Array($IndexSignature),
  checks: Schema.Array(makeCheck($ObjectsMeta, "Objects"))
}).annotate({ identifier: "Objects" })

/**
 * Schema for the {@link Union} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Union = Schema.Struct({
  _tag: Schema.tag("Union"),
  annotations: Schema.optional($Annotations),
  types: Schema.Array(Representation$ref),
  mode: Schema.Literals(["anyOf", "oneOf"])
}).annotate({ identifier: "Union" })

/**
 * Schema for the {@link Reference} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Reference = Schema.Struct({
  _tag: Schema.tag("Reference"),
  $ref: Schema.String
}).annotate({ identifier: "Reference" })

const $IsDateValid = Schema.Struct({
  _tag: Schema.tag("isDateValid")
}).annotate({ identifier: "IsDateValid" })

const $IsGreaterThanDate = Schema.Struct({
  _tag: Schema.tag("isGreaterThanDate"),
  exclusiveMinimum: Schema.Date
}).annotate({ identifier: "IsGreaterThanDate" })

const $IsGreaterThanOrEqualToDate = Schema.Struct({
  _tag: Schema.tag("isGreaterThanOrEqualToDate"),
  minimum: Schema.Date
}).annotate({ identifier: "IsGreaterThanOrEqualToDate" })

const $IsLessThanDate = Schema.Struct({
  _tag: Schema.tag("isLessThanDate"),
  exclusiveMaximum: Schema.Date
}).annotate({ identifier: "IsLessThanDate" })

const $IsLessThanOrEqualToDate = Schema.Struct({
  _tag: Schema.tag("isLessThanOrEqualToDate"),
  maximum: Schema.Date
}).annotate({ identifier: "IsLessThanOrEqualToDate" })

const $IsBetweenDate = Schema.Struct({
  _tag: Schema.tag("isBetweenDate"),
  minimum: Schema.Date,
  maximum: Schema.Date,
  exclusiveMinimum: Schema.optional(Schema.Boolean),
  exclusiveMaximum: Schema.optional(Schema.Boolean)
}).annotate({ identifier: "IsBetweenDate" })

/**
 * Schema for {@link DateMeta}.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $DateMeta = Schema.Union([
  $IsDateValid,
  $IsGreaterThanDate,
  $IsGreaterThanOrEqualToDate,
  $IsLessThanDate,
  $IsLessThanOrEqualToDate,
  $IsBetweenDate
]).annotate({ identifier: "DateMeta" })

const $IsMinSize = Schema.Struct({
  _tag: Schema.tag("isMinSize"),
  minSize: NonNegativeInt
}).annotate({ identifier: "IsMinSize" })

const $IsMaxSize = Schema.Struct({
  _tag: Schema.tag("isMaxSize"),
  maxSize: NonNegativeInt
}).annotate({ identifier: "IsMaxSize" })

const $IsSizeBetween = Schema.Struct({
  _tag: Schema.tag("isSizeBetween"),
  minimum: NonNegativeInt,
  maximum: NonNegativeInt
}).annotate({ identifier: "IsSizeBetween" })

/**
 * Schema for {@link SizeMeta}.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $SizeMeta = Schema.Union([
  $IsMinSize,
  $IsMaxSize,
  $IsSizeBetween
]).annotate({ identifier: "SizeMeta" })

/**
 * Schema for {@link DeclarationMeta}.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $DeclarationMeta = Schema.Union([
  $DateMeta,
  $SizeMeta
]).annotate({ identifier: "DeclarationMeta" })

/**
 * Schema for the {@link Declaration} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Declaration = Schema.Struct({
  _tag: Schema.tag("Declaration"),
  annotations: Schema.optional($Annotations),
  typeParameters: Schema.Array(Representation$ref),
  checks: Schema.Array(makeCheck($DeclarationMeta, "Declaration")),
  encodedSchema: Representation$ref
}).annotate({ identifier: "Declaration" })

/**
 * Schema for the {@link Suspend} representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Suspend = Schema.Struct({
  _tag: Schema.tag("Suspend"),
  annotations: Schema.optional($Annotations),
  checks: Schema.Tuple([]),
  thunk: Representation$ref
}).annotate({ identifier: "Suspend" })

/**
 * Type-level helper for the recursive {@link $Representation} codec.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface $Representation extends Schema.Codec<Representation> {}

/**
 * Schema for the full {@link Representation} union. It recursively validates
 * and encodes any representation node.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Representation: $Representation = Schema.Union([
  $Null,
  $Undefined,
  $Void,
  $Never,
  $Unknown,
  $Any,
  $String,
  $Number,
  $Boolean,
  $BigInt,
  $Symbol,
  $Literal,
  $UniqueSymbol,
  $ObjectKeyword,
  $Enum,
  $TemplateLiteral,
  $Arrays,
  $Objects,
  $Union,
  $Reference,
  $Declaration,
  $Suspend
]).annotate({ identifier: "Schema" })

/**
 * Schema for {@link Document}.
 *
 * **When to use**
 *
 * Use to validate or serialize a single schema representation document with
 * `Schema.decodeUnknownSync` or `Schema.encodeSync`.
 *
 * **Gotchas**
 *
 * This codec validates document structure but does not resolve `$ref` keys
 * against `references`.
 *
 * @see {@link DocumentFromJson} for the JSON-string codec wrapper
 * @see {@link $MultiDocument} for validating documents with multiple root representations
 *
 * @category schemas
 * @since 4.0.0
 */
export const $Document = Schema.Struct({
  representation: $Representation,
  references: Schema.Record(Schema.String, $Representation)
}).annotate({ identifier: "Document" })

/**
 * Schema for {@link MultiDocument}.
 *
 * @category schemas
 * @since 4.0.0
 */
export const $MultiDocument = Schema.Struct({
  representations: Schema.NonEmptyArray($Representation),
  references: Schema.Record(Schema.String, $Representation)
}).annotate({ identifier: "MultiDocument" })

// -----------------------------------------------------------------------------
// APIs
// -----------------------------------------------------------------------------

/**
 * Converts a Schema AST into a {@link Document}.
 *
 * **When to use**
 *
 * Use when you have a single schema and need its representation.
 *
 * **Details**
 *
 * Shared/recursive sub-schemas are extracted into the `references` map.
 *
 * **Example** (Converting a Schema to a Document)
 *
 * ```ts
 * import { Schema, SchemaRepresentation } from "effect"
 *
 * const Person = Schema.Struct({
 *   name: Schema.String,
 *   age: Schema.Number
 * })
 *
 * const doc = SchemaRepresentation.fromAST(Person.ast)
 * console.log(doc.representation._tag)
 * // "Objects"
 * ```
 *
 * @see {@link Document}
 * @see {@link fromASTs}
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromAST: (ast: AST.AST) => Document = InternalRepresentation.fromAST

/**
 * Converts one or more Schema ASTs into a {@link MultiDocument}.
 *
 * **When to use**
 *
 * Use when you have multiple schemas that may share references.
 *
 * **Details**
 *
 * All schemas share a single `references` map.
 *
 * @see {@link MultiDocument}
 * @see {@link fromAST}
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromASTs: (asts: readonly [AST.AST, ...Array<AST.AST>]) => MultiDocument = InternalRepresentation.fromASTs

/**
 * Schema that decodes a {@link Document} from JSON and encodes it back.
 *
 * **When to use**
 *
 * Use with `Schema.decodeUnknownSync` or `Schema.encodeSync` to serialize
 * and deserialize documents.
 *
 * **Example** (Round-tripping a Document through JSON)
 *
 * ```ts
 * import { Schema, SchemaRepresentation } from "effect"
 *
 * const doc = SchemaRepresentation.fromAST(Schema.String.ast)
 * const json = Schema.encodeSync(SchemaRepresentation.DocumentFromJson)(doc)
 * const back = Schema.decodeUnknownSync(SchemaRepresentation.DocumentFromJson)(json)
 * ```
 *
 * @see {@link $Document}
 * @see {@link MultiDocumentFromJson}
 *
 * @category schemas
 * @since 4.0.0
 */
export const DocumentFromJson: Schema.Codec<Document, Schema.Json> = Schema.toCodecJson($Document)

/**
 * Schema for `MultiDocument` values encoded as JSON.
 *
 * @see {@link $MultiDocument}
 * @see {@link DocumentFromJson}
 *
 * @category schemas
 * @since 4.0.0
 */
export const MultiDocumentFromJson: Schema.Codec<MultiDocument, Schema.Json> = Schema.toCodecJson($MultiDocument)

/**
 * Wraps a single {@link Document} as a {@link MultiDocument} with one
 * representation.
 *
 * **When to use**
 *
 * Use when an API expects a `MultiDocument` but you only have a single
 * `Document`.
 *
 * @see {@link Document}
 * @see {@link MultiDocument}
 *
 * @category transforming
 * @since 4.0.0
 */
export function toMultiDocument(document: Document): MultiDocument {
  return {
    representations: [document.representation],
    references: document.references
  }
}

/**
 * A callback that handles {@link Declaration} nodes during reconstruction
 * ({@link toSchema}) or code generation ({@link toCodeDocument}).
 *
 * **Details**
 *
 * Return a value to handle the declaration. Return `undefined` to fall back to
 * default behavior, which uses `encodedSchema` for `toSchema` or the
 * `generation` annotation for `toCodeDocument`. `recur` processes child
 * representations recursively.
 *
 * @see {@link toSchema}
 * @see {@link toSchemaDefaultReviver}
 * @see {@link toCodeDocument}
 *
 * @category models
 * @since 4.0.0
 */
export type Reviver<T> = (declaration: Declaration, recur: (representation: Representation) => T) => T | undefined

/**
 * Default {@link Reviver} for {@link toSchema} that handles built-in Effect
 * types, including Option, Result, Redacted, Cause, Exit, ReadonlyMap, HashMap,
 * ReadonlySet, Date, Duration, URL, and RegExp.
 *
 * **When to use**
 *
 * Use when passing this as `options.reviver` to {@link toSchema} to reconstruct
 * schemas that use these types.
 *
 * **Details**
 *
 * The reviver returns `undefined` for unrecognized declarations, causing
 * fallback to `encodedSchema`.
 *
 * @see {@link toSchema}
 * @see {@link Reviver}
 *
 * @category transforming
 * @since 4.0.0
 */
export const toSchemaDefaultReviver: Reviver<Schema.Top> = (s, recur) => {
  const typeConstructor = s.annotations?.typeConstructor
  if (Predicate.isObject(typeConstructor) && typeof typeConstructor._tag === "string") {
    const typeParameters = s.typeParameters.map(recur)
    switch (typeConstructor._tag) {
      // built-in types
      case "Date":
        return Schema.Date
      case "Error":
        return Schema.Error
      case "ErrorWithStack":
        return Schema.ErrorWithStack
      case "File":
        return Schema.File
      case "FormData":
        return Schema.FormData
      case "ReadonlyMap":
        return Schema.ReadonlyMap(typeParameters[0], typeParameters[1])
      case "ReadonlySet":
        return Schema.ReadonlySet(typeParameters[0])
      case "RegExp":
        return Schema.RegExp
      case "Uint8Array":
        return Schema.Uint8Array
      case "URL":
        return Schema.URL
      case "URLSearchParams":
        return Schema.URLSearchParams
      // effect types
      case "effect/Option":
        return Schema.Option(typeParameters[0])
      case "effect/Result":
        return Schema.Result(typeParameters[0], typeParameters[1])
      case "effect/Redacted":
        return Schema.Redacted(typeParameters[0])
      case "effect/DateTime.TimeZone":
        return Schema.TimeZone
      case "effect/DateTime.TimeZone.Named":
        return Schema.TimeZoneNamed
      case "effect/DateTime.TimeZone.Offset":
        return Schema.TimeZoneOffset
      case "effect/DateTime.Utc":
        return Schema.DateTimeUtc
      case "effect/DateTime.Zoned":
        return Schema.DateTimeZoned
      case "effect/BigDecimal":
        return Schema.BigDecimal
      case "effect/Chunk":
        return Schema.Chunk(typeParameters[0])
      case "effect/Cause":
        return Schema.Cause(typeParameters[0], typeParameters[1])
      case "effect/Cause/Failure":
        return Schema.CauseReason(typeParameters[0], typeParameters[1])
      case "effect/Duration":
        return Schema.Duration
      case "effect/Exit":
        return Schema.Exit(typeParameters[0], typeParameters[1], typeParameters[2])
      case "effect/Json":
        return Schema.Json
      case "effect/MutableJson":
        return Schema.MutableJson
      case "effect/HashMap":
        return Schema.HashMap(typeParameters[0], typeParameters[1])
      case "effect/HashSet":
        return Schema.HashSet(typeParameters[0])
    }
  }
}

/**
 * Creates a runtime Schema from a {@link Document}.
 *
 * **When to use**
 *
 * Use when you have a serialized or computed representation and need a
 * working Schema for decoding/encoding.
 *
 * **Details**
 *
 * Pass `options.reviver`, such as {@link toSchemaDefaultReviver}, to handle
 * {@link Declaration} nodes for types like `Date` and `Option`. Without a
 * reviver, declarations fall back to their `encodedSchema`. Circular references
 * are handled via lazy `Schema.suspend`.
 *
 * **Gotchas**
 *
 * This throws if a `$ref` is not found in `document.references`.
 *
 * **Example** (Reconstructing a Schema)
 *
 * ```ts
 * import { Schema, SchemaRepresentation } from "effect"
 *
 * const doc = SchemaRepresentation.fromAST(
 *   Schema.Struct({ name: Schema.String }).ast
 * )
 *
 * const schema = SchemaRepresentation.toSchema(doc)
 * console.log(JSON.stringify(Schema.toJsonSchemaDocument(schema), null, 2))
 * ```
 *
 * @see {@link Document}
 * @see {@link Reviver}
 * @see {@link toSchemaDefaultReviver}
 *
 * @category Runtime Generation
 * @since 4.0.0
 */
export function toSchema<S extends Schema.Top = Schema.Top>(document: Document, options?: {
  readonly reviver?: Reviver<Schema.Top> | undefined
}): S {
  type Slot = {
    // 0 = not started, 1 = building, 2 = done
    state: 0 | 1 | 2
    value: Schema.Top | undefined
    ref: Schema.Top
  }

  const slots = new Map<string, Slot>()

  return recur(document.representation) as S

  function recur(r: Representation): Schema.Top {
    let out = on(r)
    if ("annotations" in r && r.annotations) out = out.annotate(r.annotations)
    out = toSchemaChecks(out, r)
    return out
  }

  function getSlot(identifier: string): Slot {
    const existing = slots.get(identifier)
    if (existing) return existing

    // Create the slot *before* resolving, so self-references can see it.
    const slot: Slot = {
      state: 0,
      value: undefined,
      ref: Schema.suspend(() => {
        if (slot.value === undefined) {
          return Schema.Unknown
        }
        return slot.value
      })
    }
    slots.set(identifier, slot)
    return slot
  }

  function resolveReference($ref: string): Schema.Top {
    const definition = document.references[$ref]
    if (definition === undefined) {
      throw new Error(`Reference ${$ref} not found`)
    }

    const slot = getSlot($ref)

    if (slot.state === 2) {
      // Already built: return the built schema directly
      return slot.value!
    }

    if (slot.state === 1) {
      // Circular: we're currently building this identifier.
      return slot.ref
    }

    // First time: build it.
    slot.state = 1
    try {
      slot.value = recur(definition)
      slot.state = 2
      return slot.value
    } catch (e) {
      // Leave the slot in a safe state so future thunks don't silently succeed.
      slot.state = 0
      slot.value = undefined
      throw e
    }
  }

  function on(r: Representation): Schema.Top {
    switch (r._tag) {
      case "Declaration":
        return options?.reviver?.(r, recur) ?? recur(r.encodedSchema)
      case "Reference":
        return resolveReference(r.$ref)
      case "Suspend":
        return recur(r.thunk)
      case "Null":
        return Schema.Null
      case "Undefined":
        return Schema.Undefined
      case "Void":
        return Schema.Void
      case "Never":
        return Schema.Never
      case "Unknown":
        return Schema.Unknown
      case "Any":
        return Schema.Any
      case "String": {
        const contentMediaType = r.contentMediaType
        const contentSchema = r.contentSchema
        if (contentMediaType === "application/json" && contentSchema !== undefined) {
          return Schema.fromJsonString(recur(contentSchema))
        }
        return Schema.String
      }
      case "Number":
        return Schema.Number
      case "Boolean":
        return Schema.Boolean
      case "BigInt":
        return Schema.BigInt
      case "Symbol":
        return Schema.Symbol
      case "Literal":
        return Schema.Literal(r.literal)
      case "UniqueSymbol":
        return Schema.UniqueSymbol(r.symbol)
      case "ObjectKeyword":
        return Schema.ObjectKeyword
      case "Enum":
        return Schema.Enum(Object.fromEntries(r.enums))
      case "TemplateLiteral": {
        const parts = r.parts.map(recur) as Schema.TemplateLiteral.Parts
        return Schema.TemplateLiteral(parts)
      }
      case "Arrays": {
        const elements = r.elements.map((e) => {
          const s = recur(e.type)
          return e.isOptional ? Schema.optionalKey(s) : s
        })
        const rest = r.rest.map(recur)
        if (Arr.isArrayNonEmpty(rest)) {
          if (r.elements.length === 0 && r.rest.length === 1) {
            return Schema.Array(rest[0])
          }
          return Schema.TupleWithRest(Schema.Tuple(elements), rest)
        }
        return Schema.Tuple(elements)
      }
      case "Objects": {
        const fields: Record<PropertyKey, Schema.Top> = {}

        for (const ps of r.propertySignatures) {
          const s = recur(ps.type)
          const withOptional = ps.isOptional ? Schema.optionalKey(s) : s
          fields[ps.name] = ps.isMutable ? Schema.mutableKey(withOptional) : withOptional
        }

        const indexSignatures = r.indexSignatures.map((is) =>
          Schema.Record(recur(is.parameter) as Schema.Record.Key, recur(is.type))
        )

        if (Arr.isArrayNonEmpty(indexSignatures)) {
          if (r.propertySignatures.length === 0 && indexSignatures.length === 1) {
            return indexSignatures[0]
          }
          return Schema.StructWithRest(Schema.Struct(fields), indexSignatures)
        }

        return Schema.Struct(fields)
      }
      case "Union": {
        if (r.types.length === 0) return Schema.Never
        if (r.types.every((t) => t._tag === "Literal")) {
          if (r.types.length === 1) {
            return Schema.Literal(r.types[0].literal)
          }
          return Schema.Literals(r.types.map((t) => t.literal))
        }
        return Schema.Union(r.types.map(recur), { mode: r.mode })
      }
    }
  }

  function toSchemaChecks(top: Schema.Top, schema: Representation): Schema.Top {
    switch (schema._tag) {
      default:
        return top
      case "String":
      case "Number":
      case "BigInt":
      case "Arrays":
      case "Objects":
      case "Declaration": {
        const checks = schema.checks.map(toSchemaCheck)
        return Arr.isArrayNonEmpty(checks) ? top.check(...checks) : top
      }
    }
  }

  function toSchemaCheck(check: Check<Meta>): AST.Check<any> {
    switch (check._tag) {
      case "Filter":
        return toSchemaFilter(check)
      case "FilterGroup": {
        return Schema.makeFilterGroup(Arr.map(check.checks, toSchemaCheck), check.annotations)
      }
    }
  }

  function toSchemaFilter(filter: Filter<Meta>): AST.Check<any> {
    const a = filter.annotations
    switch (filter.meta._tag) {
      // String Meta
      case "isStringFinite":
        return Schema.isStringFinite(a)
      case "isStringBigInt":
        return Schema.isStringBigInt(a)
      case "isStringSymbol":
        return Schema.isStringSymbol(a)
      case "isMinLength":
        return Schema.isMinLength(filter.meta.minLength, a)
      case "isMaxLength":
        return Schema.isMaxLength(filter.meta.maxLength, a)
      case "isLengthBetween":
        return Schema.isLengthBetween(filter.meta.minimum, filter.meta.maximum, a)
      case "isPattern":
        return Schema.isPattern(filter.meta.regExp, a)
      case "isTrimmed":
        return Schema.isTrimmed(a)
      case "isUUID":
        return Schema.isUUID(filter.meta.version, a)
      case "isULID":
        return Schema.isULID(a)
      case "isBase64":
        return Schema.isBase64(a)
      case "isBase64Url":
        return Schema.isBase64Url(a)
      case "isStartsWith":
        return Schema.isStartsWith(filter.meta.startsWith, a)
      case "isEndsWith":
        return Schema.isEndsWith(filter.meta.endsWith, a)
      case "isIncludes":
        return Schema.isIncludes(filter.meta.includes, a)
      case "isUppercased":
        return Schema.isUppercased(a)
      case "isLowercased":
        return Schema.isLowercased(a)
      case "isCapitalized":
        return Schema.isCapitalized(a)
      case "isUncapitalized":
        return Schema.isUncapitalized(a)

      // Number Meta
      case "isFinite":
        return Schema.isFinite(a)
      case "isInt":
        return Schema.isInt(a)
      case "isMultipleOf":
        return Schema.isMultipleOf(filter.meta.divisor, a)
      case "isGreaterThan":
        return Schema.isGreaterThan(filter.meta.exclusiveMinimum, a)
      case "isGreaterThanOrEqualTo":
        return Schema.isGreaterThanOrEqualTo(filter.meta.minimum, a)
      case "isLessThan":
        return Schema.isLessThan(filter.meta.exclusiveMaximum, a)
      case "isLessThanOrEqualTo":
        return Schema.isLessThanOrEqualTo(filter.meta.maximum, a)
      case "isBetween":
        return Schema.isBetween(filter.meta, a)

      // BigInt Meta
      case "isGreaterThanBigInt":
        return Schema.isGreaterThanBigInt(filter.meta.exclusiveMinimum, a)
      case "isGreaterThanOrEqualToBigInt":
        return Schema.isGreaterThanOrEqualToBigInt(filter.meta.minimum, a)
      case "isLessThanBigInt":
        return Schema.isLessThanBigInt(filter.meta.exclusiveMaximum, a)
      case "isLessThanOrEqualToBigInt":
        return Schema.isLessThanOrEqualToBigInt(filter.meta.maximum, a)
      case "isBetweenBigInt":
        return Schema.isBetweenBigInt(filter.meta, a)

      // Object Meta
      case "isMinProperties":
        return Schema.isMinProperties(filter.meta.minProperties, a)
      case "isMaxProperties":
        return Schema.isMaxProperties(filter.meta.maxProperties, a)
      case "isPropertiesLengthBetween":
        return Schema.isPropertiesLengthBetween(filter.meta.minimum, filter.meta.maximum, a)
      case "isPropertyNames":
        return Schema.isPropertyNames(recur(filter.meta.propertyNames) as Schema.Record.Key, a)

      // Arrays Meta
      case "isUnique":
        return Schema.isUnique(a)

      // Date Meta
      case "isDateValid":
        return Schema.isDateValid(a)
      case "isGreaterThanDate":
        return Schema.isGreaterThanDate(filter.meta.exclusiveMinimum, a)
      case "isGreaterThanOrEqualToDate":
        return Schema.isGreaterThanOrEqualToDate(filter.meta.minimum, a)
      case "isLessThanDate":
        return Schema.isLessThanDate(filter.meta.exclusiveMaximum, a)
      case "isLessThanOrEqualToDate":
        return Schema.isLessThanOrEqualToDate(filter.meta.maximum, a)
      case "isBetweenDate":
        return Schema.isBetweenDate(filter.meta, a)

      // Size Meta
      case "isMinSize":
        return Schema.isMinSize(filter.meta.minSize, a)
      case "isMaxSize":
        return Schema.isMaxSize(filter.meta.maxSize, a)
      case "isSizeBetween":
        return Schema.isSizeBetween(filter.meta.minimum, filter.meta.maximum, a)
    }
  }
}

/**
 * Converts a {@link Document} to a Draft 2020-12 JSON Schema document.
 *
 * **When to use**
 *
 * Use to produce a standard JSON Schema from an Effect Schema
 * representation.
 *
 * **Example** (Generating JSON Schema)
 *
 * ```ts
 * import { Schema, SchemaRepresentation } from "effect"
 *
 * const doc = SchemaRepresentation.fromAST(Schema.String.ast)
 * const jsonSchema = SchemaRepresentation.toJsonSchemaDocument(doc)
 * console.log(jsonSchema.schema.type)
 * // "string"
 * ```
 *
 * @see {@link Document}
 * @see {@link toJsonSchemaMultiDocument}
 * @see {@link fromJsonSchemaDocument}
 *
 * @category transforming
 * @since 4.0.0
 */
export const toJsonSchemaDocument: (
  document: Document,
  options?: Schema.ToJsonSchemaOptions
) => JsonSchema.Document<"draft-2020-12"> = InternalRepresentation.toJsonSchemaDocument

/**
 * Converts a {@link MultiDocument} to a Draft 2020-12 JSON Schema
 * multi-document.
 *
 * **When to use**
 *
 * Use when you have multiple schemas sharing references.
 *
 * @see {@link MultiDocument}
 * @see {@link toJsonSchemaDocument}
 * @see {@link fromJsonSchemaMultiDocument}
 *
 * @category transforming
 * @since 4.0.0
 */
export const toJsonSchemaMultiDocument: (
  document: MultiDocument,
  options?: Schema.ToJsonSchemaOptions
) => JsonSchema.MultiDocument<"draft-2020-12"> = InternalRepresentation.toJsonSchemaMultiDocument

/**
 * A pair of TypeScript source strings for a schema: `runtime` is the
 * executable Schema expression, `Type` is the corresponding TypeScript type.
 *
 * @see {@link makeCode}
 * @see {@link CodeDocument}
 *
 * @category Code Generation
 * @since 4.0.0
 */
export type Code = {
  readonly runtime: string
  readonly Type: string
}

/**
 * Constructs a {@link Code} value from a runtime expression string and a
 * TypeScript type string.
 *
 * @see {@link Code}
 *
 * @category Code Generation
 * @since 4.0.0
 */
export function makeCode(runtime: string, Type: string): Code {
  return { runtime, Type }
}

/**
 * An auxiliary code artifact produced during code generation — a symbol
 * declaration, an enum declaration, or an import statement.
 *
 * @see {@link CodeDocument}
 * @see {@link toCodeDocument}
 *
 * @category Code Generation
 * @since 4.0.0
 */
export type Artifact =
  | {
    readonly _tag: "Symbol"
    readonly identifier: string
    readonly generation: Code
  }
  | {
    readonly _tag: "Enum"
    readonly identifier: string
    readonly generation: Code
  }
  | {
    readonly _tag: "Import"
    readonly importDeclaration: string
  }

/**
 * The output of {@link toCodeDocument}: generated TypeScript code for one or
 * more schemas plus their shared references and auxiliary artifacts.
 *
 * **Details**
 *
 * `codes` contains one {@link Code} per input representation.
 * `references.nonRecursives` contains topologically sorted non-recursive
 * definitions. `references.recursives` contains definitions involved in cycles.
 * `artifacts` contains symbols, enums, and import statements needed by the
 * code.
 *
 * @see {@link toCodeDocument}
 * @see {@link Code}
 * @see {@link Artifact}
 *
 * @category Code Generation
 * @since 4.0.0
 */
export type CodeDocument = {
  readonly codes: ReadonlyArray<Code>
  readonly references: {
    readonly nonRecursives: ReadonlyArray<{
      readonly $ref: string
      readonly code: Code
    }>
    readonly recursives: {
      readonly [$ref: string]: Code
    }
  }
  readonly artifacts: ReadonlyArray<Artifact>
}

/**
 * Generates TypeScript code strings from a {@link MultiDocument}.
 *
 * **When to use**
 *
 * Use to produce source code for Schema definitions, such as in codegen
 * tools.
 *
 * **Details**
 *
 * `options.reviver` can customize code generation for {@link Declaration}
 * nodes. Return `undefined` to fall back to the default logic, which uses
 * `generation` annotations or the encoded schema. References are
 * topologically sorted so non-recursive definitions are emitted before their
 * dependents. `$ref` keys are converted to sanitized JavaScript identifiers.
 *
 * **Example** (Generating TypeScript code)
 *
 * ```ts
 * import { Schema, SchemaRepresentation } from "effect"
 *
 * const Person = Schema.Struct({
 *   name: Schema.String,
 *   age: Schema.Int
 * })
 *
 * const multi = SchemaRepresentation.toMultiDocument(
 *   SchemaRepresentation.fromAST(Person.ast)
 * )
 * const codeDoc = SchemaRepresentation.toCodeDocument(multi)
 * console.log(codeDoc.codes[0].runtime)
 * // Schema.Struct({ ... })
 * ```
 *
 * @see {@link CodeDocument}
 * @see {@link MultiDocument}
 * @see {@link Reviver}
 *
 * @category Code Generation
 * @since 4.0.0
 */
export function toCodeDocument(multiDocument: MultiDocument, options?: {
  /**
   * The reviver can return `undefined` to indicate that the generation should be generated by the default logic
   */
  readonly reviver?: Reviver<Code> | undefined
}): CodeDocument {
  const artifacts: Array<Artifact> = []

  const ts = topologicalSort(multiDocument.references)

  // Phase 1: Build sanitization map with collision handling
  const sanitizedReferenceMap = new Map<string, string>()
  const uniqueSanitizedReferences = new Set<string>()
  const referenceCount = new Map<string, number>()

  // Process all references first to build the map
  const allRefs = [
    ...ts.nonRecursives.map(({ $ref }) => $ref),
    ...Object.keys(ts.recursives)
  ]

  for (const ref of allRefs) {
    ensureUniqueSanitized(ref)
  }

  // Phase 2: Use the map when processing references
  const nonRecursives = ts.nonRecursives.map(({ $ref, representation }) => ({
    $ref: sanitizedReferenceMap.get($ref)!,
    code: recur(representation)
  }))
  const recursives = Rec.mapEntries(ts.recursives, (representation, $ref) => [
    sanitizedReferenceMap.get($ref)!,
    recur(representation)
  ])

  const codes = multiDocument.representations.map(recur)

  return {
    codes,
    references: {
      nonRecursives: nonRecursives.filter(({ $ref }) => (referenceCount.get($ref) ?? 0) > 0),
      recursives: Rec.filter(recursives, (_, $ref) => (referenceCount.get($ref) ?? 0) > 0)
    },
    artifacts
  }

  function ensureUniqueSanitized(originalRef: string): string {
    // Check if already mapped (consistency)
    const sanitized = sanitizedReferenceMap.get(originalRef)
    if (sanitized !== undefined) {
      return sanitized
    }

    // Find unique sanitized name
    const seed = sanitizeJavaScriptIdentifier(originalRef)
    let candidate = seed
    let suffix = 0

    while (uniqueSanitizedReferences.has(candidate)) {
      candidate = `${seed}${++suffix}`
    }

    uniqueSanitizedReferences.add(candidate)
    sanitizedReferenceMap.set(originalRef, candidate)
    return candidate
  }

  function addSymbol(s: symbol): string {
    const identifier = ensureUniqueSanitized("_symbol")
    const key = globalThis.Symbol.keyFor(s)
    const description = s.description
    const generation = key === undefined
      ? makeCode(`Symbol(${description === undefined ? "" : format(description)})`, `typeof ${identifier}`)
      : makeCode(`Symbol.for(${format(key)})`, `typeof ${identifier}`)
    artifacts.push({ _tag: "Symbol", identifier, generation })
    return identifier
  }

  function addEnum(s: Enum): string {
    const identifier = ensureUniqueSanitized("_Enum")
    artifacts.push({
      _tag: "Enum",
      identifier,
      generation: makeCode(
        `enum ${identifier} { ${s.enums.map(([name, value]) => `${format(name)}: ${format(value)}`).join(", ")} }`,
        `typeof ${identifier}`
      )
    })
    return identifier
  }

  function addImport(importDeclaration: string) {
    if (!artifacts.some((a) => a._tag === "Import" && a.importDeclaration === importDeclaration)) {
      artifacts.push({ _tag: "Import", importDeclaration })
    }
  }

  function recur(s: Representation): Code {
    const g = on(s)
    switch (s._tag) {
      default:
        return makeCode(
          g.runtime + toRuntimeAnnotate(s.annotations) + toRuntimeBrand(s.annotations),
          g.Type + toTypeBrand(s.annotations)
        )
      case "Reference":
        return g
      case "Declaration":
      case "String":
      case "Number":
      case "BigInt":
      case "Arrays":
      case "Objects":
      case "Suspend":
        return makeCode(
          g.runtime + toRuntimeAnnotate(s.annotations) + toRuntimeBrand(s.annotations) + toRuntimeChecks(s.checks),
          g.Type + toTypeBrand(s.annotations) + toTypeChecks(s.checks)
        )
    }
  }

  function on(s: Representation): Code {
    switch (s._tag) {
      case "Declaration": {
        // if there is a reviver, use it to generate the generation
        if (options?.reviver !== undefined) {
          // the reviver can return `undefined` to indicate that the generation should be generated by the default logic
          const out = options.reviver(s, recur)
          if (out !== undefined) {
            return out
          }
        }
        // otherwise, use the generation from the annotations
        const generation = s.annotations?.generation
        if (
          Predicate.isObject(generation) && typeof generation.runtime === "string" &&
          typeof generation.Type === "string"
        ) {
          const typeParameters = s.typeParameters.map(recur)
          if (typeof generation.importDeclaration === "string") {
            addImport(generation.importDeclaration)
          }
          return makeCode(
            replacePlaceholders(generation.runtime, typeParameters.map((p) => p.runtime)),
            replacePlaceholders(generation.Type, typeParameters.map((p) => p.Type))
          )
        }
        // otherwise, use the generation from the encoded schema
        return recur(s.encodedSchema)
      }
      case "Reference": {
        const sanitized = ensureUniqueSanitized(s.$ref)
        referenceCount.set(sanitized, (referenceCount.get(sanitized) ?? 0) + 1)
        return makeCode(sanitized, sanitized)
      }
      case "Suspend": {
        const thunk = recur(s.thunk)
        return makeCode(
          `Schema.suspend((): Schema.Codec<${thunk.Type}> => ${thunk.runtime})`,
          thunk.Type
        )
      }
      case "Null":
        return makeCode(`Schema.Null`, "null")
      case "Undefined":
        return makeCode(`Schema.Undefined`, "undefined")
      case "Void":
        return makeCode(`Schema.Void`, "void")
      case "Never":
        return makeCode(`Schema.Never`, "never")
      case "Unknown":
        return makeCode(`Schema.Unknown`, "unknown")
      case "Any":
        return makeCode(`Schema.Any`, "any")
      case "Number":
        return makeCode(`Schema.Number`, "number")
      case "Boolean":
        return makeCode(`Schema.Boolean`, "boolean")
      case "BigInt":
        return makeCode(`Schema.BigInt`, "bigint")
      case "Symbol":
        return makeCode(`Schema.Symbol`, "symbol")
      case "String": {
        const contentMediaType = s.contentMediaType
        const contentSchema = s.contentSchema
        if (contentMediaType === "application/json" && contentSchema !== undefined) {
          return makeCode(`Schema.fromJsonString(${recur(contentSchema)})`, "string")
        } else {
          return makeCode(`Schema.String`, "string")
        }
      }
      case "Literal": {
        const literal = format(s.literal)
        return makeCode(`Schema.Literal(${literal})`, literal)
      }
      case "UniqueSymbol": {
        const identifier = addSymbol(s.symbol)
        return makeCode(`Schema.UniqueSymbol(${identifier})`, `typeof ${identifier}`)
      }
      case "ObjectKeyword":
        return makeCode(`Schema.ObjectKeyword`, "object")
      case "Enum": {
        const identifier = addEnum(s)
        return makeCode(`Schema.Enum(${identifier})`, `typeof ${identifier}`)
      }
      case "TemplateLiteral": {
        const parts = s.parts.map(recur)
        const type = toTypeParts(s.parts).map((p) => "`" + p + "`").join(" | ")
        return makeCode(`Schema.TemplateLiteral([${parts.map((p) => p.runtime).join(", ")}])`, type)
      }
      case "Arrays": {
        const elements = s.elements.map((e) => {
          return {
            isOptional: e.isOptional,
            type: recur(e.type),
            annotations: e.annotations
          }
        })

        const rest = s.rest.map(recur)

        if (Arr.isArrayNonEmpty(rest)) {
          const item = rest[0]
          if (elements.length === 0 && rest.length === 1) {
            return makeCode(
              `Schema.Array(${item.runtime})`,
              `ReadonlyArray<${item.Type}>`
            )
          }
          const post = rest.slice(1)
          return makeCode(
            `Schema.TupleWithRest(Schema.Tuple([${
              elements.map((e) =>
                toRuntimeIsOptional(e.isOptional, e.type.runtime) + toRuntimeAnnotateKey(e.annotations)
              ).join(", ")
            }]), [${rest.map((r) => r.runtime).join(", ")}])`,
            `readonly [${
              elements.map((e) => toTypeIsOptional(e.isOptional, e.type.Type)).join(", ")
            }, ...Array<${item.Type}>${post.length > 0 ? `, ${post.map((p) => p.Type).join(", ")}` : ""}]`
          )
        }
        return makeCode(
          `Schema.Tuple([${
            elements.map((e) => toRuntimeIsOptional(e.isOptional, e.type.runtime) + toRuntimeAnnotateKey(e.annotations))
              .join(", ")
          }])`,
          `readonly [${elements.map((e) => toTypeIsOptional(e.isOptional, e.type.Type)).join(", ")}]`
        )
      }
      case "Objects": {
        const pss = s.propertySignatures.map((p) => {
          const isSymbol = typeof p.name === "symbol"
          const name = isSymbol ? addSymbol(p.name) : formatPropertyKey(p.name)
          const nameType = toTypeIsOptional(
            p.isOptional,
            toTypeIsMutable(p.isMutable, isSymbol ? `[typeof ${name}]` : name)
          )
          const type = recur(p.type)
          return makeCode(
            `${isSymbol ? `[${name}]` : name}: ${
              toRuntimeIsOptional(p.isOptional, toRuntimeIsMutable(p.isMutable, type.runtime))
            }` +
              toRuntimeAnnotateKey(p.annotations),
            `${nameType}: ${type.Type}`
          )
        })

        const iss = s.indexSignatures.map((is) => {
          return {
            parameter: recur(is.parameter),
            type: recur(is.type)
          }
        })

        if (iss.length === 0) {
          // 1) Only properties -> Struct
          return makeCode(
            `Schema.Struct({ ${pss.map((p) => p.runtime).join(", ")} })`,
            `{ ${pss.map((p) => p.Type).join(", ")} }`
          )
        } else if (pss.length === 0 && iss.length === 1) {
          // 2) Only one index signature and no properties -> Record
          return makeCode(
            `Schema.Record(${iss[0].parameter.runtime}, ${iss[0].type.runtime})`,
            `{ readonly [x: ${iss[0].parameter.Type}]: ${iss[0].type.Type} }`
          )
        } else {
          // 3) Properties + index signatures -> StructWithRest
          return makeCode(
            `Schema.StructWithRest(Schema.Struct({ ${pss.map((p) => p.runtime).join(", ")} }), [${
              iss.map((is) => `Schema.Record(${is.parameter.runtime}, ${is.type.runtime})`).join(", ")
            }])`,
            `{ ${pss.map((p) => p.Type).join(", ")}, ${
              iss.map((is) => `readonly [x: ${is.parameter.Type}]: ${is.type.Type}`).join(", ")
            } }`
          )
        }
      }
      case "Union": {
        if (s.types.length === 0) {
          return makeCode("Schema.Never", "never")
        }
        if (s.types.every((t) => t._tag === "Literal")) {
          const literals = s.types.map((l) => format(l.literal))
          if (literals.length === 1) {
            return makeCode(`Schema.Literal(${literals[0]})`, literals[0])
          }
          return makeCode(`Schema.Literals([${literals.join(", ")}])`, literals.join(" | "))
        }
        const mode = s.mode === "anyOf" ? "" : `, { mode: "oneOf" }`
        const types = s.types.map((t) => recur(t))
        return makeCode(
          `Schema.Union([${types.map((t) => t.runtime).join(", ")}]${mode})`,
          types.map((t) => t.Type).join(" | ")
        )
      }
    }
  }

  function toTypeBrand(annotations: Schema.Annotations.Annotations | undefined): string {
    const brands = collectBrands(annotations)
    if (brands.length === 0) return ""
    addImport(`import type * as Brand from "effect/Brand"`)
    return brands.map((b) => ` & Brand.Brand<${format(b)}>`).join("")
  }

  function toTypeChecks(checks: ReadonlyArray<Check<Meta>>): string {
    return checks.map((c) => toTypeCheck(c)).join("")
  }

  function toTypeCheck(check: Check<Meta>): string {
    switch (check._tag) {
      case "Filter":
        return toTypeBrand(check.annotations)
      case "FilterGroup": {
        return toTypeChecks(check.checks)
      }
    }
  }

  function toRuntimeChecks(checks: ReadonlyArray<Check<Meta>>): string {
    return checks.map((c) => `.check(${toRuntimeCheck(c)})` + toRuntimeBrand(c.annotations)).join("")
  }

  function toRuntimeCheck(check: Check<Meta>): string {
    switch (check._tag) {
      case "Filter":
        return toRuntimeFilter(check)
      case "FilterGroup": {
        const a = toRuntimeAnnotations(check.annotations)
        const ca = a === "" ? "" : `, ${a}`
        return `Schema.makeFilterGroup([${check.checks.map((c) => toRuntimeCheck(c)).join(", ")}]${ca})`
      }
    }
  }

  function toRuntimeFilter(filter: Filter<Meta>): string {
    const a = toRuntimeAnnotations(filter.annotations)
    const ca = a === "" ? "" : `, ${a}`
    switch (filter.meta._tag) {
      case "isTrimmed":
      case "isULID":
      case "isBase64":
      case "isBase64Url":
      case "isUppercased":
      case "isLowercased":
      case "isCapitalized":
      case "isUncapitalized":
      case "isFinite":
      case "isInt":
      case "isUnique":
      case "isDateValid":
        return `Schema.${filter.meta._tag}(${ca})`

      case "isStringFinite":
      case "isStringBigInt":
      case "isStringSymbol":
      case "isPattern":
        return `Schema.${filter.meta._tag}(${toRuntimeRegExp(filter.meta.regExp)}${ca})`

      case "isMinLength":
        return `Schema.isMinLength(${filter.meta.minLength}${ca})`
      case "isMaxLength":
        return `Schema.isMaxLength(${filter.meta.maxLength}${ca})`
      case "isLengthBetween":
        return `Schema.isLengthBetween(${filter.meta.minimum}, ${filter.meta.maximum}${ca})`
      case "isUUID":
        return `Schema.isUUID(${filter.meta.version}${ca})`
      case "isStartsWith":
        return `Schema.isStartsWith(${format(filter.meta.startsWith)}${ca})`
      case "isEndsWith":
        return `Schema.isEndsWith(${format(filter.meta.endsWith)}${ca})`
      case "isIncludes":
        return `Schema.isIncludes(${format(filter.meta.includes)}${ca})`

      case "isGreaterThan":
      case "isGreaterThanBigInt":
      case "isGreaterThanDate":
        return `Schema.${filter.meta._tag}(${toRuntimeValue(filter.meta.exclusiveMinimum)}${ca})`
      case "isGreaterThanOrEqualTo":
      case "isGreaterThanOrEqualToBigInt":
      case "isGreaterThanOrEqualToDate":
        return `Schema.${filter.meta._tag}(${toRuntimeValue(filter.meta.minimum)}${ca})`
      case "isLessThan":
      case "isLessThanBigInt":
      case "isLessThanDate":
        return `Schema.${filter.meta._tag}(${toRuntimeValue(filter.meta.exclusiveMaximum)}${ca})`
      case "isLessThanOrEqualTo":
      case "isLessThanOrEqualToBigInt":
      case "isLessThanOrEqualToDate":
        return `Schema.${filter.meta._tag}(${toRuntimeValue(filter.meta.maximum)}${ca})`
      case "isBetween":
      case "isBetweenBigInt":
      case "isBetweenDate":
        return `Schema.${filter.meta._tag}({ minimum: ${toRuntimeValue(filter.meta.minimum)}, maximum: ${
          toRuntimeValue(filter.meta.maximum)
        }, exclusiveMinimum: ${toRuntimeValue(filter.meta.exclusiveMinimum)}, exclusiveMaximum: ${
          toRuntimeValue(filter.meta.exclusiveMaximum)
        }${ca})`

      case "isMultipleOf":
        return `Schema.isMultipleOf(${filter.meta.divisor}${ca})`

      case "isMinProperties":
        return `Schema.isMinProperties(${filter.meta.minProperties}${ca})`
      case "isMaxProperties":
        return `Schema.isMaxProperties(${filter.meta.maxProperties}${ca})`
      case "isPropertiesLengthBetween":
        return `Schema.isPropertiesLengthBetween(${filter.meta.minimum}, ${filter.meta.maximum}${ca})`
      case "isPropertyNames":
        return `Schema.isPropertyNames(${recur(filter.meta.propertyNames).runtime}${ca})`

      case "isMinSize":
        return `Schema.isMinSize(${filter.meta.minSize}${ca})`
      case "isMaxSize":
        return `Schema.isMaxSize(${filter.meta.maxSize}${ca})`
      case "isSizeBetween":
        return `Schema.isSizeBetween(${filter.meta.minimum}, ${filter.meta.maximum}${ca})`
    }
  }
}

const VALID_ASCII_UPPER_JAVASCRIPT_IDENTIFIER_REGEXP = /^[A-Z_$][A-Za-z0-9_$]*$/

/**
 * Converts an arbitrary string into a valid (ASCII) JavaScript identifier
 * starting with an uppercase letter, `$`, or `_`.
 *
 * - Replaces invalid identifier characters with `_`
 * - Uppercases a leading ASCII letter
 * - If the first character is a digit, prefixes `_`
 * - Empty input becomes `_`
 *
 * @internal
 */
export function sanitizeJavaScriptIdentifier(s: string): string {
  if (s.length === 0) return "_"
  if (VALID_ASCII_UPPER_JAVASCRIPT_IDENTIFIER_REGEXP.test(s)) return s

  const out: Array<string> = []
  let needsPrefix = false
  let i = 0

  for (const ch of s) {
    if (i === 0) {
      if (ch === "_" || ch === "$" || (ch >= "A" && ch <= "Z")) {
        out.push(ch)
      } else if (ch >= "a" && ch <= "z") {
        out.push(ch.toUpperCase())
      } else if (ch >= "0" && ch <= "9") {
        out.push(ch)
        needsPrefix = true
      } else {
        out.push("_")
      }
    } else {
      out.push(isAsciiIdPart(ch) ? ch : "_")
    }
    i++
  }

  return needsPrefix ? "_" + out.join("") : out.join("")
}

function isAsciiIdStart(ch: string): boolean {
  return (
    ch === "_" ||
    ch === "$" ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "a" && ch <= "z")
  )
}

function isAsciiIdPart(ch: string): boolean {
  return isAsciiIdStart(ch) || (ch >= "0" && ch <= "9")
}

function replacePlaceholders(template: string, items: ReadonlyArray<string>) {
  let i = 0
  return template.replace(/\?/g, () => items[i++])
}

function toTypeParts(parts: ReadonlyArray<Representation>): ReadonlyArray<string> {
  if (parts.length === 0) {
    return [""]
  }
  const [first, ...rest] = parts
  const restPatterns = toTypeParts(rest)
  return toTypePart(first).flatMap((f) => restPatterns.map((r) => f + r))
}

function toTypePart(r: Representation): ReadonlyArray<string> {
  switch (r._tag) {
    case "Literal":
      return [globalThis.String(r.literal)]
    case "String":
      return ["${string}"]
    case "Number":
      return ["${number}"]
    case "BigInt":
      return ["${bigint}"]
    case "TemplateLiteral":
      return toTypeParts(r.parts)
    case "Union":
      return r.types.flatMap(toTypePart)
    default:
      return []
  }
}

const toCodeAnnotationsBlacklist: Set<string> = new Set([
  ...toJsonAnnotationsBlacklist,
  "typeConstructor",
  "generation",
  "brands"
])

function toRuntimeAnnotations(annotations: Schema.Annotations.Annotations | undefined): string {
  if (!annotations) return ""
  const entries: Array<string> = []
  for (const [key, value] of Object.entries(annotations)) {
    if (toCodeAnnotationsBlacklist.has(key)) continue
    entries.push(`${formatPropertyKey(key)}: ${format(value)}`)
  }
  if (entries.length === 0) return ""
  return `{ ${entries.join(", ")} }`
}

function toRuntimeBrand(annotations: Schema.Annotations.Annotations | undefined): string {
  const brands = collectBrands(annotations)
  return brands.length > 0 ? `.pipe(${brands.map((b) => `Schema.brand(${format(b)})`).join(", ")})` : ""
}

function toRuntimeAnnotate(annotations: Schema.Annotations.Annotations | undefined): string {
  const s = toRuntimeAnnotations(annotations)
  return s === "" ? "" : `.annotate(${s})`
}

function toRuntimeAnnotateKey(annotations: Schema.Annotations.Annotations | undefined): string {
  const s = toRuntimeAnnotations(annotations)
  return s === "" ? "" : `.annotateKey(${s})`
}

function toRuntimeIsOptional(isOptional: boolean, runtime: string): string {
  return isOptional ? `Schema.optionalKey(${runtime})` : runtime
}

function toTypeIsOptional(isOptional: boolean, type: string): string {
  return isOptional ? `${type}?` : type
}

function toRuntimeIsMutable(isMutable: boolean, runtime: string): string {
  return isMutable ? `Schema.mutableKey(${runtime})` : runtime
}

function toTypeIsMutable(isMutable: boolean, type: string): string {
  return isMutable ? type : `readonly ${type}`
}

function toRuntimeValue(value: undefined | number | boolean | bigint | Date): string {
  if (value instanceof Date) {
    return `new Date(${value.getTime()})`
  }
  return format(value)
}

function toRuntimeRegExp(regExp: RegExp): string {
  const args = [format(regExp.source)]
  const flags = regExp.flags.trim()
  if (flags !== "") {
    args.push(format(flags))
  }
  return `new RegExp(${args.join(", ")})`
}

/**
 * Parses a Draft 2020-12 JSON Schema document into a {@link Document}.
 *
 * **When to use**
 *
 * Use to import external JSON Schemas into the Effect representation
 * system.
 *
 * **Details**
 *
 * `options.onEnter` is an optional hook called on each JSON Schema node before
 * processing, allowing pre-transformation.
 *
 * **Gotchas**
 *
 * This throws if a `$ref` cannot be resolved within the document's definitions.
 * Circular `$ref`s are detected and cause an error.
 *
 * @see {@link Document}
 * @see {@link toJsonSchemaDocument}
 * @see {@link fromJsonSchemaMultiDocument}
 *
 * @category constructors
 * @since 4.0.0
 */
export function fromJsonSchemaDocument(document: JsonSchema.Document<"draft-2020-12">, options?: {
  readonly onEnter?: ((js: JsonSchema.JsonSchema) => JsonSchema.JsonSchema) | undefined
}): Document {
  const { references, representations: schemas } = fromJsonSchemaMultiDocument({
    dialect: document.dialect,
    schemas: [document.schema],
    definitions: document.definitions
  }, options)
  return {
    representation: schemas[0],
    references
  }
}

/**
 * Parses a Draft 2020-12 JSON Schema multi-document into a
 * {@link MultiDocument}.
 *
 * **When to use**
 *
 * Use to import multiple JSON Schemas sharing definitions.
 *
 * **Details**
 *
 * `options.onEnter` is an optional hook called on each JSON Schema node before
 * processing.
 *
 * **Gotchas**
 *
 * This throws if a `$ref` cannot be resolved.
 *
 * @see {@link MultiDocument}
 * @see {@link toJsonSchemaMultiDocument}
 * @see {@link fromJsonSchemaDocument}
 *
 * @category constructors
 * @since 4.0.0
 */
export function fromJsonSchemaMultiDocument(document: JsonSchema.MultiDocument<"draft-2020-12">, options?: {
  readonly onEnter?: ((js: JsonSchema.JsonSchema) => JsonSchema.JsonSchema) | undefined
}): MultiDocument {
  let visited: Set<string>
  const references: Record<string, Representation> = {}

  type Slot = {
    // 0 = not started, 1 = building, 2 = done
    state: 0 | 1 | 2
    value: Exclude<Representation, { _tag: "Reference" }> | undefined
  }

  const slots = new Map<string, Slot>()

  function getSlot(identifier: string): Slot {
    const existing = slots.get(identifier)
    if (existing) return existing

    // Create the slot *before* resolving, so self-references can see it.
    const slot: Slot = {
      state: 0,
      value: undefined
    }
    slots.set(identifier, slot)
    return slot
  }

  function resolveReference($ref: string): Exclude<Representation, { _tag: "Reference" }> {
    const definition = document.definitions[$ref]
    if (definition === undefined) {
      throw new Error(`Reference ${$ref} not found`)
    }

    const slot = getSlot($ref)

    if (slot.state === 2) {
      // Already built: return the built schema directly
      return slot.value!
    }

    if (slot.state === 1) {
      // Circular: we're currently building this identifier.
      throw new Error(`Circular reference detected: ${$ref}`)
    }

    // First time: build it.
    slot.state = 1
    const value = recur(definition)

    slot.value = value._tag === "Reference" ? resolveReference(value.$ref) : value
    slot.state = 2
    return slot.value
  }

  Object.entries(document.definitions).forEach(([identifier, definition]) => {
    visited = new Set<string>([identifier])
    references[identifier] = recur(definition)
  })

  visited = new Set<string>()
  const representations = Arr.map(document.schemas, recur)
  return {
    representations,
    references
  }

  function recur(u: unknown): Representation {
    if (u === false) return never
    if (!Predicate.isObject(u)) return unknown

    let js: JsonSchema.JsonSchema = options?.onEnter?.(u) ?? u
    if (Array.isArray(js.type)) {
      if (js.type.every(isType)) {
        const { type, ...rest } = js
        js = {
          anyOf: type.map((type) => ({ type })),
          ...rest
        }
      } else {
        js = {}
      }
    }

    let out = on(js)

    const annotations = collectAnnotations(js)
    if (annotations !== undefined) {
      out = combine(out, { _tag: "Unknown", annotations })
    }

    if (Array.isArray(js.allOf)) {
      out = js.allOf.reduce((acc, curr) => combine(acc, recur(curr)), out)
    }
    if (Array.isArray(js.anyOf)) {
      out = combine({ _tag: "Union", types: js.anyOf.map((type) => recur(type)), mode: "anyOf" }, out)
    }
    if (Array.isArray(js.oneOf)) {
      out = combine({ _tag: "Union", types: js.oneOf.map((type) => recur(type)), mode: "oneOf" }, out)
    }

    return out
  }

  function on(js: JsonSchema.JsonSchema): Representation {
    if (typeof js.$ref === "string") {
      const $ref = js.$ref.slice(2).split("/").at(-1)
      if ($ref !== undefined) {
        const reference: Reference = { _tag: "Reference", $ref: unescapeToken($ref) }
        if (visited.has($ref)) {
          return { _tag: "Suspend", thunk: reference, checks: [] }
        } else {
          return reference
        }
      }
    } else if ("const" in js) {
      if (isLiteralValue(js.const)) {
        return { _tag: "Literal", literal: js.const }
      } else if (js.const === null) {
        return null_
      }
    } else if (Array.isArray(js.enum)) {
      const types: Array<Representation> = []
      for (const e of js.enum) {
        if (isLiteralValue(e)) {
          types.push({ _tag: "Literal", literal: e })
        } else if (e === null) {
          types.push(null_)
        } else {
          types.push(recur(e))
        }
      }
      if (types.length === 1) {
        return types[0]
      } else {
        return { _tag: "Union", types, mode: "anyOf" }
      }
    }

    const type = isType(js.type) ? js.type : getType(js)
    if (type !== undefined) {
      switch (type) {
        case "null":
          return null_
        case "string": {
          const checks = collectStringChecks(js)
          if (checks.length > 0) {
            return { ...string, checks }
          }
          return string
        }
        case "number":
          return {
            _tag: "Number",
            checks: [{ _tag: "Filter", meta: { _tag: "isFinite" } }, ...collectNumberChecks(js)]
          }
        case "integer":
          return {
            _tag: "Number",
            checks: [{ _tag: "Filter", meta: { _tag: "isInt" } }, ...collectNumberChecks(js)]
          }
        case "boolean":
          return boolean
        case "array": {
          const minItems = typeof js.minItems === "number" ? js.minItems : 0

          const elements: Array<Element> = (Array.isArray(js.prefixItems) ? js.prefixItems : []).map((e, i) => ({
            isOptional: i + 1 > minItems,
            type: recur(e)
          }))

          const rest: Array<Representation> = js.items !== undefined ?
            [recur(js.items)]
            : js.prefixItems !== undefined && typeof js.maxItems === "number"
            ? []
            : [unknown]

          return { _tag: "Arrays", elements, rest, checks: collectArraysChecks(js) }
        }
        case "object": {
          return {
            _tag: "Objects",
            propertySignatures: collectProperties(js),
            indexSignatures: collectIndexSignatures(js),
            checks: collectObjectsChecks(js)
          }
        }
      }
    }

    return { _tag: "Unknown" }
  }

  function collectObjectsChecks(js: JsonSchema.JsonSchema): Array<Check<ObjectsMeta>> {
    const checks: Array<Check<ObjectsMeta>> = []
    if (typeof js.minProperties === "number") {
      checks.push({ _tag: "Filter", meta: { _tag: "isMinProperties", minProperties: js.minProperties } })
    }
    if (typeof js.maxProperties === "number") {
      checks.push({ _tag: "Filter", meta: { _tag: "isMaxProperties", maxProperties: js.maxProperties } })
    }
    if (js.propertyNames !== undefined) {
      const propertyNames = recur(js.propertyNames)
      checks.push({ _tag: "Filter", meta: { _tag: "isPropertyNames", propertyNames } })
    }
    return checks
  }

  function combine(a: Representation, b: Representation): Representation {
    switch (a._tag) {
      default:
        return never
      case "Reference":
        return combine(resolveReference(a.$ref), b)
      case "Never":
        return a
      case "Unknown":
        switch (b._tag) {
          case "Reference":
            return combine(a, resolveReference(b.$ref))
          default:
            return { ...b, ...combineAnnotations(a.annotations, b.annotations) }
        }
      case "Null":
        switch (b._tag) {
          case "Unknown":
          case "Null":
            return { ...a, ...combineAnnotations(a.annotations, b.annotations) }
          case "Union":
            return combine(b, a)
          case "Reference":
            return combine(a, resolveReference(b.$ref))
          default:
            return never
        }
      case "String":
        switch (b._tag) {
          case "Unknown":
            return { ...a, ...combineAnnotations(a.annotations, b.annotations) }
          case "String": {
            const checks = combineChecks(a.checks, b.checks, b.annotations)
            return {
              _tag: "String",
              checks: checks ?? a.checks,
              ...combineAnnotations(a.annotations, checks ? undefined : b.annotations)
            }
          }
          case "Literal":
            return typeof b.literal === "string" ? { ...b, ...combineAnnotations(a.annotations, b.annotations) } : never
          case "Union":
            return combine(b, a)
          case "Reference":
            return combine(a, resolveReference(b.$ref))
          default:
            return never
        }
      case "Number":
        switch (b._tag) {
          case "Unknown":
            return { ...a, ...combineAnnotations(a.annotations, b.annotations) }
          case "Number": {
            const checks = combineNumberChecks(a.checks, b.checks, b.annotations)
            return {
              _tag: "Number",
              checks: checks ?? a.checks,
              ...combineAnnotations(a.annotations, checks ? undefined : b.annotations)
            }
          }
          case "Literal":
            return typeof b.literal === "number" ? { ...b, ...combineAnnotations(a.annotations, b.annotations) } : never
          case "Union":
            return combine(b, a)
          case "Reference":
            return combine(a, resolveReference(b.$ref))
          default:
            return never
        }
      case "Boolean":
        switch (b._tag) {
          case "Unknown":
            return { ...a, ...combineAnnotations(a.annotations, b.annotations) }
          case "Boolean":
            return { _tag: "Boolean", ...combineAnnotations(a.annotations, b.annotations) }
          case "Literal":
            return typeof b.literal === "boolean"
              ? { ...b, ...combineAnnotations(a.annotations, b.annotations) }
              : never
          case "Union":
            return combine(b, a)
          case "Reference":
            return combine(a, resolveReference(b.$ref))
          default:
            return never
        }
      case "Literal":
        switch (b._tag) {
          case "Unknown":
            return { ...a, ...combineAnnotations(a.annotations, b.annotations) }
          case "Literal":
            return a.literal === b.literal
              ? { ...a, ...combineAnnotations(a.annotations, b.annotations) }
              : never
          case "String":
            return typeof a.literal === "string" ? { ...a, ...combineAnnotations(a.annotations, b.annotations) } : never
          case "Number":
            return typeof a.literal === "number" ? { ...a, ...combineAnnotations(a.annotations, b.annotations) } : never
          case "Boolean":
            return typeof a.literal === "boolean"
              ? { ...a, ...combineAnnotations(a.annotations, b.annotations) }
              : never
          case "Union":
            return combine(b, a)
          case "Reference":
            return combine(a, resolveReference(b.$ref))
          default:
            return never
        }
      case "Arrays":
        switch (b._tag) {
          case "Unknown":
            return { ...a, ...combineAnnotations(a.annotations, b.annotations) }
          case "Arrays": {
            const checks = combineArraysChecks(a.checks, b.checks, b.annotations)
            return {
              _tag: "Arrays",
              elements: combineElements(a.elements, b.elements),
              rest: combineRest(a.rest, b.rest),
              checks: checks ?? a.checks,
              ...combineAnnotations(a.annotations, checks ? undefined : b.annotations)
            }
          }
          case "Union":
            return combine(b, a)
          case "Reference":
            return combine(a, resolveReference(b.$ref))
          default:
            return never
        }
      case "Objects":
        switch (b._tag) {
          case "Unknown":
            return { ...a, ...combineAnnotations(a.annotations, b.annotations) }
          case "Objects": {
            const checks = combineChecks(a.checks, b.checks, b.annotations)
            return {
              _tag: "Objects",
              propertySignatures: combinePropertySignatures(a.propertySignatures, b.propertySignatures),
              indexSignatures: combineIndexSignatures(a.indexSignatures, b.indexSignatures),
              checks: checks ?? a.checks,
              ...combineAnnotations(a.annotations, checks ? undefined : b.annotations)
            }
          }
          case "Union":
            return combine(b, a)
          case "Reference":
            return combine(a, resolveReference(b.$ref))
          default:
            return never
        }
      case "Union": {
        switch (b._tag) {
          case "Unknown":
            return { ...a, ...combineAnnotations(a.annotations, b.annotations) }
          default: {
            const types = a.types.map((s) => combine(s, b)).filter((s) => s !== never)
            if (types.length === 0) return never
            return {
              _tag: "Union",
              types,
              mode: a.mode,
              ...makeAnnotations(a.annotations)
            }
          }
        }
      }
    }
  }

  function collectProperties(js: JsonSchema.JsonSchema): Array<PropertySignature> {
    const properties: Record<string, unknown> = Predicate.isObject(js.properties) ? js.properties : {}
    const required = Array.isArray(js.required) ? js.required : []
    required.forEach((key) => {
      if (!Object.hasOwn(properties, key)) {
        properties[key] = {}
      }
    })
    return Object.entries(properties).map(([key, v]) => ({
      name: key,
      type: recur(v),
      isOptional: !required.includes(key),
      isMutable: false
    }))
  }

  function collectIndexSignatures(js: JsonSchema.JsonSchema): Array<IndexSignature> {
    const out: Array<IndexSignature> = []

    if (Predicate.isObject(js.patternProperties)) {
      for (const [pattern, value] of Object.entries(js.patternProperties)) {
        out.push({ parameter: recur({ pattern }), type: recur(value) })
      }
    }

    if (js.additionalProperties === undefined || js.additionalProperties === true) {
      out.push({ parameter: string, type: unknown })
    } else if (Predicate.isObject(js.additionalProperties)) {
      out.push({ parameter: string, type: recur(js.additionalProperties) })
    }

    return out
  }

  function combineElements(a: ReadonlyArray<Element>, b: ReadonlyArray<Element>): Array<Element> {
    const len = Math.max(a.length, b.length)
    let out: Array<Element> = []
    for (let i = 0; i < len; i++) {
      out.push({
        isOptional: a[i].isOptional && b[i].isOptional,
        type: combine(a[i].type, b[i].type)
      })
    }
    if (a.length > len) {
      out = [...out, ...a.slice(len)]
    } else if (b.length > len) {
      out = [...out, ...b.slice(len)]
    }
    return out
  }

  function combineRest(a: ReadonlyArray<Representation>, b: ReadonlyArray<Representation>): Array<Representation> {
    const len = Math.max(a.length, b.length)
    let out: Array<Representation> = []
    for (let i = 0; i < len; i++) {
      out.push(combine(a[i], b[i]))
    }
    if (a.length > len) {
      out = [...out, ...a.slice(len)]
    } else if (b.length > len) {
      out = [...out, ...b.slice(len)]
    }
    return out
  }

  function combinePropertySignatures(
    a: ReadonlyArray<PropertySignature>,
    b: ReadonlyArray<PropertySignature>
  ): Array<PropertySignature> {
    const propertySignatures: Array<PropertySignature> = []
    const thatPropertiesMap: Record<PropertyKey, PropertySignature> = {}
    for (const p of b) {
      thatPropertiesMap[p.name] = p
    }
    const keys = new Set<PropertyKey>()
    for (const p of a) {
      keys.add(p.name)
      const thatp = thatPropertiesMap[p.name]
      if (thatp) {
        propertySignatures.push(
          {
            name: p.name,
            type: combine(p.type, thatp.type),
            isOptional: p.isOptional && thatp.isOptional,
            isMutable: p.isMutable
          }
        )
      } else {
        propertySignatures.push(p)
      }
    }
    for (const p of b) {
      if (!keys.has(p.name)) propertySignatures.push(p)
    }
    return propertySignatures
  }

  function combineIndexSignatures(
    a: ReadonlyArray<IndexSignature>,
    b: ReadonlyArray<IndexSignature>
  ): Array<IndexSignature> {
    if (a.length === 0 || b.length === 0) return []
    const out: Array<IndexSignature> = [...a]
    for (const is of b) {
      if (is.parameter === string) {
        const i = a.findIndex((is) => is.parameter === string)
        if (i !== -1) {
          out[i] = { parameter: string, type: combine(a[i].type, is.type) }
        } else {
          out.push(is)
        }
      } else {
        out.push(is)
      }
    }
    return out
  }
}

function asChecks<M>(
  checks: ReadonlyArray<Check<M>>,
  annotations: Schema.Annotations.Annotations | undefined
): ReadonlyArray<Check<M>> | undefined {
  if (Arr.isReadonlyArrayNonEmpty(checks)) {
    if (annotations !== undefined) {
      if (checks.length === 1) {
        const check = checks[0]
        if (check.annotations === undefined) {
          return [{ ...check, annotations }]
        } else {
          return [{ _tag: "FilterGroup", checks, annotations }]
        }
      } else {
        return [{ _tag: "FilterGroup", checks, annotations }]
      }
    }
    return checks
  }
}

function combineChecks<M>(
  a: ReadonlyArray<Check<M>>,
  b: ReadonlyArray<Check<M>>,
  annotations: Schema.Annotations.Annotations | undefined
): Array<Check<M>> | undefined {
  const checks = asChecks(b, annotations)
  if (checks) {
    return [...a, ...checks]
  }
}

function combineNumberChecks(
  a: ReadonlyArray<Check<NumberMeta>>,
  b: ReadonlyArray<Check<NumberMeta>>,
  annotations: Schema.Annotations.Annotations | undefined
): Array<Check<NumberMeta>> | undefined {
  if (a.some((c) => c._tag === "Filter" && c.meta._tag === "isFinite")) {
    b = b.filter((c) => c._tag !== "Filter" || c.meta._tag !== "isFinite")
  }
  if (a.some((c) => c._tag === "Filter" && c.meta._tag === "isInt")) {
    b = b.filter((c) => c._tag !== "Filter" || c.meta._tag !== "isInt")
  }
  return combineChecks(a, b, annotations)
}

function combineArraysChecks(
  a: ReadonlyArray<Check<ArraysMeta>>,
  b: ReadonlyArray<Check<ArraysMeta>>,
  annotations: Schema.Annotations.Annotations | undefined
): Array<Check<ArraysMeta>> | undefined {
  if (a.some((c) => c._tag === "Filter" && c.meta._tag === "isUnique")) {
    b = b.filter((c) => c._tag !== "Filter" || c.meta._tag !== "isUnique")
  }
  return combineChecks(a, b, annotations)
}

function makeAnnotations(
  annotations: Schema.Annotations.Annotations | undefined
): { annotations: Schema.Annotations.Annotations } | undefined {
  return annotations ? { annotations } : undefined
}

function combineAnnotations(
  a: Schema.Annotations.Annotations | undefined,
  b: Schema.Annotations.Annotations | undefined
): { annotations: Schema.Annotations.Annotations } | undefined {
  if (a === undefined) return makeAnnotations(b)
  if (b === undefined) return makeAnnotations(a)
  return { annotations: { ...a, ...b } } // TODO: better merge
}

function collectStringChecks(js: JsonSchema.JsonSchema): Array<Check<StringMeta>> {
  const checks: Array<Check<StringMeta>> = []
  if (typeof js.minLength === "number") {
    checks.push({ _tag: "Filter", meta: { _tag: "isMinLength", minLength: js.minLength } })
  }
  if (typeof js.maxLength === "number") {
    checks.push({ _tag: "Filter", meta: { _tag: "isMaxLength", maxLength: js.maxLength } })
  }
  if (typeof js.pattern === "string") {
    checks.push({ _tag: "Filter", meta: { _tag: "isPattern", regExp: new RegExp(js.pattern) } })
  }
  return checks
}

function collectNumberChecks(js: JsonSchema.JsonSchema): Array<Check<NumberMeta>> {
  const checks: Array<Check<NumberMeta>> = []
  if (typeof js.minimum === "number") {
    checks.push({ _tag: "Filter", meta: { _tag: "isGreaterThanOrEqualTo", minimum: js.minimum } })
  }
  if (typeof js.maximum === "number") {
    checks.push({ _tag: "Filter", meta: { _tag: "isLessThanOrEqualTo", maximum: js.maximum } })
  }
  if (typeof js.exclusiveMinimum === "number") {
    checks.push({ _tag: "Filter", meta: { _tag: "isGreaterThan", exclusiveMinimum: js.exclusiveMinimum } })
  }
  if (typeof js.exclusiveMaximum === "number") {
    checks.push({ _tag: "Filter", meta: { _tag: "isLessThan", exclusiveMaximum: js.exclusiveMaximum } })
  }
  if (typeof js.multipleOf === "number") {
    checks.push({ _tag: "Filter", meta: { _tag: "isMultipleOf", divisor: js.multipleOf } })
  }
  return checks
}

function collectArraysChecks(js: JsonSchema.JsonSchema): Array<Check<ArraysMeta>> {
  const checks: Array<Check<ArraysMeta>> = []
  if (js.prefixItems === undefined) {
    if (typeof js.minItems === "number") {
      checks.push({ _tag: "Filter", meta: { _tag: "isMinLength", minLength: js.minItems } })
    }
    if (typeof js.maxItems === "number") {
      checks.push({ _tag: "Filter", meta: { _tag: "isMaxLength", maxLength: js.maxItems } })
    }
  }
  if (typeof js.uniqueItems === "boolean") {
    checks.push({ _tag: "Filter", meta: { _tag: "isUnique" } })
  }
  return checks
}

const unknown: Unknown = { _tag: "Unknown" }
const never: Never = { _tag: "Never" }
const null_: Null = { _tag: "Null" }
const string: String = { _tag: "String", checks: [] }
const boolean: Boolean = { _tag: "Boolean" }

function collectAnnotations(
  schema: JsonSchema.JsonSchema
): Schema.Annotations.Annotations | undefined {
  const as: Record<string, unknown> = {}

  if (typeof schema.title === "string") as.title = schema.title
  if (typeof schema.description === "string") as.description = schema.description
  if (schema.default !== undefined) as.default = schema.default
  if (Array.isArray(schema.examples)) as.examples = schema.examples
  if (typeof schema.readOnly === "boolean") as.readOnly = schema.readOnly
  if (typeof schema.writeOnly === "boolean") as.writeOnly = schema.writeOnly
  if (typeof schema.format === "string") as.format = schema.format
  if (typeof schema.contentEncoding === "string") as.contentEncoding = schema.contentEncoding
  if (typeof schema.contentMediaType === "string") as.contentMediaType = schema.contentMediaType

  return Rec.isEmptyRecord(as) ? undefined : as
}

function isLiteralValue(value: unknown): value is AST.LiteralValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

const stringKeys = ["minLength", "maxLength", "pattern", "format", "contentMediaType", "contentSchema"]
const numberKeys = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]
const objectKeys = [
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "maxProperties"
]
const arrayKeys = ["items", "prefixItems", "additionalItems", "minItems", "maxItems", "uniqueItems"]

function getType(js: JsonSchema.JsonSchema): JsonSchema.Type | undefined {
  if (stringKeys.some((key) => js[key] !== undefined)) {
    return "string"
  }
  if (numberKeys.some((key) => js[key] !== undefined)) {
    return "number"
  }
  if (objectKeys.some((key) => js[key] !== undefined)) {
    return "object"
  }
  if (arrayKeys.some((key) => js[key] !== undefined)) {
    return "array"
  }
}

const types = ["null", "string", "number", "integer", "boolean", "object", "array"]

function isType(type: unknown): type is JsonSchema.Type {
  return typeof type === "string" && types.includes(type)
}

/** @internal */
export type TopologicalSort = {
  /**
   * The definitions that are not recursive.
   * The definitions that depends on other definitions are placed after the definitions they depend on
   */
  readonly nonRecursives: ReadonlyArray<{
    readonly $ref: string
    readonly representation: Representation
  }>
  /**
   * The recursive definitions (with no particular order).
   */
  readonly recursives: {
    readonly [$ref: string]: Representation
  }
}

/** @internal */
export function topologicalSort(references: References): TopologicalSort {
  const identifiers = Object.keys(references)
  const identifierSet = new Set(identifiers)

  const collectRefs = (root: Representation): Set<string> => {
    const refs = new Set<string>()
    const visited = new WeakSet<object>()
    const stack: Array<Representation> = [root]

    while (stack.length > 0) {
      const r = stack.pop()!
      if (visited.has(r)) continue
      visited.add(r)

      if (r._tag === "Reference") {
        if (identifierSet.has(r.$ref)) {
          refs.add(r.$ref)
        }
      }

      // Push nested Representation schemas onto the stack
      switch (r._tag) {
        case "Declaration":
          for (const typeParam of r.typeParameters) stack.push(typeParam)
          stack.push(r.encodedSchema)
          break
        case "Suspend":
          stack.push(r.thunk)
          break
        case "String":
          if (r.contentSchema !== undefined) stack.push(r.contentSchema)
          break
        case "TemplateLiteral":
          for (const part of r.parts) stack.push(part)
          break
        case "Arrays":
          for (const element of r.elements) stack.push(element.type)
          for (const rest of r.rest) stack.push(rest)
          break
        case "Objects":
          for (const propertySignature of r.propertySignatures) stack.push(propertySignature.type)
          for (const indexSignature of r.indexSignatures) {
            stack.push(indexSignature.parameter)
            stack.push(indexSignature.type)
          }
          break
        case "Union":
          for (const type of r.types) stack.push(type)
          break
      }
    }

    return refs
  }

  // identifier -> internal identifiers it depends on
  const dependencies = new Map<string, Set<string>>(
    identifiers.map((id) => [id, collectRefs(references[id])])
  )

  // Mark only nodes that are part of cycles
  const recursive = new Set<string>()
  const state = new Map<string, 0 | 1 | 2>() // 0 = new, 1 = visiting, 2 = done
  const stack: Array<string> = []
  const indexInStack = new Map<string, number>()

  const dfs = (id: string): void => {
    const s = state.get(id) ?? 0
    if (s === 1) {
      const start = indexInStack.get(id)
      if (start !== undefined) {
        for (let i = start; i < stack.length; i++) {
          recursive.add(stack[i])
        }
      }
      return
    }
    if (s === 2) return

    state.set(id, 1)
    indexInStack.set(id, stack.length)
    stack.push(id)

    for (const dep of dependencies.get(id) ?? []) {
      dfs(dep)
    }

    stack.pop()
    indexInStack.delete(id)
    state.set(id, 2)
  }

  for (const id of identifiers) dfs(id)

  // Topologically sort the non-recursive nodes (ignoring edges to recursive nodes)
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, Set<string>>() // dep -> nodes that depend on it

  for (const id of identifiers) {
    if (!recursive.has(id)) {
      inDegree.set(id, 0)
      dependents.set(id, new Set())
    }
  }

  for (const [id, deps] of dependencies) {
    if (recursive.has(id)) continue
    for (const dep of deps) {
      if (recursive.has(dep)) continue
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1)
      dependents.get(dep)?.add(id)
    }
  }

  const queue: Array<string> = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }

  const nonRecursives: Array<{ readonly $ref: string; readonly representation: Representation }> = []
  for (let i = 0; i < queue.length; i++) {
    const $ref = queue[i]
    nonRecursives.push({ $ref, representation: references[$ref] })

    for (const next of dependents.get($ref) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, deg)
      if (deg === 0) queue.push(next)
    }
  }

  const recursives: Record<string, Representation> = {}
  for (const $ref of recursive) {
    recursives[$ref] = references[$ref]
  }

  return { nonRecursives, recursives }
}
