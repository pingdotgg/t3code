/**
 * Generates OpenRPC 1.3.2 documents for Effect RPC contracts using the
 * canonical JSON codec. Generation requires neither handlers nor a server and
 * does not install discovery methods or change the transport.
 *
 * @stability unstable
 * @since 4.1.3
 */
import * as Context from "../Context.ts"
import * as InternalRecord from "../internal/record.ts"
import * as InternalToCodec from "../internal/schema/toCodec.ts"
import * as InternalToJsonSchemaDocument from "../internal/schema/toJsonSchemaDocument.ts"
import * as InternalToRepresentation from "../internal/schema/toRepresentation.ts"
import * as JsonSchema from "../JsonSchema.ts"
import * as Schema from "../Schema.ts"
import * as SchemaAST from "../SchemaAST.ts"
import type * as SchemaRepresentation from "../SchemaRepresentation.ts"
import type * as Types from "../Types.ts"
import * as Rpc from "./Rpc.ts"
import type * as RpcGroup from "./RpcGroup.ts"
import * as RpcSchema from "./RpcSchema.ts"

/**
 * OpenRPC document generated from an RPC group.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface OpenRPCSpec {
  readonly openrpc: "1.3.2"
  readonly info: OpenRPCInfo
  readonly servers?: ReadonlyArray<OpenRPCServer> | undefined
  readonly methods: ReadonlyArray<OpenRPCMethod>
  readonly components: { readonly schemas: Readonly<Record<string, JsonSchema.JsonSchema>> }
}

/**
 * API identity and optional publication metadata.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface OpenRPCInfo {
  readonly title: string
  readonly version: string
  readonly description?: string | undefined
  readonly termsOfService?: string | undefined
  readonly contact?: { readonly name?: string; readonly url?: string; readonly email?: string } | undefined
  readonly license?: { readonly name: string; readonly url?: string } | undefined
}

/**
 * Named JSON-RPC endpoint and optional URL template variables.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface OpenRPCServer {
  readonly name: string
  readonly url: string
  readonly summary?: string | undefined
  readonly description?: string | undefined
  readonly variables?:
    | Readonly<
      Record<string, {
        readonly default: string
        readonly enum?: ReadonlyArray<string> | undefined
        readonly description?: string | undefined
      }>
    >
    | undefined
}

/**
 * External documentation link attached to a method or tag.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface OpenRPCExternalDocs {
  readonly url: string
  readonly description?: string | undefined
}

/**
 * Named grouping metadata for an RPC method.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface OpenRPCTag {
  readonly name: string
  readonly summary?: string | undefined
  readonly description?: string | undefined
  readonly externalDocs?: OpenRPCExternalDocs | undefined
}

/**
 * Named encoded JSON value used in a method example.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface OpenRPCExample {
  readonly name: string
  readonly value: Schema.Json
  readonly summary?: string | undefined
  readonly description?: string | undefined
}

/**
 * Paired named parameters and result illustrating a successful RPC call.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface OpenRPCExamplePairing {
  readonly name: string
  readonly params: ReadonlyArray<OpenRPCExample>
  readonly result: OpenRPCExample
  readonly summary?: string | undefined
  readonly description?: string | undefined
}

/**
 * JSON-RPC error metadata. The optional `data` is an example JSON value, not a
 * JSON Schema; the serializer sends the encoded Effect cause in this field.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface OpenRPCError {
  readonly code: number
  readonly message: string
  readonly data?: Schema.Json | undefined
}

/**
 * Named parameter or result with its canonical encoded Draft 7 JSON Schema.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface OpenRPCContentDescriptor {
  readonly name: string
  readonly schema: JsonSchema.JsonSchema
  readonly required?: boolean | undefined
  readonly summary?: string | undefined
  readonly description?: string | undefined
  readonly deprecated?: boolean | undefined
}

/**
 * JSON-RPC method with named or positional parameters and optional Effect metadata.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface OpenRPCMethod {
  readonly name: string
  readonly paramStructure: "by-name" | "by-position" | "either"
  /**
   * Known named fields or the fixed positional prefix. Dynamic keys, rest
   * elements, and alternative shapes require `x-effect-params-schema`.
   */
  readonly params: ReadonlyArray<OpenRPCContentDescriptor>
  /**
   * Success result, or terminal completion for a streamed method.
   */
  readonly result: OpenRPCContentDescriptor
  readonly summary?: string | undefined
  readonly description?: string | undefined
  readonly tags?: ReadonlyArray<OpenRPCTag> | undefined
  readonly examples?: ReadonlyArray<OpenRPCExamplePairing> | undefined
  readonly deprecated?: boolean | undefined
  readonly externalDocs?: OpenRPCExternalDocs | undefined
  readonly errors?: ReadonlyArray<OpenRPCError> | undefined
  /**
   * Complete encoded parameter schema, including relationships and open-ended
   * keys or positions that individual OpenRPC descriptors cannot express.
   */
  readonly "x-effect-params-schema"?: JsonSchema.JsonSchema | undefined
  readonly "x-effect-stream"?: OpenRPCEffectStream | undefined
}

/**
 * Effect-specific metadata for streamed JSON-RPC responses.
 *
 * **Details**
 *
 * Responses marked `chunk: true` carry a `result` matching `chunkSchema`, whose
 * elements match `itemSchema`. The method's ordinary result descriptor describes
 * terminal completion. Failed exits carry an encoded cause matching `causeSchema`
 * in `error.data`. Control methods apply where the transport enables them.
 *
 * **Gotchas**
 *
 * This extension documents Effect's existing protocol; generic OpenRPC clients
 * do not automatically support its streaming or control messages.
 *
 * @stability unstable
 * @category models
 * @since 4.1.3
 */
export interface OpenRPCEffectStream {
  readonly encoding: "effect-jsonrpc"
  readonly itemSchema: JsonSchema.JsonSchema
  readonly chunkSchema: JsonSchema.JsonSchema
  readonly errorSchema: JsonSchema.JsonSchema
  readonly causeSchema: JsonSchema.JsonSchema
  readonly ackMethod: "@effect/rpc/Ack"
  readonly interruptMethod: "@effect/rpc/Interrupt"
}

/**
 * OpenRPC annotation for setting a method summary or group default.
 *
 * @stability unstable
 * @category services
 * @since 4.1.3
 */
export class Summary extends Context.Service<Summary, string>()("effect/rpc/OpenRpc/Summary") {}

/**
 * OpenRPC annotation for setting a method description or group default.
 *
 * @stability unstable
 * @category services
 * @since 4.1.3
 */
export class Description extends Context.Service<Description, string>()("effect/rpc/OpenRpc/Description") {}

/**
 * OpenRPC annotation for setting method tags, replacing the group default list.
 *
 * @stability unstable
 * @category services
 * @since 4.1.3
 */
export class Tags extends Context.Service<Tags, ReadonlyArray<OpenRPCTag>>()("effect/rpc/OpenRpc/Tags") {}

/**
 * OpenRPC annotation for setting encoded call examples, replacing the group default list.
 *
 * @stability unstable
 * @category services
 * @since 4.1.3
 */
export class Examples
  extends Context.Service<Examples, ReadonlyArray<OpenRPCExamplePairing>>()("effect/rpc/OpenRpc/Examples")
{}

/**
 * OpenRPC annotation for marking a method deprecated, overriding the group default.
 *
 * @stability unstable
 * @category services
 * @since 4.1.3
 */
export class Deprecated extends Context.Service<Deprecated, boolean>()("effect/rpc/OpenRpc/Deprecated") {}

/**
 * OpenRPC annotation for setting external documentation or a group default.
 *
 * @stability unstable
 * @category services
 * @since 4.1.3
 */
export class ExternalDocs
  extends Context.Service<ExternalDocs, OpenRPCExternalDocs>()("effect/rpc/OpenRpc/ExternalDocs")
{}

/**
 * OpenRPC annotation for specifying error metadata. When present, it replaces
 * the error metadata derived from literal `code` and `message` fields. Method
 * lists replace group lists.
 *
 * @stability unstable
 * @category services
 * @since 4.1.3
 */
export class Errors extends Context.Service<Errors, ReadonlyArray<OpenRPCError>>()("effect/rpc/OpenRpc/Errors") {}

const annotationKeys = {
  summary: Summary,
  description: Description,
  tags: Tags,
  examples: Examples,
  deprecated: Deprecated,
  externalDocs: ExternalDocs,
  errors: Errors
}

type AnnotationKey = keyof typeof annotationKeys

/**
 * Builds a `Context` containing OpenRPC annotations from the supplied options.
 *
 * **Details**
 *
 * Undefined entries are omitted. False values and empty lists are retained, so
 * method annotations can override group defaults without inheriting their values.
 *
 * **Example** (Overriding group documentation defaults)
 *
 * ```ts import.meta.vitest
 * import { OpenRpc, Rpc, RpcGroup } from "effect/rpc"
 *
 * const group = RpcGroup.make(
 *   Rpc.make("Ping").annotateMerge(OpenRpc.annotations({
 *     summary: "Check availability",
 *     deprecated: false,
 *     tags: []
 *   }))
 * ).annotate(OpenRpc.Deprecated, true).annotate(OpenRpc.Tags, [{ name: "legacy" }])
 *
 * const document = OpenRpc.fromRpcGroup(group, {
 *   info: { title: "Health API", version: "1.0.0" }
 * })
 *
 * document.methods[0].deprecated // => false
 * document.methods[0].tags // => []
 * ```
 *
 * @stability unstable
 * @category annotations
 * @since 4.1.3
 */
export const annotations = (
  options: Pick<
    OpenRPCMethod,
    "summary" | "description" | "tags" | "examples" | "deprecated" | "externalDocs" | "errors"
  >
): Context.Context<never> => {
  let context = Context.empty()
  for (const key of Object.keys(annotationKeys) as Array<AnnotationKey>) {
    const value = options[key]
    if (value !== undefined) {
      context = Context.add(context, annotationKeys[key] as Context.Key<unknown, unknown>, value)
    }
  }
  return context
}

/**
 * Generates an OpenRPC 1.3.2 document describing the canonical JSON encoding of
 * the final composed RPC group, including middleware failures.
 *
 * **Gotchas**
 *
 * Schema generation is best-effort, as in OpenAPI; Effect decoding remains the
 * authority for custom predicates and approximated constraints. Structured
 * payloads include `x-effect-params-schema` with the complete parameter schema,
 * and streams include `x-effect-stream`; both require Effect-aware tooling.
 * Scalar payloads and schemas that cannot be converted to Draft 7 throw. Errors
 * without literal codes and messages are omitted unless an `Errors` annotation
 * is set. Void and stream completion results have a JSON null result schema.
 *
 * **Example** (Documenting a user lookup)
 *
 * ```ts import.meta.vitest
 * import { Schema } from "effect"
 * import { OpenRpc, Rpc, RpcGroup } from "effect/rpc"
 *
 * const users = RpcGroup.make(
 *   Rpc.make("GetUser", {
 *     payload: { id: Schema.String },
 *     success: Schema.Struct({ id: Schema.String, name: Schema.String }),
 *     error: Schema.Struct({ code: Schema.Literal(404), message: Schema.Literal("User not found") })
 *   }).annotate(OpenRpc.Description, "Look up a user by ID")
 * )
 *
 * const document = OpenRpc.fromRpcGroup(users, {
 *   info: { title: "Users API", version: "1.0.0" },
 *   servers: [{ name: "production", url: "https://example.com/rpc" }]
 * })
 *
 * document.methods[0].params // => [{ name: "id", required: true, schema: { type: "string" } }]
 * document.methods[0].errors // => [{ code: 404, message: "User not found" }]
 * JSON.parse(JSON.stringify(document)).openrpc // => "1.3.2"
 * ```
 *
 * **Example** (Describing a positional streaming call)
 *
 * ```ts import.meta.vitest
 * import { Schema } from "effect"
 * import { OpenRpc, Rpc, RpcGroup } from "effect/rpc"
 *
 * const group = RpcGroup.make(Rpc.make("Values", {
 *   payload: Schema.Tuple([Schema.Int]),
 *   success: Schema.NumberFromString,
 *   stream: true
 * }))
 * const method = OpenRpc.fromRpcGroup(group, {
 *   info: { title: "Values API", version: "1.0.0" }
 * }).methods[0]
 *
 * method.paramStructure // => "by-position"
 * method.params.map(({ name }) => name) // => ["0"]
 * method.result.schema // => { type: "null" }
 * method["x-effect-stream"]?.itemSchema // => { type: "string" }
 * ```
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.3
 */
export function fromRpcGroup<R extends Rpc.Any>(
  group: RpcGroup.RpcGroup<R>,
  options: { readonly info: OpenRPCInfo; readonly servers?: ReadonlyArray<OpenRPCServer> | undefined }
): OpenRPCSpec {
  const methods: Array<OpenRPCMethod> = []
  const components: Record<string, JsonSchema.JsonSchema> = {}
  const spec: OpenRPCSpec = {
    openrpc: "1.3.2",
    info: options.info,
    ...(options.servers === undefined ? undefined : { servers: options.servers }),
    methods,
    components: { schemas: components }
  }
  if (group.requests.size === 0) return spec

  const asts: Array<SchemaAST.AST> = []
  const register = (schema: Schema.Constraint): number => asts.push(InternalToCodec.toCodecJsonAST(schema.ast)) - 1
  const contracts: Array<Contract> = Array.from(
    group.requests.values() as unknown as Iterable<Rpc.AnyWithProps>,
    (rpc) =>
      withMethod(rpc._tag, () => {
        const exit = Rpc.exitSchema(rpc)
        return {
          rpc,
          payload: register(rpc.payloadSchema),
          result: register(exit.value),
          errorSchema: exit.error,
          hasPayload: hasPayload(rpc.payloadSchema.ast),
          paramStructure: "by-name",
          stream: RpcSchema.isStreamSchema(rpc.successSchema)
            ? {
              item: register(rpc.successSchema.success),
              chunk: register(Schema.NonEmptyArray(rpc.successSchema.success)),
              error: register(exit.error),
              cause: register(Schema.Cause(exit.error, exit.defect))
            }
            : undefined
        }
      })
  )
  const representation = InternalToRepresentation.toRepresentations(
    asts as [SchemaAST.AST, ...Array<SchemaAST.AST>]
  )
  const representations: [SchemaRepresentation.Representation, ...Array<SchemaRepresentation.Representation>] = [
    ...representation.representations
  ]
  for (const contract of contracts) {
    withMethod(contract.rpc._tag, () => {
      if (!contract.hasPayload) return
      const payload = resolveRepresentation(representations[contract.payload], representation.references)
      if (payload._tag === "Objects") {
        contract.paramStructure = "by-name"
        contract.parameters = representations.push({
          _tag: "Objects",
          propertySignatures: payload.propertySignatures,
          indexSignatures: [],
          checks: []
        }) - 1
      } else if (payload._tag === "Arrays") {
        contract.paramStructure = "by-position"
        let optional = false
        for (const element of payload.elements) {
          if (optional && !element.isOptional) {
            throw new Error("optional positional parameters must follow required parameters")
          }
          optional ||= element.isOptional
        }
        contract.parameters = representations.push({
          _tag: "Arrays",
          elements: payload.elements,
          rest: [],
          checks: []
        }) - 1
      } else {
        contract.paramStructure = parameterStructure(payload, representation.references)
      }
    })
  }
  const document = compileSchemas({ representations, references: representation.references })
  InternalRecord.assignProperties(components, document.definitions)
  const schemas = document.schema.anyOf as Array<JsonSchema.JsonSchema>
  for (const contract of contracts) {
    const rpc = contract.rpc
    withMethod(rpc._tag, () => {
      const annotations = Context.merge(group.annotations, rpc.annotations)
      const params: Array<OpenRPCContentDescriptor> = []
      if (contract.parameters !== undefined) {
        const projected = representations[contract.parameters]
        const root = schemas[contract.parameters]
        if (projected._tag === "Objects") {
          const required = new Set(root.required as ReadonlyArray<string> | undefined)
          for (const [name, schema] of Object.entries(root.properties as Record<string, JsonSchema.JsonSchema> ?? {})) {
            params.push({ ...descriptor(name, schema, components), required: required.has(name) })
          }
          params.sort((a, b) => Number(b.required) - Number(a.required))
        } else if (projected._tag === "Arrays") {
          const items = root.items as ReadonlyArray<JsonSchema.JsonSchema> | undefined
          for (let i = 0; i < projected.elements.length; i++) {
            params.push({
              ...descriptor(String(i), items![i], components),
              required: !projected.elements[i].isOptional
            })
          }
        }
      }
      const method: Types.Mutable<OpenRPCMethod> = {
        name: rpc._tag,
        paramStructure: contract.paramStructure,
        params,
        result: descriptor("result", schemas[contract.result], components)
      }
      for (const key of Object.keys(annotationKeys) as Array<AnnotationKey>) {
        const value = Context.getOrUndefined(annotations, annotationKeys[key] as Context.Key<unknown, unknown>)
        if (value !== undefined) (method as Record<string, unknown>)[key] = value
      }
      if (method.errors === undefined) {
        const errors = deriveErrors(contract.errorSchema)
        if (errors.length > 0) method.errors = errors
      }
      if (contract.hasPayload) method["x-effect-params-schema"] = schemas[contract.payload]
      const stream = contract.stream
      if (stream !== undefined) {
        method["x-effect-stream"] = {
          encoding: "effect-jsonrpc",
          itemSchema: schemas[stream.item],
          chunkSchema: schemas[stream.chunk],
          errorSchema: schemas[stream.error],
          causeSchema: schemas[stream.cause],
          ackMethod: "@effect/rpc/Ack",
          interruptMethod: "@effect/rpc/Interrupt"
        }
      }
      methods.push(method)
    })
  }
  return spec
}

interface Contract {
  readonly rpc: Rpc.AnyWithProps
  readonly payload: number
  readonly result: number
  readonly errorSchema: Schema.Constraint
  readonly hasPayload: boolean
  paramStructure: OpenRPCMethod["paramStructure"]
  parameters?: number | undefined
  readonly stream?: { item: number; chunk: number; error: number; cause: number } | undefined
}

// Void and Undefined encode to the same JSON representation as Null, so the
// absence of parameters is decided on the encoded AST.
function hasPayload(ast: SchemaAST.AST): boolean {
  const seen = new Set<SchemaAST.AST>()
  let encoded = SchemaAST.getLastEncoding(ast)
  while (encoded._tag === "Suspend") {
    if (seen.has(encoded)) throw new Error("cyclic schema root cannot be resolved")
    seen.add(encoded)
    encoded = SchemaAST.getLastEncoding(encoded.thunk())
  }
  return encoded._tag !== "Void" && encoded._tag !== "Undefined"
}

function compileSchemas(representation: SchemaRepresentation.MultiDocument): JsonSchema.Document<"draft-07"> {
  // Relocate while the document is still Draft 2020-12, then lower to Draft 7.
  const relocated = JsonSchema.toMultiDocumentComponents(
    InternalToJsonSchemaDocument.toJsonSchemaMultiDocument(representation, { onExcessProperty: "error" }),
    { target: "OpenRPC" }
  )
  return JsonSchema.toDocumentDraft07WithDefinitionsPath({
    dialect: "draft-2020-12",
    schema: { anyOf: relocated.schemas },
    definitions: relocated.definitions
  }, ["components", "schemas"])
}

function withMethod<A>(name: string, f: () => A): A {
  try {
    return f()
  } catch (cause) {
    throw new Error(
      `OpenRpc: method ${JSON.stringify(name)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause: cause }
    )
  }
}

function resolveRepresentation(
  representation: SchemaRepresentation.Representation,
  references: SchemaRepresentation.References,
  seen = new Set<SchemaRepresentation.Representation>()
): Exclude<SchemaRepresentation.Representation, SchemaRepresentation.Reference | SchemaRepresentation.Suspend> {
  if (seen.has(representation)) throw new Error("cyclic schema root cannot be resolved")
  seen.add(representation)
  switch (representation._tag) {
    case "Reference":
      if (!Object.hasOwn(references, representation.$ref)) throw new Error(`unresolved schema ${representation.$ref}`)
      return resolveRepresentation(references[representation.$ref], references, seen)
    case "Suspend":
      return resolveRepresentation(representation.thunk, references, seen)
    default:
      return representation
  }
}

function parameterStructure(
  input: SchemaRepresentation.Representation,
  references: SchemaRepresentation.References,
  seen = new Set<SchemaRepresentation.Representation>()
): OpenRPCMethod["paramStructure"] {
  const payload = resolveRepresentation(input, references)
  switch (payload._tag) {
    case "Objects":
      return "by-name"
    case "Arrays":
      return "by-position"
    case "Never":
      return "either"
    case "Union": {
      if (seen.has(payload)) throw new Error("cyclic payload root cannot be resolved")
      seen.add(payload)
      let structure: OpenRPCMethod["paramStructure"] | undefined
      for (const member of payload.types) {
        const next = parameterStructure(member, references, seen)
        structure = structure === undefined || structure === next ? next : "either"
      }
      seen.delete(payload)
      return structure ?? "either"
    }
    default:
      throw new Error("payload must be an object or array of parameters")
  }
}

function resolveSchema(
  schema: JsonSchema.JsonSchema,
  components: Record<string, JsonSchema.JsonSchema>
): JsonSchema.JsonSchema | undefined {
  const seen = new Set<JsonSchema.JsonSchema>()
  const prefix = "#/components/schemas/"
  while (typeof schema.$ref === "string") {
    if (seen.has(schema) || !schema.$ref.startsWith(prefix)) return undefined
    seen.add(schema)
    const name = decodeURIComponent(schema.$ref.slice(prefix.length)).replace(/~1/g, "/").replace(/~0/g, "~")
    if (!Object.hasOwn(components, name)) return undefined
    schema = components[name]
  }
  return schema
}

function descriptor(
  name: string,
  schema: JsonSchema.JsonSchema,
  components: Record<string, JsonSchema.JsonSchema>
): OpenRPCContentDescriptor {
  const metadata = resolveSchema(schema, components) ?? {}
  return {
    name,
    schema,
    ...(typeof metadata.title === "string" ? { summary: metadata.title } : undefined),
    ...(typeof metadata.description === "string" ? { description: metadata.description } : undefined),
    ...(typeof metadata.deprecated === "boolean" ? { deprecated: metadata.deprecated } : undefined)
  }
}

function literalValues(
  input: SchemaRepresentation.Representation,
  references: SchemaRepresentation.References,
  seen = new Set<SchemaRepresentation.Representation>()
): ReadonlyArray<unknown> | undefined {
  if (seen.has(input)) return undefined
  const node = resolveRepresentation(input, references)
  switch (node._tag) {
    case "Never":
      return []
    case "Null":
      return [null]
    case "Literal":
      return [node.literal]
    case "Enum":
      return node.enums.map(([, value]) => value)
    case "Union": {
      seen.add(input)
      try {
        const values: Array<unknown> = []
        for (const child of node.types) {
          const literals = literalValues(child, references, seen)
          if (literals === undefined) return undefined
          values.push(...literals)
        }
        return values
      } finally {
        seen.delete(input)
      }
    }
    default:
      return undefined
  }
}

function deriveErrors(schema: Schema.Constraint): Array<OpenRPCError> {
  // Mirrors the JSON-RPC serializer: `Number(error.code)`, defaulting to 0, and `error.message`.
  const errors = new Map<number, string>()
  const document = InternalToRepresentation.toRepresentation(InternalToCodec.toCodecJsonAST(schema.ast))
  const seen = new Set<SchemaRepresentation.Representation>()
  function visit(input: SchemaRepresentation.Representation): void {
    if (seen.has(input)) return
    seen.add(input)
    const node = resolveRepresentation(input, document.references)
    if (node._tag === "Union") {
      node.types.forEach(visit)
      return
    }
    if (node._tag !== "Objects") return
    const code = node.propertySignatures.find((property) => property.name === "code")
    const message = node.propertySignatures.find((property) => property.name === "message")
    if (message === undefined || message.isOptional) return
    const messages = literalValues(message.type, document.references)
    if (messages?.length !== 1 || typeof messages[0] !== "string") return
    const codes = code === undefined
      ? node.indexSignatures.length > 0 ? undefined : [0]
      : literalValues(code.type, document.references)
    for (const value of codes ?? []) {
      const number = Number(value)
      if (Number.isInteger(number) && !errors.has(number)) errors.set(number, messages[0])
    }
    if (code?.isOptional && !errors.has(0)) errors.set(0, messages[0])
  }
  visit(document.representation)
  return Array.from(errors, ([code, message]) => ({ code, message }))
}
