/**
 * Open, compiler-extensible representation of Effect schemas.
 *
 * @since 4.0.0
 */
import * as InternalRecord from "./internal/record.ts"
import * as InternalFromJsonSchemaDocument from "./internal/schema/fromJsonSchemaDocument.ts"
import * as InternalFromRepresentation from "./internal/schema/fromRepresentation.ts"
import * as InternalSchema from "./internal/schema/schema.ts"
import * as InternalToCodeDocument from "./internal/schema/toCodeDocument.ts"
import * as InternalToJsonSchemaDocument from "./internal/schema/toJsonSchemaDocument.ts"
import * as InternalToRepresentation from "./internal/schema/toRepresentation.ts"
import type * as JsonSchema from "./JsonSchema.ts"
import * as Option from "./Option.ts"
import * as Schema from "./Schema.ts"
import * as SchemaAST from "./SchemaAST.ts"
import * as SchemaGetter from "./SchemaGetter.ts"

/**
 * Open persistence identity carried by declarations and opaque checks.
 *
 * @category annotations
 * @since 4.0.0
 */
export interface RepresentationAnnotation {
  readonly id: string
  readonly payload: Schema.Json
}

/**
 * Open persistence identity and schema dependencies carried by opaque checks.
 *
 * @category annotations
 * @since 4.0.0
 */
export interface CheckRepresentationAnnotation<S> extends RepresentationAnnotation {
  readonly schemas?: ReadonlyArray<S> | undefined
}

/**
 * Input passed to JSON Schema compiler annotations.
 *
 * @since 4.0.0
 */
export declare namespace ToJsonSchema {
  /**
   * Input for a check compiler.
   *
   * @category models
   * @since 4.0.0
   */
  export interface CheckInput {
    readonly type: JsonSchema.Type | undefined
    readonly schemas: ReadonlyArray<JsonSchema.JsonSchema>
  }

  /**
   * JSON Schema compiler for a check.
   *
   * @category models
   * @since 4.0.0
   */
  export type Check = (input: CheckInput) => JsonSchema.JsonSchema
}

/**
 * Input and output contracts for code generation annotations.
 *
 * @since 4.0.0
 */
export declare namespace Generation {
  /**
   * Input for declaration code generation.
   *
   * @category models
   * @since 4.0.0
   */
  export interface DeclarationInput {
    readonly typeParameters: ReadonlyArray<Code>
  }

  /**
   * Output of declaration code generation.
   *
   * @category models
   * @since 4.0.0
   */
  export interface DeclarationOutput {
    readonly runtime: string
    readonly Type: string
    readonly importDeclarations?: ReadonlyArray<string> | undefined
  }

  /**
   * Declaration code generator.
   *
   * @category models
   * @since 4.0.0
   */
  export type Declaration = (input: DeclarationInput) => DeclarationOutput

  /**
   * Input for check code generation.
   *
   * @category models
   * @since 4.0.0
   */
  export interface CheckInput {
    readonly schemas: ReadonlyArray<Code>
  }

  /**
   * Output of check code generation.
   *
   * @category models
   * @since 4.0.0
   */
  export interface CheckOutput {
    readonly runtime: string
    readonly importDeclarations?: ReadonlyArray<string> | undefined
  }

  /**
   * Check code generator.
   *
   * @category models
   * @since 4.0.0
   */
  export type Check = (input: CheckInput) => CheckOutput
}

/**
 * A custom opaque declaration.
 *
 * @category models
 * @since 4.0.0
 */
export interface Declaration {
  readonly _tag: "Declaration"
  readonly representation?: RepresentationAnnotation | undefined
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly typeParameters: ReadonlyArray<Representation>
  readonly checks: ReadonlyArray<Check>
}

/**
 * A lazily resolved representation.
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
 * A named reference.
 *
 * @category models
 * @since 4.0.0
 */
export interface Reference {
  readonly _tag: "Reference"
  readonly $ref: string
}

interface Keyword<Tag extends string> {
  readonly _tag: Tag
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly checks: ReadonlyArray<Check>
}

/**
 * The null keyword representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Null extends Keyword<"Null"> {}
/**
 * The undefined keyword representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Undefined extends Keyword<"Undefined"> {}
/**
 * The void keyword representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Void extends Keyword<"Void"> {}
/**
 * The never keyword representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Never extends Keyword<"Never"> {}
/**
 * The unknown keyword representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Unknown extends Keyword<"Unknown"> {}
/**
 * The any keyword representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Any extends Keyword<"Any"> {}

/**
 * A string representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface String extends Keyword<"String"> {}

/**
 * A number representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Number extends Keyword<"Number"> {}
/**
 * A boolean representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Boolean extends Keyword<"Boolean"> {}
/**
 * A bigint representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface BigInt extends Keyword<"BigInt"> {}
/**
 * A symbol representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Symbol extends Keyword<"Symbol"> {}

/**
 * A literal representation.
 *
 * **Details**
 *
 * The live representation stores the native literal value. Persistent codecs
 * add an explicit type discriminator when encoding it.
 *
 * @category models
 * @since 4.0.0
 */
export interface Literal extends Keyword<"Literal"> {
  readonly literal: SchemaAST.LiteralValue
}

/**
 * A unique global symbol representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface UniqueSymbol extends Keyword<"UniqueSymbol"> {
  readonly symbol: symbol
}

/**
 * The object keyword representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface ObjectKeyword extends Keyword<"ObjectKeyword"> {}

/**
 * An enum representation.
 *
 * **Details**
 *
 * Enum members are stored as native string or number values. Persistent
 * codecs add an explicit type discriminator when encoding them.
 *
 * @category models
 * @since 4.0.0
 */
export interface Enum extends Keyword<"Enum"> {
  readonly enums: ReadonlyArray<readonly [string, string | number]>
}

/**
 * A template literal representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface TemplateLiteral extends Keyword<"TemplateLiteral"> {
  readonly parts: ReadonlyArray<Representation>
}

/**
 * A tuple element.
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
 * An array or tuple representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Arrays extends Keyword<"Arrays"> {
  readonly elements: ReadonlyArray<Element>
  readonly rest: ReadonlyArray<Representation>
}

/**
 * A property signature.
 *
 * **Details**
 *
 * The live representation stores the native property key. Persistent codecs
 * add an explicit type discriminator when encoding it.
 *
 * **Gotchas**
 *
 * Local symbols can be represented while the schema is live, but persistent
 * codecs reject them because they cannot be reconstructed by identity.
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
 * An index signature.
 *
 * @category models
 * @since 4.0.0
 */
export interface IndexSignature {
  readonly parameter: Representation
  readonly type: Representation
}

/**
 * An object representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Objects extends Keyword<"Objects"> {
  readonly propertySignatures: ReadonlyArray<PropertySignature>
  readonly indexSignatures: ReadonlyArray<IndexSignature>
}

/**
 * A union representation.
 *
 * @category models
 * @since 4.0.0
 */
export interface Union extends Keyword<"Union"> {
  readonly types: ReadonlyArray<Representation>
  readonly mode: "anyOf" | "oneOf"
}

/**
 * The structural schema representation.
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
 * A structural check.
 *
 * @category models
 * @since 4.0.0
 */
export type Check = Filter | FilterGroup

/**
 * An opaque leaf check.
 *
 * @category models
 * @since 4.0.0
 */
export interface Filter {
  readonly _tag: "Filter"
  readonly representation?: CheckRepresentationAnnotation<Representation> | undefined
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly aborted: boolean
}

/**
 * A non-empty group of checks.
 *
 * @category models
 * @since 4.0.0
 */
export interface FilterGroup {
  readonly _tag: "FilterGroup"
  readonly representation?: CheckRepresentationAnnotation<Representation> | undefined
  readonly annotations?: Schema.Annotations.Annotations | undefined
  readonly checks: readonly [Check, ...Array<Check>]
}

/**
 * Named representation definitions.
 *
 * @category models
 * @since 4.0.0
 */
export interface References {
  readonly [$ref: string]: Representation
}

/**
 * A single representation and its definitions.
 *
 * @category models
 * @since 4.0.0
 */
export interface Document {
  readonly representation: Representation
  readonly references: References
}

/**
 * Multiple representations sharing definitions.
 *
 * @category models
 * @since 4.0.0
 */
export interface MultiDocument {
  readonly representations: readonly [Representation, ...Array<Representation>]
  readonly references: References
}

/**
 * Live schemas reconstructed from a multi-document.
 *
 * @category models
 * @since 4.0.0
 */
export interface SchemaMultiDocument {
  readonly schemas: readonly [Schema.Top, ...Array<Schema.Top>]
  readonly definitions: Readonly<Record<string, Schema.Top>>
}

/**
 * Reviver for a declaration.
 *
 * @category models
 * @since 4.0.0
 */
export interface DeclarationReviver<P> {
  readonly id: string
  readonly payloadSchema: Schema.Decoder<P>
  readonly revive: (input: {
    readonly payload: P
    readonly typeParameters: ReadonlyArray<Schema.Top>
    readonly annotations: Schema.Annotations.Annotations | undefined
  }) => Schema.Top
}

/**
 * Reviver for a leaf check.
 *
 * @category models
 * @since 4.0.0
 */
export interface FilterReviver<P> {
  readonly id: string
  readonly payloadSchema: Schema.Decoder<P>
  readonly revive: (input: {
    readonly payload: P
    readonly schemas: ReadonlyArray<Schema.Top>
    readonly annotations: Schema.Annotations.Filter | undefined
  }) => SchemaAST.Filter<any>
}

/**
 * Reviver for a check group.
 *
 * @category models
 * @since 4.0.0
 */
export interface FilterGroupReviver<P> {
  readonly id: string
  readonly payloadSchema: Schema.Decoder<P>
  readonly revive: (input: {
    readonly payload: P
    readonly schemas: ReadonlyArray<Schema.Top>
    readonly annotations: Schema.Annotations.Filter | undefined
  }) => SchemaAST.FilterGroup<any>
}

/**
 * A check reviver.
 *
 * @category models
 * @since 4.0.0
 */
export type CheckReviver<P> = FilterReviver<P> | FilterGroupReviver<P>

/**
 * A typed reviver.
 *
 * @category models
 * @since 4.0.0
 */
export type Reviver<P> = DeclarationReviver<P> | CheckReviver<P>

/**
 * A reviver erased only at collection boundaries.
 *
 * @category models
 * @since 4.0.0
 */
export type AnyReviver = Reviver<any>

/**
 * Creates a declaration reviver while inferring its payload type from `payloadSchema`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeDeclarationReviver: <P>(
  id: string,
  payloadSchema: Schema.Decoder<P>,
  revive: DeclarationReviver<P>["revive"]
) => DeclarationReviver<P> = InternalSchema.makeDeclarationReviver

/**
 * Creates a filter reviver while inferring its payload type from `payloadSchema`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeFilterReviver: <P>(
  id: string,
  payloadSchema: Schema.Decoder<P>,
  revive: FilterReviver<P>["revive"]
) => FilterReviver<P> = InternalSchema.makeFilterReviver

/**
 * Creates a filter group reviver while inferring its payload type from `payloadSchema`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeFilterGroupReviver: <P>(
  id: string,
  payloadSchema: Schema.Decoder<P>,
  revive: FilterGroupReviver<P>["revive"]
) => FilterGroupReviver<P> = InternalSchema.makeFilterGroupReviver

/**
 * Options for importing JSON Schema Draft 2020-12 documents.
 *
 * **When to use**
 *
 * Use when each JSON Schema node must be transformed before it is translated.
 *
 * **Gotchas**
 *
 * `onEnter` must return a JSON Schema object. Its result is used directly, and exceptions raised by the callback pass through unchanged.
 *
 * @category models
 * @since 4.0.0
 */
export interface FromJsonSchemaOptions {
  readonly onEnter?: ((schema: JsonSchema.JsonSchema) => JsonSchema.JsonSchema) | undefined
}

/**
 * Runtime and TypeScript source generated for one schema.
 *
 * @category models
 * @since 4.0.0
 */
export interface Code {
  readonly runtime: string
  readonly Type: string
}

/**
 * Creates generated runtime and TypeScript source strings for a schema.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeCode: (runtime: string, Type: string) => Code = InternalToCodeDocument.makeCode

/**
 * Auxiliary source artifact emitted while generating schema code.
 *
 * @category models
 * @since 4.0.0
 */
export type Artifact =
  | {
    readonly _tag: "Symbol"
    readonly identifier: string
    readonly code: Code
  }
  | {
    readonly _tag: "Enum"
    readonly identifier: string
    readonly code: Code
  }
  | {
    readonly _tag: "Import"
    readonly importDeclaration: string
  }

/**
 * Generated schema code together with named references and auxiliary artifacts.
 *
 * @category models
 * @since 4.0.0
 */
export interface CodeDocument {
  readonly codes: ReadonlyArray<Code>
  readonly references: {
    readonly nonRecursives: ReadonlyArray<{
      readonly $ref: string
      readonly code: Code
    }>
    readonly recursives: Readonly<Record<string, Code>>
  }
  readonly artifacts: ReadonlyArray<Artifact>
}

/**
 * Lowers the encoded side of an AST to a live representation document.
 *
 * **Details**
 *
 * Apply `SchemaAST.toType` to the AST first to lower its type side instead.
 *
 * @category constructors
 * @since 4.0.0
 */
export function toRepresentation(ast: SchemaAST.AST): Document {
  return InternalToRepresentation.toRepresentation(ast)
}

/**
 * Lowers one or more AST encoded sides in a shared reference environment.
 *
 * **Details**
 *
 * Apply `SchemaAST.toType` to an AST first to lower its type side instead.
 *
 * @category constructors
 * @since 4.0.0
 */
export function toRepresentations(
  asts: readonly [SchemaAST.AST, ...Array<SchemaAST.AST>]
): MultiDocument {
  return InternalToRepresentation.toRepresentations(asts)
}

/**
 * Converts live schemas and their named definitions to a shared representation document.
 *
 * **When to use**
 *
 * Use when schemas with shared or unreachable definitions must be passed to representation compilers such as `toCodeDocument`.
 *
 * **Gotchas**
 *
 * Every schema is projected to its encoded side. Definitions are preserved even when no root reaches them.
 *
 * @see {@link toRepresentations} for converting AST roots without an explicit definition map
 * @see {@link toCodeDocument} for generating code from the result
 *
 * @category constructors
 * @since 4.0.0
 */
export function fromSchemaMultiDocument(document: SchemaMultiDocument): MultiDocument {
  return InternalToRepresentation.fromSchemaMultiDocument(document)
}

/**
 * Wraps a single representation document as a multi-document with one root.
 *
 * **When to use**
 *
 * Use when an API such as `toCodeDocument` requires a `MultiDocument`.
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
 * Compiles a live representation document to JSON Schema Draft 2020-12.
 *
 * **When to use**
 *
 * Use when you need JSON Schema output from a representation whose checks carry compiler annotations.
 *
 * **Gotchas**
 *
 * Opaque declarations are represented by an unconstrained JSON Schema. Check callback results are used directly, and exceptions raised by a callback pass through unchanged.
 *
 * @see {@link toJsonSchemaMultiDocument} for multiple roots sharing definitions
 *
 * @category transforming
 * @since 4.0.0
 */
export function toJsonSchemaDocument(
  document: Document,
  options?: Schema.ToJsonSchemaOptions
): JsonSchema.Document<"draft-2020-12"> {
  return InternalToJsonSchemaDocument.toJsonSchemaDocument(document, options)
}

/**
 * Compiles multiple live representations to a shared JSON Schema Draft 2020-12 document.
 *
 * **When to use**
 *
 * Use when several representation roots must share the same JSON Schema definitions.
 *
 * **Gotchas**
 *
 * Every definition is compiled, including definitions that are not reachable from a root.
 *
 * @see {@link toJsonSchemaDocument} for a single root
 *
 * @category transforming
 * @since 4.0.0
 */
export function toJsonSchemaMultiDocument(
  document: MultiDocument,
  options?: Schema.ToJsonSchemaOptions
): JsonSchema.MultiDocument<"draft-2020-12"> {
  return InternalToJsonSchemaDocument.toJsonSchemaMultiDocument(document, options)
}

/**
 * Generates TypeScript source for live schema representations and their definitions.
 *
 * **When to use**
 *
 * Use when custom declarations and checks provide `toCode` callbacks and must be emitted without a central handler registry.
 *
 * **Gotchas**
 *
 * Opaque declarations and leaf checks require `toCode` callbacks. Callback results are used directly, and exceptions raised by a callback pass through unchanged.
 *
 * @category transforming
 * @since 4.0.0
 */
export function toCodeDocument(document: MultiDocument): CodeDocument {
  return InternalToCodeDocument.toCodeDocument(document)
}

const RepresentationSchema = Schema.suspend(
  (): Schema.Codec<Representation, unknown> => RepresentationUnion
)
const RepresentationsSchema = Schema.Array(RepresentationSchema)

const RepresentationAnnotationSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  payload: Schema.Json
})

const CheckRepresentationAnnotationSchema = Schema.Struct({
  ...RepresentationAnnotationSchema.fields,
  schemas: Schema.optional(RepresentationsSchema)
})

const LiveAnnotationsSchema = Schema.Record(Schema.String, Schema.Unknown)
const JsonAnnotationsSchema = Schema.Record(Schema.String, Schema.Json)

function pruneAnnotations(
  annotations: Readonly<Record<string, unknown>>
): Option.Option<Readonly<Record<string, Schema.Json>>> {
  const out: Record<string, Schema.Json> = {}
  for (const [key, value] of Object.entries(annotations)) {
    if (SchemaAST.isJson(value)) {
      InternalRecord.assignProperty(out, key, value)
    }
  }
  return Object.keys(out).length === 0 ? Option.none() : Option.some(out)
}

const AnnotationsSchema = Schema.optional(LiveAnnotationsSchema).pipe(
  Schema.encodeTo(Schema.optionalKey(JsonAnnotationsSchema), {
    decode: SchemaGetter.passthroughSubtype(),
    encode: SchemaGetter.transformOptional((annotations) =>
      Option.isNone(annotations) || annotations.value === undefined
        ? Option.none()
        : pruneAnnotations(annotations.value)
    )
  })
)

const CheckSchema = Schema.suspend((): Schema.Codec<Check, unknown> => CheckUnion)
const ChecksSchema = Schema.Array(CheckSchema)
const KeywordFields = {
  annotations: AnnotationsSchema,
  checks: ChecksSchema
}
const FilterSchema = Schema.Struct({
  _tag: Schema.tag("Filter"),
  representation: CheckRepresentationAnnotationSchema,
  annotations: AnnotationsSchema,
  aborted: Schema.Boolean
})
const FilterGroupSchema = Schema.Struct({
  _tag: Schema.tag("FilterGroup"),
  representation: Schema.optional(CheckRepresentationAnnotationSchema),
  annotations: AnnotationsSchema,
  checks: Schema.NonEmptyArray(CheckSchema)
})
const CheckUnion = Schema.Union([FilterSchema, FilterGroupSchema])

function makeKeywordSchema<Tag extends Exclude<Representation["_tag"], "Reference">>(tag: Tag) {
  return Schema.Struct({
    _tag: Schema.tag(tag),
    ...KeywordFields
  })
}

const DeclarationSchema = Schema.Struct({
  _tag: Schema.tag("Declaration"),
  representation: RepresentationAnnotationSchema,
  annotations: AnnotationsSchema,
  typeParameters: RepresentationsSchema,
  checks: ChecksSchema
})
const SuspendSchema = Schema.Struct({
  _tag: Schema.tag("Suspend"),
  annotations: AnnotationsSchema,
  checks: Schema.Tuple([]),
  thunk: RepresentationSchema
})
function makeValueSchema<Type extends string, Value>(type: Type, value: Schema.Codec<Value>) {
  return value.pipe(
    Schema.encodeTo(Schema.Struct({ type: Schema.tag(type), value }), {
      decode: SchemaGetter.transform((encoded: { readonly type: Type; readonly value: Value }) => encoded.value),
      encode: SchemaGetter.transform((value: Value) => ({ type, value }))
    })
  )
}
const StringValueCodec = makeValueSchema("string", Schema.String)
const NumberValueCodec = makeValueSchema("number", Schema.Number)
const LiteralSchema = Schema.Struct({
  _tag: Schema.tag("Literal"),
  ...KeywordFields,
  literal: Schema.Union([
    StringValueCodec,
    makeValueSchema("number", Schema.Finite),
    makeValueSchema("bigint", Schema.BigInt),
    makeValueSchema("boolean", Schema.Boolean)
  ])
})
const UniqueSymbolSchema = Schema.Struct({
  _tag: Schema.tag("UniqueSymbol"),
  ...KeywordFields,
  symbol: Schema.Symbol
})
const EnumSchema = Schema.Struct({
  _tag: Schema.tag("Enum"),
  ...KeywordFields,
  enums: Schema.Array(Schema.Tuple([
    Schema.String,
    Schema.Union([StringValueCodec, NumberValueCodec])
  ]))
})
const TemplateLiteralSchema = Schema.Struct({
  _tag: Schema.tag("TemplateLiteral"),
  ...KeywordFields,
  parts: RepresentationsSchema
})
const ElementSchema = Schema.Struct({
  isOptional: Schema.Boolean,
  type: RepresentationSchema,
  annotations: AnnotationsSchema
})
const ArraysSchema = Schema.Struct({
  _tag: Schema.tag("Arrays"),
  ...KeywordFields,
  elements: Schema.Array(ElementSchema),
  rest: RepresentationsSchema
})
const PropertySignatureSchema = Schema.Struct({
  name: Schema.Union([
    StringValueCodec,
    NumberValueCodec,
    makeValueSchema("symbol", Schema.Symbol)
  ]),
  type: RepresentationSchema,
  isOptional: Schema.Boolean,
  isMutable: Schema.Boolean,
  annotations: AnnotationsSchema
})
const IndexSignatureSchema = Schema.Struct({
  parameter: RepresentationSchema,
  type: RepresentationSchema
})
const ObjectsSchema = Schema.Struct({
  _tag: Schema.tag("Objects"),
  ...KeywordFields,
  propertySignatures: Schema.Array(PropertySignatureSchema),
  indexSignatures: Schema.Array(IndexSignatureSchema)
})
const UnionSchema = Schema.Struct({
  _tag: Schema.tag("Union"),
  ...KeywordFields,
  types: RepresentationsSchema,
  mode: Schema.Literals(["anyOf", "oneOf"])
})
const ReferenceSchema = Schema.Struct({
  _tag: Schema.tag("Reference"),
  $ref: Schema.NonEmptyString
})

const RepresentationUnion = Schema.Union([
  DeclarationSchema,
  ReferenceSchema,
  SuspendSchema,
  makeKeywordSchema("Null"),
  makeKeywordSchema("Undefined"),
  makeKeywordSchema("Void"),
  makeKeywordSchema("Never"),
  makeKeywordSchema("Unknown"),
  makeKeywordSchema("Any"),
  makeKeywordSchema("String"),
  makeKeywordSchema("Number"),
  makeKeywordSchema("Boolean"),
  makeKeywordSchema("BigInt"),
  makeKeywordSchema("Symbol"),
  makeKeywordSchema("ObjectKeyword"),
  LiteralSchema,
  UniqueSymbolSchema,
  EnumSchema,
  TemplateLiteralSchema,
  ArraysSchema,
  ObjectsSchema,
  UnionSchema
])

const ReferencesSchema = Schema.Record(Schema.String, RepresentationSchema)

const DocumentFromJson: Schema.Codec<Document, Schema.Json> = Schema.toCodecJson(
  Schema.Struct({
    representation: RepresentationSchema,
    references: ReferencesSchema
  })
)

const MultiDocumentFromJson: Schema.Codec<MultiDocument, Schema.Json> = Schema.toCodecJson(
  Schema.Struct({
    representations: Schema.NonEmptyArray(RepresentationSchema),
    references: ReferencesSchema
  })
)

const encodeDocument = Schema.encodeSync(DocumentFromJson)
const encodeMultiDocument = Schema.encodeSync(MultiDocumentFromJson)
const decodeDocument = Schema.decodeSync(DocumentFromJson)
const decodeMultiDocument = Schema.decodeSync(MultiDocumentFromJson)

/**
 * Projects a live single-root representation document and encodes it as JSON.
 *
 * **When to use**
 *
 * Use when you need a stable JSON value for storage or transport after calling `toRepresentation`.
 *
 * **Gotchas**
 *
 * Generic annotations that are not JSON are omitted. Invalid persistence identities and unsupported structural values throw an `Error` containing their representation path.
 *
 * @see {@link toRepresentation} for constructing the live document
 * @see {@link toJsonMultiDocument} for documents with multiple roots
 *
 * @category encoding
 * @since 4.0.0
 */
export function toJson(document: Document): Schema.Json {
  return encodeDocument(document)
}

/**
 * Projects a live multi-root representation document and encodes it as JSON.
 *
 * **When to use**
 *
 * Use when you need one JSON value for multiple live roots that share a reference environment.
 *
 * **Gotchas**
 *
 * The root order and shared reference keys are preserved, while non-JSON generic annotations are omitted.
 *
 * @see {@link toRepresentations} for constructing the live multi-document
 * @see {@link toJson} for a single-root document
 *
 * @category encoding
 * @since 4.0.0
 */
export function toJsonMultiDocument(document: MultiDocument): Schema.Json {
  return encodeMultiDocument(document)
}

/**
 * Decodes a persisted single-root representation document from JSON.
 *
 * **When to use**
 *
 * Use when reading a representation document from storage or transport before inspecting it or passing it to `fromRepresentation`.
 *
 * **Gotchas**
 *
 * Invalid documents throw a schema decoding error. Decoding does not reconstruct runtime callbacks.
 *
 * @see {@link toJson} for encoding a document
 * @see {@link fromRepresentation} for reconstructing a runtime schema
 * @see {@link fromJsonMultiDocument} for multiple roots sharing references
 *
 * @category decoding
 * @since 4.0.0
 */
export function fromJson(input: Schema.Json): Document {
  return decodeDocument(input)
}

/**
 * Decodes a persisted multi-root representation document from JSON.
 *
 * **When to use**
 *
 * Use when reading multiple representation roots that share references before inspecting them or passing them to `fromRepresentations`.
 *
 * **Gotchas**
 *
 * Invalid documents throw a schema decoding error. Decoding does not reconstruct runtime callbacks.
 *
 * @see {@link toJsonMultiDocument} for encoding a multi-document
 * @see {@link fromRepresentations} for reconstructing runtime schemas
 * @see {@link fromJson} for a single root
 *
 * @category decoding
 * @since 4.0.0
 */
export function fromJsonMultiDocument(input: Schema.Json): MultiDocument {
  return decodeMultiDocument(input)
}

/**
 * Reconstructs a runtime schema from a representation document.
 *
 * **When to use**
 *
 * Use when you have decoded or constructed a document whose declaration and check annotations may require revivers.
 *
 * **Gotchas**
 *
 * Revivers are resolved locally by `id`; none are installed implicitly. Reviver results are used directly, and exceptions raised by a reviver pass through unchanged.
 *
 * @see {@link fromJson} for decoding a persisted document
 * @see {@link fromRepresentations} for multiple roots sharing references
 *
 * @category transforming
 * @since 4.0.0
 */
export function fromRepresentation(
  document: Document,
  options: { readonly revivers: ReadonlyArray<AnyReviver> }
): Schema.Top {
  return InternalFromRepresentation.fromRepresentation(document, options.revivers)
}

/**
 * Reconstructs multiple runtime schemas and their shared definitions from a representation multi-document.
 *
 * **When to use**
 *
 * Use when every root and named definition must be rebuilt in one shared reference environment.
 *
 * **Gotchas**
 *
 * Every definition is revived, including definitions not reachable from a root. Revivers are resolved locally by `id`; none are installed implicitly.
 *
 * @see {@link fromJsonMultiDocument} for decoding a persisted multi-document
 * @see {@link fromRepresentation} for a single root
 *
 * @category transforming
 * @since 4.0.0
 */
export function fromRepresentations(
  document: MultiDocument,
  options: { readonly revivers: ReadonlyArray<AnyReviver> }
): SchemaMultiDocument {
  return InternalFromRepresentation.fromRepresentations(document, options.revivers)
}

/**
 * Imports a JSON Schema Draft 2020-12 document as a runtime schema.
 *
 * **When to use**
 *
 * Use when you need to validate or transform values described by an external JSON Schema document.
 *
 * **Gotchas**
 *
 * Import is best-effort. Built-in declarations and checks are reconstructed with importer-owned revivers. Callback results are used directly, and exceptions raised by a callback pass through unchanged.
 *
 * @see {@link fromJsonSchemaMultiDocument} for multiple roots sharing definitions
 * @see {@link toRepresentation} for converting the result to a representation document
 *
 * @category constructors
 * @since 4.0.0
 */
export function fromJsonSchemaDocument(
  document: JsonSchema.Document<"draft-2020-12">,
  options?: FromJsonSchemaOptions
): Schema.Top {
  return InternalFromJsonSchemaDocument.fromJsonSchemaDocument(document, options)
}

/**
 * Imports multiple JSON Schema Draft 2020-12 roots as runtime schemas with shared definitions.
 *
 * **When to use**
 *
 * Use when multiple imported roots must preserve shared definitions, aliases, and recursion.
 *
 * **Gotchas**
 *
 * Every definition is translated, including definitions that no root references. Callback results are used directly, and exceptions raised by a callback pass through unchanged.
 *
 * @see {@link fromJsonSchemaDocument} for a single root
 * @see {@link fromSchemaMultiDocument} for converting the result to a representation document
 *
 * @category constructors
 * @since 4.0.0
 */
export function fromJsonSchemaMultiDocument(
  document: JsonSchema.MultiDocument<"draft-2020-12">,
  options?: FromJsonSchemaOptions
): SchemaMultiDocument {
  return InternalFromJsonSchemaDocument.fromJsonSchemaMultiDocument(document, options)
}
