import * as Arr from "../../Array.ts"
import * as Equal from "../../Equal.ts"
import { decodeUriFragment, formatUriFragmentToken, unescapeToken } from "../../JsonPointer.ts"
import type * as JsonSchema from "../../JsonSchema.ts"
import { rewriteRefs } from "../../JsonSchema.ts"
import * as RegEx from "../../RegExp.ts"
import type * as Schema from "../../Schema.ts"
import * as InternalAST from "../../SchemaAST.ts"
import type * as SchemaRepresentation from "../../SchemaRepresentation.ts"
import { errorWithPath } from "../errors.ts"
import * as InternalRecord from "../record.ts"
import * as InternalAnnotations from "./annotations.ts"

type Path = ReadonlyArray<string | number>
type CheckRepresentationAnnotation = SchemaRepresentation.CheckRepresentationAnnotation<
  SchemaRepresentation.Representation
>

function formatDefinitionReference(key: string): string {
  return `#/$defs/${formatUriFragmentToken(key)}`
}

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
  if (InternalAST.isJson(defaultValue)) out.default = defaultValue
  const examples = annotations.examples
  if (Array.isArray(examples) && InternalAST.isJson(examples)) out.examples = examples
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
  if (InternalAST.isJson(contentSchema)) out.contentSchema = contentSchema

  if (options?.includeAnnotationKey !== undefined) {
    for (const [key, value] of Object.entries(annotations)) {
      if (
        jsonSchemaAnnotationExcludedKeys.has(key) ||
        !options.includeAnnotationKey(key)
      ) {
        continue
      }
      if (InternalAST.isJson(value)) InternalRecord.assignProperty(out, key, value)
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
  if (!Array.isArray(schema.anyOf) || schema.anyOf.length !== 2 || schema.anyOf[0]?.type !== "number") return false
  const special = schema.anyOf[1]
  return special?.type === "string" && Array.isArray(special.enum) && special.enum.length === 3 &&
    special.enum.includes("NaN") && special.enum.includes("Infinity") && special.enum.includes("-Infinity")
}

// Keep this allowlist closed: applicators and dependent keywords can change meaning when moved across schema objects.
const inlineableCheckKeywords =
  "|type|format|pattern|multipleOf|minimum|maximum|exclusiveMinimum|exclusiveMaximum|minLength|maxLength|minItems|maxItems|uniqueItems|minProperties|maxProperties|propertyNames|"

function hasOnlyKeywords(schema: JsonSchema.JsonSchema, allowed: string): boolean {
  return Object.keys(schema).every((key) => allowed.includes(`|${key}|`))
}

function hasNoCollisions(left: JsonSchema.JsonSchema, rightKeys: ReadonlyArray<string>): boolean {
  return typeof left.$ref !== "string" && rightKeys.every((key) => !Object.hasOwn(left, key))
}

// `format` and `content*` can affect validation, so they are not treated as pure annotations.
const promotableAnnotationKeywords = "|title|description|default|examples|readOnly|writeOnly|"
const inlineableAnnotatedCheckKeywords = inlineableCheckKeywords + promotableAnnotationKeywords

function appendJsonSchema(
  left: JsonSchema.JsonSchema,
  right: JsonSchema.JsonSchema,
  inlineCheck?: true
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
      const extractedKeys = Object.keys(extracted.schema)
      if (extractedKeys.length === 0) return base
      return hasOnlyKeywords(extracted.schema, promotableAnnotationKeywords) &&
          hasNoCollisions(base, extractedKeys)
        ? { ...base, ...extracted.schema }
        : appendJsonSchema(base, extracted.schema, inlineCheck)
    }
  }
  if (inlineCheck && hasNoCollisions(left, rightKeys)) {
    return { ...left, ...right }
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
  // null = compiling, string = canonical key, object = compiled schema
  const definitionStates = new Map<string, JsonSchema.JsonSchema | string | null>()
  const compiledRepresentations = new WeakMap<SchemaRepresentation.Representation, JsonSchema.JsonSchema>()
  const fallbackDefinitions = new Map<string, Array<string>>()
  const referenceKeys = Object.keys(references)
  for (const key of referenceKeys) {
    compileDefinition(key, ["references", key])
  }
  const schemas = Arr.map(
    representations,
    (representation, index) => finalizeJsonSchema(recur(representation, rootPaths[index]))
  )
  const definitions: Record<string, JsonSchema.JsonSchema> = {}
  for (const key of referenceKeys) {
    const compiled = definitionStates.get(key)!
    if (typeof compiled !== "string") {
      InternalRecord.assignProperty(definitions, key, finalizeJsonSchema(compiled))
    }
  }
  return { dialect: "draft-2020-12", schemas, definitions }

  function compileDefinition(key: string, path: Path): string {
    const compiled = definitionStates.get(key)
    if (compiled !== undefined) return typeof compiled === "string" ? compiled : key
    if (!Object.hasOwn(references, key)) {
      throw errorWithPath(`Invalid reference ${key}`, [...path, "$ref"])
    }

    definitionStates.set(key, null)
    const representation = references[key]
    const schema = recur(representation, ["references", key])

    const fallback = getIdentifierFallback(representation)
    if (fallback !== undefined) {
      const candidates = fallbackDefinitions.get(fallback)
      const match = candidates?.find((candidate) => Equal.equals(definitionStates.get(candidate), schema))
      if (match === undefined) {
        if (candidates === undefined) fallbackDefinitions.set(fallback, [key])
        else candidates.push(key)
      } else {
        definitionStates.set(key, match)
        return match
      }
    }
    definitionStates.set(key, schema)
    return key
  }

  function finalizeJsonSchema(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
    return rewriteRefs(schema, ($ref) => {
      const pointer = decodeUriFragment($ref)
      if (pointer === undefined) {
        if (/^#(?:\/|%2f)/i.test($ref)) {
          throw new Error(`Invalid JSON Pointer URI fragment ${JSON.stringify($ref)}`)
        }
        return $ref
      }
      if (!pointer.startsWith("/$defs/")) return $ref
      const separator = pointer.indexOf("/", 7)
      const canonical = definitionStates.get(unescapeToken(pointer.slice(7, separator < 0 ? undefined : separator)))
      if (typeof canonical !== "string") return $ref
      // URI-encoded slashes separate pointer tokens; only ~1 represents a slash within a token.
      return $ref.replace(
        /^#(?:\/|%2f).*?(?:\/|%2f).*?(?=\/|%2f|$)/i,
        formatDefinitionReference(canonical)
      )
    })
  }

  function getIdentifierFallback(
    representation: SchemaRepresentation.Representation
  ): string | undefined {
    if (representation._tag === "Reference") return undefined
    const annotations = representation.checks.length === 0
      ? representation.annotations
      : representation.checks[representation.checks.length - 1].annotations
    return typeof annotations?.identifier !== "string" &&
        typeof annotations?.[InternalAnnotations.IDENTIFIER_FALLBACK_KEY] === "string"
      ? annotations[InternalAnnotations.IDENTIFIER_FALLBACK_KEY]
      : undefined
  }

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
  ): readonly [schema: JsonSchema.JsonSchema, inline?: true] | undefined {
    const annotations = check.annotations
    const callback = annotations?.toJsonSchema
    if (callback !== undefined) {
      const schemas = annotationSchemas(check.representation, [...path, "representation"])
      const fragment = (callback as SchemaRepresentation.ToJsonSchema.Check)({ type, schemas })
      const ordinary = collectJsonSchemaAnnotations(annotations, options)
      const schema = ordinary === undefined ? fragment : { ...fragment, ...ordinary }
      const allowed = ordinary === undefined ? inlineableCheckKeywords : inlineableAnnotatedCheckKeywords
      return check._tag === "Filter" &&
          hasOnlyKeywords(schema, allowed) &&
          (ordinary === undefined || hasOnlyKeywords(ordinary, promotableAnnotationKeywords))
        ? [schema, true]
        : [schema]
    }
    if (check._tag === "Filter") return undefined

    const children = check.checks
      .map((child, index) => compileCheck(child, type, [...path, "checks", index]))
      .filter((child): child is NonNullable<typeof child> => child !== undefined)
    if (children.length === 0) return undefined
    const ordinary = collectJsonSchemaAnnotations(annotations, options)
    const allOf = children.map(([schema]) => schema)
    return [ordinary === undefined ? { allOf } : { allOf, ...ordinary }]
  }

  function recur(
    representation: SchemaRepresentation.Representation,
    path: Path
  ): JsonSchema.JsonSchema {
    if (representation._tag === "Reference") {
      const canonical = compileDefinition(representation.$ref, path)
      return { $ref: formatDefinitionReference(canonical) }
    }
    const cached = compiledRepresentations.get(representation)
    if (cached !== undefined) return cached

    let output = on(representation, path)
    const ordinary = collectJsonSchemaAnnotations(representation.annotations, options)
    if (ordinary !== undefined) {
      output = { ...output, ...ordinary }
    }
    for (let index = 0; index < representation.checks.length; index++) {
      const type = typeof output.type === "string" && isJsonSchemaType(output.type) ? output.type : undefined
      const check = compileCheck(representation.checks[index], type, [...path, "checks", index])
      if (check !== undefined) {
        output = appendJsonSchema(output, ...check)
      }
    }
    compiledRepresentations.set(representation, output)
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
        return { type: "string", allOf: [{ pattern: "^Symbol\\(([\\s\\S]*)\\)$" }] }
      case "UniqueSymbol":
        return globalThis.Symbol.keyFor(representation.symbol) === undefined
          ? { not: {} }
          : { type: "string", enum: [globalThis.String(representation.symbol)] }
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
            { type: "string", enum: ["NaN", "Infinity", "-Infinity"] }
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
        const types = representation.enums.map(([title, literal], index) => {
          if (typeof literal === "number" && !globalThis.Number.isFinite(literal)) {
            throw errorWithPath(
              `Invalid numeric enum value ${globalThis.String(literal)}`,
              [...path, "enums", index, 1]
            )
          }
          return { type: typeof literal, enum: [literal], title }
        })
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
          return { not: { type: "null" } }
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
        const patternProperties: Record<string, JsonSchema.JsonSchema | false> = {}
        const additionalPropertySchemas: Array<JsonSchema.JsonSchema | false> = []
        const indexValueSchemas: Array<JsonSchema.JsonSchema | false> = []
        let hasUnrepresentableIndexPattern = false
        for (let index = 0; index < representation.indexSignatures.length; index++) {
          const signature = representation.indexSignatures[index]
          let type: JsonSchema.JsonSchema | false = recur(
            signature.type,
            [...path, "indexSignatures", index, "type"]
          )
          if (Equal.equals(type, { not: {} })) type = false
          indexValueSchemas.push(type)
          const patterns = getParameterPatterns(
            signature.parameter,
            [...path, "indexSignatures", index, "parameter"],
            new Set()
          )
          if (patterns === undefined) {
            hasUnrepresentableIndexPattern = true
            continue
          }
          if (patterns.length === 0) {
            additionalPropertySchemas.push(type)
          } else {
            for (const pattern of patterns) {
              const previous = patternProperties[pattern]
              InternalRecord.assignProperty(
                patternProperties,
                pattern,
                previous === undefined
                  ? type
                  : previous === false || type === false
                  ? false
                  : appendJsonSchema(previous, type)
              )
            }
          }
        }
        const hasPatternProperties = Object.keys(patternProperties).length > 0
        if (hasPatternProperties) {
          out.patternProperties = patternProperties
        }
        if (hasUnrepresentableIndexPattern && options?.onExcessProperty === "error") {
          const propertyNames: Array<JsonSchema.JsonSchema> = []
          if (representation.propertySignatures.length > 0) {
            propertyNames.push({ enum: Object.keys(properties) })
          }
          for (let index = 0; index < representation.indexSignatures.length; index++) {
            propertyNames.push(
              recur(
                representation.indexSignatures[index].parameter,
                [...path, "indexSignatures", index, "parameter"]
              )
            )
          }
          out.propertyNames = propertyNames.length === 1 ? propertyNames[0] : { anyOf: propertyNames }
          out.additionalProperties = indexValueSchemas.length === 1
            ? indexValueSchemas[0]
            : { anyOf: indexValueSchemas }
          if (additionalPropertySchemas.length > 0) {
            out.allOf = additionalPropertySchemas.map((type) => ({ type: "object", additionalProperties: type }))
          }
        } else if (additionalPropertySchemas.length === 0) {
          out.additionalProperties = hasUnrepresentableIndexPattern || options?.onExcessProperty !== "error"
        } else if (
          additionalPropertySchemas.length === 1 &&
          representation.propertySignatures.length === 0 &&
          !hasPatternProperties
        ) {
          out.additionalProperties = additionalPropertySchemas[0]
        } else if (additionalPropertySchemas.length > 0) {
          out.allOf = additionalPropertySchemas.map((type) => ({ type: "object", additionalProperties: type }))
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
        const mode = representation.options?.mode ?? "anyOf"
        if (mode === "anyOf" && types.length > 1) {
          const compacted = compactEnums(types)
          if (compacted !== undefined) return compacted
        }
        return mode === "anyOf" ? { anyOf: types } : { oneOf: types }
      }
    }
  }

  function getParameterPatterns(
    parameter: SchemaRepresentation.Representation,
    path: Path,
    seenReferences: ReadonlySet<string>
  ): ReadonlyArray<string> | undefined {
    switch (parameter._tag) {
      case "Reference": {
        if (!Object.hasOwn(references, parameter.$ref)) {
          throw errorWithPath(`Invalid reference ${parameter.$ref}`, [...path, "$ref"])
        }
        compileDefinition(parameter.$ref, path)
        if (seenReferences.has(parameter.$ref)) return undefined
        const next = new Set(seenReferences).add(parameter.$ref)
        return getParameterPatterns(references[parameter.$ref], ["references", parameter.$ref], next)
      }
      case "String": {
        if (parameter.checks.length === 0) return []
        if (
          parameter.checks.length !== 1 ||
          parameter.checks[0]._tag !== "Filter" ||
          parameter.checks[0].annotations?.toJsonSchema === undefined
        ) {
          return undefined
        }
        const schema = recur(parameter, path)
        return schema.type === "string" && typeof schema.pattern === "string" &&
            hasOnlyKeywords(schema, "|type|pattern|title|description|default|examples|readOnly|writeOnly|")
          ? [schema.pattern]
          : undefined
      }
      case "TemplateLiteral":
        return parameter.checks.length === 0 ? [`^${parameter.parts.map(getPartPattern).join("")}$`] : undefined
      case "Union": {
        if (parameter.types.length === 0 || parameter.checks.length > 0 || parameter.options?.mode === "oneOf") {
          return undefined
        }
        const patterns: Array<string> = []
        for (let index = 0; index < parameter.types.length; index++) {
          const memberPatterns = getParameterPatterns(parameter.types[index], [...path, "types", index], seenReferences)
          if (memberPatterns === undefined) return undefined
          if (memberPatterns.length === 0) return []
          patterns.push(...memberPatterns)
        }
        return patterns
      }
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
    for (const value of schema.enum) {
      if (values.includes(value)) return undefined
      values.push(value)
    }
  }
  return { type: sharedType, enum: values }
}

function getPartPattern(part: SchemaRepresentation.Representation): string {
  switch (part._tag) {
    case "Literal":
      return RegEx.escape(globalThis.String(part.literal))
    case "String":
      return InternalAST.STRING_PATTERN
    case "Number":
      return InternalAST.FINITE_PATTERN
    case "TemplateLiteral":
      return part.parts.map(getPartPattern).join("")
    case "Union":
      return `(?:${part.types.map(getPartPattern).join("|")})`
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
