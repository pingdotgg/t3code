/**
 * Generate TypeScript source for JSON Schema declarations extracted from
 * OpenAPI documents.
 *
 * This module is the schema-rendering stage of the OpenAPI generator. Callers
 * register named OpenAPI 3.0 or 3.1 schemas, provide the reusable component
 * definitions for the document, and receive source text containing exported
 * TypeScript aliases plus Effect Schema runtime values. The generator first
 * normalizes OpenAPI-specific schema shapes into Effect's JSON Schema model,
 * then registers schema declarations in a shared `Codegen` module.
 *
 * The renderer keeps the emitted module usable for both human maintainers and
 * automated code-generation consumers by emitting reusable references in
 * construction order before locally registered schemas. It also contains the
 * HttpApi-specific multipart file substitutions that map generated schemas to
 * Effect's multipart runtime types.
 *
 * @since 4.0.0
 */
import * as Arr from "effect/Array"
import * as Codegen from "effect/Codegen"
import * as JsonSchema from "effect/JsonSchema"
import * as Option from "effect/Option"
import * as Rec from "effect/Record"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"

type Source = "openapi-3.0" | "openapi-3.1"
interface GenerateOptions {
  readonly onEnter?: ((js: JsonSchema.JsonSchema) => JsonSchema.JsonSchema) | undefined
  readonly multipartSchemaRefs?: MultipartSchemaRefs | undefined
  readonly binarySchemas?: ReadonlySet<string> | undefined
  readonly includeSchemas?: ReadonlyArray<string> | undefined
  /**
   * Closes objects with declared properties when every contributing object schema omits `additionalProperties`.
   *
   * @stability experimental
   */
  readonly closeObjects?: boolean | undefined
}

interface HttpApiMultipartSchemaRefs {
  readonly kind: "httpapi"
  readonly singleFile: string
  readonly files: string
}

type MultipartSchemaRefs = HttpApiMultipartSchemaRefs | { readonly kind: "client"; readonly singleFile: string }

/**
 * Create a stateful JSON Schema code generator for OpenAPI-derived schemas.
 *
 * **Details**
 *
 * Schemas registered with the returned generator are converted into TypeScript
 * type aliases and Effect Schema runtime declarations, with reusable OpenAPI
 * component definitions supplied at generation time.
 *
 * @category code generation
 * @since 4.0.0
 */
export function make() {
  const store = Object.create(null) as Record<string, JsonSchema.JsonSchema>

  function addSchema(name: string, schema: JsonSchema.JsonSchema): string {
    if (Object.hasOwn(store, name)) {
      throw new Error(`Schema ${name} already exists`)
    }
    store[name] = schema
    return name
  }

  function generate(
    source: Source,
    components: JsonSchema.Definitions,
    typeOnly: boolean,
    options?: GenerateOptions
  ) {
    const module = new Codegen.Module()
    module.provideImport({
      module: "effect/Schema",
      kind: "Namespace",
      imported: "*",
      local: "Schema",
      typeOnly: false,
      attributes: ""
    })
    compile(module, store, source, components, typeOnly, options)
    const output = module.finalize()
    return render([...output.imports, ...output.declarations.flatMap((declaration) => declaration.fragments)])
  }

  function generateHttpApi(
    source: Source,
    components: JsonSchema.Definitions,
    options?: GenerateOptions
  ) {
    return generate(source, components, false, options)
  }

  return {
    addSchema,
    generate,
    generateHttpApi,
    schemas: store as Readonly<Record<string, JsonSchema.JsonSchema>>
  } as const
}

/** @internal */
export function compile(
  module: Codegen.Module,
  schemas: Readonly<Record<string, JsonSchema.JsonSchema>>,
  source: Source,
  components: JsonSchema.Definitions,
  typeOnly: boolean,
  options?: GenerateOptions
): ReadonlyMap<string, Codegen.Binding> {
  const prepared = prepareSchemas(schemas, source, components, options)
  if (prepared === undefined) return new Map()
  return module.addSchemas(prepared.schemas, {
    references: prepared.references,
    typeOnly
  })
}

function prepareSchemas(
  store: Readonly<Record<string, JsonSchema.JsonSchema>>,
  source: Source,
  components: JsonSchema.Definitions,
  options?: GenerateOptions
): {
  readonly schemas: Readonly<Record<string, SchemaRepresentation.Representation>>
  readonly references: SchemaRepresentation.References
} | undefined {
  const names: Array<string> = []
  const schemas: Array<JsonSchema.JsonSchema> = []

  const definitions: JsonSchema.Definitions = Rec.map(
    components,
    (js) => fromSchemaOpenApi(source, js).schema
  )

  for (const [name, js] of Object.entries(store)) {
    names.push(name)
    schemas.push(fromSchemaOpenApi(source, js).schema)
  }
  // Unnamed roots, so included components are emitted as definitions without an alias
  for (const name of options?.includeSchemas ?? []) {
    if (!Object.hasOwn(components, name)) {
      throw new Error(`Included schema ${name} is not a component`)
    }
    schemas.push(fromSchemaOpenApi(source, { $ref: `#/components/schemas/${name}` }).schema)
  }

  if (!Arr.isArrayNonEmpty(schemas)) {
    return
  }

  const document = {
    dialect: "draft-2020-12" as const,
    schemas,
    definitions
  }
  const schemasWithExamples: Array<JsonSchema.JsonSchema> = []
  const preparedSchemas = new WeakMap<JsonSchema.JsonSchema, JsonSchema.JsonSchema>()
  const preparedOutputs = new WeakSet<JsonSchema.JsonSchema>()
  const importerOptions: SchemaRepresentation.FromJsonSchemaOptions = {
    patterns: "apply",
    closeObjects: options?.closeObjects,
    onEnter(js: JsonSchema.JsonSchema) {
      if (preparedOutputs.has(js)) return js
      const cached = preparedSchemas.get(js)
      if (cached !== undefined) return cached

      const out = { ...js }
      const transformed = { ...(options?.onEnter === undefined ? out : options.onEnter(out)) }
      preparedSchemas.set(js, transformed)
      preparedOutputs.add(transformed)
      if (Array.isArray(transformed.examples)) {
        schemasWithExamples.push(transformed)
      }
      return transformed
    }
  }
  let rootSchemas = SchemaRepresentation.fromJsonSchemaMultiDocument(document, importerOptions)
  if (Arr.isArrayNonEmpty(schemasWithExamples)) {
    const exampleSchemas = SchemaRepresentation.fromJsonSchemaMultiDocument(
      { ...document, schemas: schemasWithExamples },
      importerOptions
    )
    for (let i = 0; i < schemasWithExamples.length; i++) {
      const node = schemasWithExamples[i]
      const examples = node.examples as ReadonlyArray<unknown>
      const decode = Schema.decodeUnknownOption(Schema.toType(exampleSchemas[i]), { onExcessProperty: "error" })
      const validExamples = examples.filter((example) => Option.isSome(decode(example)))
      if (validExamples.length === examples.length) continue
      if (validExamples.length === 0) {
        delete node.examples
      } else {
        node.examples = validExamples
      }
    }
    rootSchemas = SchemaRepresentation.fromJsonSchemaMultiDocument(document, importerOptions)
  }
  // Binary transport bodies encode bytes, independently of their JSON Schema representation.
  // Only replace operation-local roots; shared components may also be used by JSON bodies.
  const representation = SchemaRepresentation.toRepresentations(Arr.map(
    rootSchemas,
    (schema, index) => options?.binarySchemas?.has(names[index]) ? Schema.Uint8Array.ast : schema.ast
  ))
  return {
    schemas: Object.fromEntries(names.map((name, index) => [
      name,
      multipartRepresentation(name, representation.representations[index], options?.multipartSchemaRefs)
    ])),
    references: Rec.map(
      representation.references,
      (schema, name) => multipartRepresentation(name, schema, options?.multipartSchemaRefs)
    )
  }
}

function fromSchemaOpenApi(source: Source, jsonSchema: JsonSchema.JsonSchema) {
  switch (source) {
    case "openapi-3.1":
      return JsonSchema.fromSchemaOpenApi3_1(jsonSchema)
    case "openapi-3.0":
      return JsonSchema.fromSchemaOpenApi3_0(jsonSchema)
  }
}

function multipartRepresentation(
  name: string | undefined,
  schema: SchemaRepresentation.Representation,
  refs: MultipartSchemaRefs | undefined
): SchemaRepresentation.Representation {
  if (name === undefined) return schema
  const code = multipartCode(name, refs)
  if (code === undefined) return schema
  return {
    _tag: "Declaration",
    typeParameters: [],
    checks: [],
    annotations: {
      toCode: () => ({
        ...code,
        importDeclarations: refs?.kind === "httpapi" ? ["import { Multipart } from \"effect/http\""] : []
      })
    }
  }
}

function multipartCode(
  $ref: string,
  refs: MultipartSchemaRefs | undefined
): SchemaRepresentation.Code | undefined {
  if (refs === undefined) {
    return undefined
  }
  if ($ref === refs.singleFile) {
    return refs.kind === "httpapi"
      ? { Type: "Multipart.PersistedFile", runtime: "Multipart.SingleFileSchema" }
      : {
        Type: "globalThis.File | globalThis.Blob",
        runtime: `Schema.instanceOf(globalThis.Blob, { expected: "File | Blob" })`
      }
  }
  if (refs.kind === "httpapi" && $ref === refs.files) {
    return { Type: "ReadonlyArray<Multipart.PersistedFile>", runtime: "Multipart.FilesSchema" }
  }
  return undefined
}

function render(as: ReadonlyArray<string>) {
  if (as.length === 0) return ""
  return as.join("\n") + "\n"
}
