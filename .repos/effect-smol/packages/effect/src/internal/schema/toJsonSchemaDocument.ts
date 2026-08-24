import * as Arr from "../../Array.ts"
import { escapeToken } from "../../JsonPointer.ts"
import type * as JsonSchema from "../../JsonSchema.ts"
import * as RegEx from "../../RegExp.ts"
import type * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import type * as SchemaRepresentation from "../../SchemaRepresentation.ts"
import { errorWithPath } from "../errors.ts"
import * as InternalRecord from "../record.ts"
import * as InternalAnnotations from "./annotations.ts"

type Path = ReadonlyArray<string | number>
type CheckRepresentationAnnotation = SchemaRepresentation.CheckRepresentationAnnotation<
  SchemaRepresentation.Representation
>

const jsonSchemaAnnotationExcludedKeys = new Set([
  ...InternalAnnotations.annotationExcludedKeys,
  InternalAnnotations.IDENTIFIER_FALLBACK_KEY,
  ...InternalAnnotations.jsonSchemaAnnotationKeys
])

function collectJsonSchemaAnnotations(
  annotations: Schema.Annotations.Annotations | undefined,
  options: Schema.ToJsonSchemaOptions | undefined
): JsonSchema.JsonSchema | undefined {
  if (annotations === undefined) return undefined

  const out: JsonSchema.JsonSchema = {}
  const title = annotations.title
  if (typeof title === "string") out.title = title
  const description = annotations.description
  const expected = annotations.expected
  if (typeof description === "string") out.description = description
  else if (options?.generateDescriptions === true && typeof expected === "string") out.description = expected

  const defaultValue = annotations.default
  if (SchemaAST.isJson(defaultValue)) out.default = defaultValue
  const examples = annotations.examples
  if (Array.isArray(examples) && SchemaAST.isJson(examples)) out.examples = examples
  const readOnly = annotations.readOnly
  if (typeof readOnly === "boolean") out.readOnly = readOnly
  const writeOnly = annotations.writeOnly
  if (typeof writeOnly === "boolean") out.writeOnly = writeOnly
  const format = annotations.format
  if (typeof format === "string") out.format = format
  const contentEncoding = annotations.contentEncoding
  if (typeof contentEncoding === "string") out.contentEncoding = contentEncoding
  const contentMediaType = annotations.contentMediaType
  if (typeof contentMediaType === "string") out.contentMediaType = contentMediaType
  const contentSchema = annotations.contentSchema
  if (SchemaAST.isJson(contentSchema)) out.contentSchema = contentSchema

  if (options?.includeAnnotationKey !== undefined) {
    for (const [key, value] of Object.entries(annotations)) {
      if (
        jsonSchemaAnnotationExcludedKeys.has(key) ||
        !options.includeAnnotationKey(key)
      ) {
        continue
      }
      if (SchemaAST.isJson(value)) InternalRecord.assignProperty(out, key, value)
    }
  }

  return Object.keys(out).length === 0 ? undefined : out
}

type JsonSchemaNumberType = "number" | "integer"

function extractJsonSchemaNumberType(schema: JsonSchema.JsonSchema): {
  readonly type: JsonSchemaNumberType | undefined
  readonly schema: JsonSchema.JsonSchema
} {
  let type: JsonSchemaNumberType | undefined = schema.type === "number" || schema.type === "integer"
    ? schema.type
    : undefined
  let out = schema
  if (type !== undefined) {
    out = { ...schema }
    delete out.type
  }
  if (Array.isArray(out.allOf)) {
    const members: Array<JsonSchema.JsonSchema> = []
    let changed = false
    for (const member of out.allOf) {
      const extracted = extractJsonSchemaNumberType(member)
      if (extracted.type !== undefined) {
        changed = true
        if (type === undefined || extracted.type === "integer") type = extracted.type
      }
      if (Object.keys(extracted.schema).length > 0) members.push(extracted.schema)
    }
    if (changed) {
      const { allOf: _, ...rest } = out
      out = members.length === 0 ? rest : { ...rest, allOf: members }
    }
  }
  return { type, schema: out }
}

function isJsonSchemaNumberEncoding(schema: JsonSchema.JsonSchema): boolean {
  return Array.isArray(schema.anyOf) && schema.anyOf.length === 4 && schema.anyOf[0]?.type === "number" &&
    schema.anyOf.slice(1).every((member) => member.type === "string")
}

function appendJsonSchema(
  left: JsonSchema.JsonSchema,
  right: JsonSchema.JsonSchema
): JsonSchema.JsonSchema {
  if (Object.keys(left).length === 0) return right
  const rightKeys = Object.keys(right)
  if (rightKeys.length === 0) return left
  const leftType = left.type === "number" || left.type === "integer" ? left.type : undefined
  const isNumberEncoding = isJsonSchemaNumberEncoding(left)
  if (leftType !== undefined || isNumberEncoding) {
    const extracted = extractJsonSchemaNumberType(right)
    if (extracted.type !== undefined) {
      const type = leftType === "integer" || extracted.type === "integer" ? "integer" : "number"
      const base: JsonSchema.JsonSchema = { ...left, type }
      if (isNumberEncoding) delete base.anyOf
      return Object.keys(extracted.schema).length === 0 ? base : appendJsonSchema(base, extracted.schema)
    }
  }
  const members = Array.isArray(right.allOf) && rightKeys.length === 1 ? right.allOf : [right]
  if (Array.isArray(left.allOf)) {
    return { ...left, allOf: [...left.allOf, ...members] }
  }
  if (typeof left.$ref === "string") {
    return { allOf: [left, ...members] }
  }
  return { ...left, allOf: members }
}

function compileJsonSchema(
  representations: readonly [
    SchemaRepresentation.Representation,
    ...Array<SchemaRepresentation.Representation>
  ],
  rootPaths: ReadonlyArray<Path>,
  references: SchemaRepresentation.References,
  options: Schema.ToJsonSchemaOptions | undefined
): JsonSchema.MultiDocument<"draft-2020-12"> {
  const definitions: Record<string, JsonSchema.JsonSchema> = {}
  for (const key of Object.keys(references)) {
    InternalRecord.assignProperty(definitions, key, recur(references[key], ["references", key]))
  }
  const schemas = Arr.map(representations, (representation, index) => recur(representation, rootPaths[index]))
  return { dialect: "draft-2020-12", schemas, definitions }

  function annotationSchemas(
    representation: CheckRepresentationAnnotation | undefined,
    path: Path
  ): ReadonlyArray<JsonSchema.JsonSchema> {
    return representation?.schemas?.map((schema, index) => recur(schema, [...path, "schemas", index])) ?? []
  }

  function compileCheck(
    check: SchemaRepresentation.Check,
    type: JsonSchema.Type | undefined,
    path: Path
  ): JsonSchema.JsonSchema | undefined {
    const annotations = check.annotations
    const callback = annotations?.toJsonSchema
    if (callback !== undefined) {
      const schemas = annotationSchemas(check.representation, [...path, "representation"])
      const fragment = (callback as SchemaRepresentation.ToJsonSchema.Check)({ type, schemas })
      const ordinary = collectJsonSchemaAnnotations(annotations, options)
      return ordinary === undefined ? fragment : { ...fragment, ...ordinary }
    }
    if (check._tag === "Filter") return undefined

    const children = check.checks
      .map((child, index) => compileCheck(child, type, [...path, "checks", index]))
      .filter((child): child is JsonSchema.JsonSchema => child !== undefined)
    if (children.length === 0) return undefined
    const ordinary = collectJsonSchemaAnnotations(annotations, options)
    return ordinary === undefined ? { allOf: children } : { allOf: children, ...ordinary }
  }

  function recur(
    representation: SchemaRepresentation.Representation,
    path: Path
  ): JsonSchema.JsonSchema {
    if (representation._tag === "Reference") {
      if (!Object.hasOwn(references, representation.$ref)) {
        throw errorWithPath(`Invalid reference ${representation.$ref}`, [...path, "$ref"])
      }
      return { $ref: `#/$defs/${escapeToken(representation.$ref)}` }
    }

    let output = on(representation, path)
    const ordinary = collectJsonSchemaAnnotations(representation.annotations, options)
    if (ordinary !== undefined) {
      output = { ...output, ...ordinary }
    }
    for (let index = 0; index < representation.checks.length; index++) {
      const type = typeof output.type === "string" && isJsonSchemaType(output.type) ? output.type : undefined
      const check = compileCheck(representation.checks[index], type, [...path, "checks", index])
      if (check !== undefined) {
        output = appendJsonSchema(output, check)
      }
    }
    return output
  }

  function on(
    representation: Exclude<SchemaRepresentation.Representation, SchemaRepresentation.Reference>,
    path: Path
  ): JsonSchema.JsonSchema {
    switch (representation._tag) {
      case "Any":
      case "Unknown":
        return {}
      case "ObjectKeyword":
        return { anyOf: [{ type: "object" }, { type: "array" }] }
      case "Void":
      case "Undefined":
      case "Null":
        return { type: "null" }
      case "BigInt":
        return { type: "string", allOf: [{ pattern: "^-?\\d+$" }] }
      case "Symbol":
      case "UniqueSymbol":
        return { type: "string", allOf: [{ pattern: "^Symbol\\((.*)\\)$" }] }
      case "Declaration": {
        return {}
      }
      case "Suspend":
        return recur(representation.thunk, [...path, "thunk"])
      case "Never":
        return { not: {} }
      case "String":
        return { type: "string" }
      case "Number":
        return {
          anyOf: [
            { type: "number" },
            { type: "string", enum: ["NaN"] },
            { type: "string", enum: ["Infinity"] },
            { type: "string", enum: ["-Infinity"] }
          ]
        }
      case "Boolean":
        return { type: "boolean" }
      case "Literal": {
        const literal = representation.literal
        return typeof literal === "bigint"
          ? { type: "string", enum: [globalThis.String(literal)] }
          : { type: typeof literal, enum: [literal] }
      }
      case "Enum": {
        const types = representation.enums.map(([title, literal]) =>
          typeof literal === "number" && !globalThis.Number.isFinite(literal)
            ? { type: "string", enum: [globalThis.String(literal)], title }
            : { type: typeof literal, enum: [literal], title }
        )
        return types.length === 0 ? { not: {} } : { anyOf: types }
      }
      case "TemplateLiteral":
        return { type: "string", pattern: `^${representation.parts.map(getPartPattern).join("")}$` }
      case "Arrays": {
        if (representation.rest.length > 1) {
          throw errorWithPath("Invalid schema representation document", [...path, "rest"])
        }
        const out: JsonSchema.JsonSchema = { type: "array" }
        let minItems = representation.elements.length
        const prefixItems = representation.elements.map((element, index) => {
          if (element.isOptional) minItems--
          const compiled = recur(element.type, [...path, "elements", index, "type"])
          const annotations = collectJsonSchemaAnnotations(element.annotations, options)
          return annotations === undefined ? compiled : appendJsonSchema(compiled, annotations)
        })
        if (prefixItems.length > 0) {
          out.prefixItems = prefixItems
          out.maxItems = representation.elements.length
          if (minItems > 0) out.minItems = minItems
        } else {
          out.items = false
        }
        if (representation.rest.length === 1) {
          delete out.maxItems
          const rest = recur(representation.rest[0], [...path, "rest", 0])
          if (Object.keys(rest).length > 0) out.items = rest
          else delete out.items
        }
        return out
      }
      case "Objects": {
        if (representation.propertySignatures.length === 0 && representation.indexSignatures.length === 0) {
          return { anyOf: [{ type: "object" }, { type: "array" }] }
        }
        const out: JsonSchema.JsonSchema = { type: "object" }
        const properties: Record<string, JsonSchema.JsonSchema> = {}
        const required: Array<string> = []
        for (let index = 0; index < representation.propertySignatures.length; index++) {
          const property = representation.propertySignatures[index]
          if (typeof property.name !== "string") {
            throw errorWithPath("Invalid schema representation document", [
              ...path,
              "propertySignatures",
              index,
              "name"
            ])
          }
          const name = property.name
          const compiled = recur(property.type, [...path, "propertySignatures", index, "type"])
          const annotations = collectJsonSchemaAnnotations(property.annotations, options)
          InternalRecord.assignProperty(
            properties,
            name,
            annotations === undefined ? compiled : appendJsonSchema(compiled, annotations)
          )
          if (!property.isOptional) required.push(name)
        }
        if (representation.propertySignatures.length > 0) out.properties = properties
        if (required.length > 0) out.required = required
        out.additionalProperties = options?.additionalProperties ?? false
        const patternProperties: Record<string, JsonSchema.JsonSchema | false> = {}
        for (let index = 0; index < representation.indexSignatures.length; index++) {
          const signature = representation.indexSignatures[index]
          let type: JsonSchema.JsonSchema | false = recur(
            signature.type,
            [...path, "indexSignatures", index, "type"]
          )
          if (Object.keys(type).length === 1 && "not" in type) type = false
          const patterns = getParameterPatterns(
            signature.parameter,
            [...path, "indexSignatures", index, "parameter"],
            new Set()
          )
          if (patterns.length === 0) {
            out.additionalProperties = type
          } else {
            for (const pattern of patterns) InternalRecord.assignProperty(patternProperties, pattern, type)
          }
        }
        if (Object.keys(patternProperties).length > 0) {
          out.patternProperties = patternProperties
          delete out.additionalProperties
        }
        if (
          typeof out.additionalProperties === "object" &&
          out.additionalProperties !== null &&
          Object.keys(out.additionalProperties).length === 0
        ) {
          delete out.additionalProperties
        }
        return out
      }
      case "Union": {
        const types = representation.types.map((type, index) => recur(type, [...path, "types", index]))
        if (types.length === 0) return { not: {} }
        if (types.length > 1) {
          const compacted = compactEnums(types)
          if (compacted !== undefined) return compacted
        }
        return representation.mode === "anyOf" ? { anyOf: types } : { oneOf: types }
      }
    }
  }

  function getParameterPatterns(
    parameter: SchemaRepresentation.Representation,
    path: Path,
    seenReferences: ReadonlySet<string>
  ): ReadonlyArray<string> {
    switch (parameter._tag) {
      case "Reference": {
        if (!Object.hasOwn(references, parameter.$ref)) {
          throw errorWithPath(`Invalid reference ${parameter.$ref}`, [...path, "$ref"])
        }
        if (seenReferences.has(parameter.$ref)) return []
        const next = new Set(seenReferences).add(parameter.$ref)
        return getParameterPatterns(references[parameter.$ref], ["references", parameter.$ref], next)
      }
      case "String":
        return collectPatterns(recur(parameter, path))
      case "TemplateLiteral":
        return [`^${parameter.parts.map(getPartPattern).join("")}$`]
      case "Union":
        return parameter.types.flatMap((type, index) =>
          getParameterPatterns(type, [...path, "types", index], seenReferences)
        )
      default:
        throw errorWithPath("Invalid schema representation document", path)
    }
  }
}

function isJsonSchemaType(input: string): input is JsonSchema.Type {
  return input === "string" || input === "number" || input === "boolean" || input === "array" ||
    input === "object" || input === "null" || input === "integer"
}

function compactEnums(
  schemas: ReadonlyArray<JsonSchema.JsonSchema>
): JsonSchema.JsonSchema | undefined {
  let sharedType: unknown = undefined
  const values: Array<unknown> = []
  for (const schema of schemas) {
    const keys = Object.keys(schema)
    if (keys.length !== 2 || schema.type === undefined || !Array.isArray(schema.enum) || schema.enum.length === 0) {
      return undefined
    }
    if (sharedType === undefined) sharedType = schema.type
    else if (schema.type !== sharedType) return undefined
    values.push(...schema.enum)
  }
  return { type: sharedType, enum: values }
}

function collectPatterns(schema: JsonSchema.JsonSchema): ReadonlyArray<string> {
  const patterns: Array<string> = []
  if (typeof schema.pattern === "string") patterns.push(schema.pattern)
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const members = schema[key]
    if (Array.isArray(members)) {
      for (const member of members) {
        if (typeof member === "object" && member !== null && !Array.isArray(member)) {
          patterns.push(...collectPatterns(member))
        }
      }
    }
  }
  return patterns
}

function getPartPattern(part: SchemaRepresentation.Representation): string {
  switch (part._tag) {
    case "Literal":
      return RegEx.escape(globalThis.String(part.literal))
    case "String":
      return SchemaAST.STRING_PATTERN
    case "Number":
      return SchemaAST.FINITE_PATTERN
    case "TemplateLiteral":
      return part.parts.map(getPartPattern).join("")
    case "Union":
      return part.types.map(getPartPattern).join("|")
    default:
      throw errorWithPath("Invalid schema representation document", [])
  }
}

/** @internal */
export function toJsonSchemaDocument(
  document: SchemaRepresentation.Document,
  options?: Schema.ToJsonSchemaOptions
): JsonSchema.Document<"draft-2020-12"> {
  const output = compileJsonSchema(
    [document.representation],
    [["representation"]],
    document.references,
    options
  )
  return {
    dialect: output.dialect,
    schema: output.schemas[0],
    definitions: output.definitions
  }
}

/** @internal */
export function toJsonSchemaMultiDocument(
  document: SchemaRepresentation.MultiDocument,
  options?: Schema.ToJsonSchemaOptions
): JsonSchema.MultiDocument<"draft-2020-12"> {
  return compileJsonSchema(
    document.representations,
    document.representations.map((_, index) => ["representations", index]),
    document.references,
    options
  )
}
