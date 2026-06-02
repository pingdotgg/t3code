import * as Arr from "../../Array.ts"
import * as Equal from "../../Equal.ts"
import { format } from "../../Formatter.ts"
import { escapeToken } from "../../JsonPointer.ts"
import type * as JsonSchema from "../../JsonSchema.ts"
import * as Predicate from "../../Predicate.ts"
import * as Rec from "../../Record.ts"
import * as RegEx from "../../RegExp.ts"
import type * as Schema from "../../Schema.ts"
import * as AST from "../../SchemaAST.ts"
import type * as SchemaRepresentation from "../../SchemaRepresentation.ts"
import * as InternalAnnotations from "./annotations.ts"
import * as InternalSchema from "./schema.ts"

/** @internal */
export function fromAST(ast: AST.AST): SchemaRepresentation.Document {
  const { references, representations: schemas } = fromASTs([ast])
  return { representation: schemas[0], references }
}

/** @internal */
export function fromASTs(asts: readonly [AST.AST, ...Array<AST.AST>]): SchemaRepresentation.MultiDocument {
  const references: Record<string, SchemaRepresentation.Representation> = {}

  const referenceMap = new Map<AST.AST, string>()
  const uniqueReferences = new Set<string>()
  const visiting = new Set<AST.AST>()

  const schemas = Arr.map(asts, (ast) => recur(ast))

  return {
    representations: schemas,
    references
  }

  function gen(prefix: string): string {
    let candidate = prefix
    let suffix = 0

    while (uniqueReferences.has(candidate)) {
      candidate = `${prefix}${++suffix}`
    }

    uniqueReferences.add(candidate)
    return candidate
  }

  function recur(ast: AST.AST, prefix?: string): SchemaRepresentation.Representation {
    const found = referenceMap.get(ast)
    if (found !== undefined) {
      return { _tag: "Reference", $ref: found }
    }

    const last = AST.getLastEncoding(ast)
    const identifier = InternalAnnotations.resolveIdentifier(ast) ?? prefix

    if (ast !== last) {
      return recur(last, identifier)
    }

    // Has identifier → always create reference
    if (identifier !== undefined) {
      const reference = gen(identifier)
      referenceMap.set(ast, reference)
      const out = on(ast)
      const found = references[identifier]
      // Reuse existing references when duplicate identifiers have the same representation
      if (found !== undefined && Equal.equals(out, found)) {
        referenceMap.set(ast, identifier)
        return { _tag: "Reference", $ref: identifier }
      }
      references[reference] = out
      return { _tag: "Reference", $ref: reference }
    }

    // Recursion detected → create reference
    if (visiting.has(ast)) {
      const reference = gen(`${ast._tag}_`)
      referenceMap.set(ast, reference)
      return { _tag: "Reference", $ref: reference }
    }

    // Normal case → inline
    visiting.add(ast)
    const out = on(ast)
    visiting.delete(ast)

    // A descendant triggered reference creation (recursion)
    const ref = referenceMap.get(ast)
    if (ref !== undefined) {
      references[ref] = out
      return { _tag: "Reference", $ref: ref }
    }

    return out
  }

  function getEncodedSchema(last: AST.Declaration): AST.AST {
    const getLink = last.annotations?.toCodecJson ?? last.annotations?.toCodec
    if (Predicate.isFunction(getLink)) {
      const tps = last.typeParameters.map((tp) => InternalSchema.make(AST.toEncoded(tp)))
      const link = getLink(tps)
      return AST.replaceEncoding(last, [link])
    }
    return AST.null
  }

  function on(last: AST.AST): SchemaRepresentation.Representation {
    const annotations = fromASTAnnotations(last.annotations)
    switch (last._tag) {
      case "Declaration": {
        // this must be executed before transforming the type parameters
        const encodedSchema = recur(getEncodedSchema(last))
        return {
          _tag: "Declaration",
          typeParameters: last.typeParameters.map((ast) => recur(ast)),
          encodedSchema,
          checks: fromASTChecks(last.checks),
          ...annotations
        }
      }
      case "Null":
      case "Undefined":
      case "Void":
      case "Never":
      case "Unknown":
      case "Any":
      case "Boolean":
      case "Symbol":
        return { _tag: last._tag, ...annotations }
      case "String": {
        const contentMediaType = last.annotations?.contentMediaType
        const contentSchema = last.annotations?.contentSchema
        return {
          _tag: last._tag,
          checks: fromASTChecks(last.checks),
          ...annotations,
          ...(typeof contentMediaType === "string" && AST.isAST(contentSchema)
            ? { contentSchema: recur(contentSchema) }
            : undefined)
        }
      }
      case "Number":
      case "BigInt":
        return {
          _tag: last._tag,
          checks: fromASTChecks(last.checks),
          ...annotations
        }
      case "Literal":
        return {
          _tag: last._tag,
          literal: last.literal,
          ...annotations
        }
      case "UniqueSymbol":
        return {
          _tag: last._tag,
          symbol: last.symbol,
          ...annotations
        }
      case "ObjectKeyword":
        return {
          _tag: last._tag,
          ...annotations
        }
      case "Enum":
        return {
          _tag: last._tag,
          enums: last.enums,
          ...annotations
        }
      case "TemplateLiteral":
        return {
          _tag: last._tag,
          parts: last.parts.map((ast) => recur(ast)),
          ...annotations
        }
      case "Arrays":
        return {
          _tag: last._tag,
          elements: last.elements.map((e) => {
            const last = AST.getLastEncoding(e)
            return {
              isOptional: AST.isOptional(last),
              type: recur(e),
              ...fromASTAnnotations(last.context?.annotations)
            }
          }),
          rest: last.rest.map((ast) => recur(ast)),
          checks: fromASTChecks(last.checks),
          ...annotations
        }
      case "Objects":
        return {
          _tag: last._tag,
          propertySignatures: last.propertySignatures.map((ps) => {
            const last = AST.getLastEncoding(ps.type)
            return {
              name: ps.name,
              type: recur(ps.type),
              isOptional: AST.isOptional(last),
              isMutable: AST.isMutable(last),
              ...fromASTAnnotations(last.context?.annotations)
            }
          }),
          indexSignatures: last.indexSignatures.map((is) => ({
            parameter: recur(is.parameter),
            type: recur(is.type)
          })),
          checks: fromASTChecks(last.checks),
          ...annotations
        }
      case "Union": {
        const types = InternalSchema.jsonReorder(last.types)
        return {
          _tag: last._tag,
          types: types.map((ast) => recur(ast)),
          mode: last.mode,
          ...annotations
        }
      }
      case "Suspend": {
        return {
          _tag: "Suspend",
          checks: [],
          thunk: recur(last.thunk()),
          ...annotations
        }
      }
    }
  }

  function fromASTChecks(
    checks: readonly [AST.Check<any>, ...Array<AST.Check<any>>] | undefined
  ): Array<SchemaRepresentation.Check<any>> {
    if (!checks) return []
    return checks.map(getCheck).filter((c) => c !== undefined)

    function getCheck(c: AST.Check<any>): SchemaRepresentation.Check<any> | undefined {
      switch (c._tag) {
        case "Filter": {
          const meta = c.annotations?.meta
          if (meta) {
            return {
              _tag: "Filter",
              meta: meta._tag === "isPropertyNames"
                ? {
                  _tag: "isPropertyNames",
                  propertyNames: recur(meta.propertyNames)
                }
                : meta,
              ...fromASTAnnotations(c.annotations)
            }
          }
          return undefined
        }
        case "FilterGroup": {
          const checks = fromASTChecks(c.checks)
          if (Arr.isArrayNonEmpty(checks)) {
            return {
              _tag: "FilterGroup",
              checks,
              ...fromASTAnnotations(c.annotations)
            }
          }
        }
      }
    }
  }
}

/** @internal */
export const fromASTBlacklist: Set<string> = new Set([
  // `expected` is preserved because is useful to generate descriptions in JSON Schemas
  "~structural",
  "~sentinels",
  "meta",
  "toArbitrary",
  "toArbitraryConstraint",
  "toEquivalence",
  "toFormatter",
  "toCodec",
  "toCodecJson",
  "toCodecIso",
  AST.ClassTypeId
])

const standardJsonSchemaAnnotationKeys: ReadonlySet<string> = new Set([
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "format",
  "contentEncoding",
  "contentMediaType",
  "contentSchema"
])

function fromASTAnnotations(
  annotations: Schema.Annotations.Annotations | undefined
): { annotations: Schema.Annotations.Annotations } | undefined {
  if (annotations !== undefined) {
    const filtered = Rec.filter(annotations, (_, k) => !fromASTBlacklist.has(k))
    if (!Rec.isEmptyRecord(filtered)) {
      return { annotations: filtered }
    }
  }
  return undefined
}

/** @internal */
export function toJsonSchemaDocument(
  document: SchemaRepresentation.Document,
  options?: Schema.ToJsonSchemaOptions
): JsonSchema.Document<"draft-2020-12"> {
  const { definitions, dialect: source, schemas } = toJsonSchemaMultiDocument({
    representations: [document.representation],
    references: document.references
  }, options)
  const schema = schemas[0]
  return { dialect: source, schema, definitions }
}

/** @internal */
export function toJsonSchemaMultiDocument(
  multiDocument: SchemaRepresentation.MultiDocument,
  options?: Schema.ToJsonSchemaOptions
): JsonSchema.MultiDocument<"draft-2020-12"> {
  const generateDescriptions = options?.generateDescriptions ?? false
  const additionalProperties = options?.additionalProperties ?? false
  const includeAnnotationKey = options?.includeAnnotationKey

  const definitions = Rec.map(multiDocument.references, (d) => recur(d))

  return {
    dialect: "draft-2020-12",
    schemas: Arr.map(multiDocument.representations, (s) => recur(s)),
    definitions
  }

  function recur(s: SchemaRepresentation.Representation): JsonSchema.JsonSchema {
    let js: JsonSchema.JsonSchema = on(s)
    if ("annotations" in s) {
      const a = collectJsonSchemaAnnotations(s.annotations)
      if (a) {
        js = { ...js, ...a }
      }
    }
    if ("checks" in s) {
      const checks = collectJsonSchemaChecks<SchemaRepresentation.Meta>(s.checks, js.type)
      for (const check of checks) {
        js = appendJsonSchema(js, check)
      }
    }
    return js
  }

  function on(schema: SchemaRepresentation.Representation): JsonSchema.JsonSchema {
    switch (schema._tag) {
      case "Any":
      case "Unknown":
      case "ObjectKeyword":
        return {}
      case "Void":
      case "Undefined":
        return { type: "null" }
      case "BigInt":
        return {
          "type": "string",
          "allOf": [
            { "pattern": "^-?\\d+$" }
          ]
        }
      case "Symbol":
      case "UniqueSymbol":
        return {
          "type": "string",
          "allOf": [
            { "pattern": "^Symbol\\((.*)\\)$" }
          ]
        }
      case "Declaration":
        return recur(schema.encodedSchema)
      case "Suspend":
        return recur(schema.thunk)
      case "Reference":
        return { $ref: `#/$defs/${escapeToken(schema.$ref)}` }
      case "Null":
        return { type: "null" }
      case "Never":
        return { not: {} }
      case "String": {
        const out: JsonSchema.JsonSchema = { type: "string" }
        if (schema.contentMediaType !== undefined) {
          out.contentMediaType = schema.contentMediaType
        }
        if (schema.contentSchema !== undefined) {
          out.contentSchema = recur(schema.contentSchema)
        }
        return out
      }
      case "Number":
        return hasCheck(schema.checks, "isInt") ?
          { type: "integer" } :
          hasCheck(schema.checks, "isFinite") ?
          { type: "number" } :
          {
            "anyOf": [
              { type: "number" },
              { type: "string", enum: ["NaN"] },
              { type: "string", enum: ["Infinity"] },
              { type: "string", enum: ["-Infinity"] }
            ]
          }
      case "Boolean":
        return { type: "boolean" }
      case "Literal": {
        const literal = schema.literal
        if (typeof literal === "string") {
          return { type: "string", enum: [literal] }
        }
        if (typeof literal === "number") {
          return { type: "number", enum: [literal] }
        }
        if (typeof literal === "boolean") {
          return { type: "boolean", enum: [literal] }
        }
        // bigint literals are not supported
        return { type: "string", enum: [String(literal)] }
      }
      case "Enum": {
        return recur({
          _tag: "Union",
          types: schema.enums.map(([title, value]) => ({
            _tag: "Literal",
            literal: value,
            annotations: { title }
          })),
          mode: "anyOf",
          annotations: schema.annotations
        })
      }
      case "TemplateLiteral": {
        const pattern = schema.parts.map(getPartPattern).join("")
        return { type: "string", pattern: `^${pattern}$` }
      }
      case "Arrays": {
        // ---------------------------------------------
        // handle post rest elements
        // ---------------------------------------------
        if (schema.rest.length > 1) {
          throw new globalThis.Error("Generating a JSON Schema for post-rest elements is not supported")
        }
        const out: JsonSchema.JsonSchema = { type: "array" }
        let minItems = schema.elements.length
        const prefixItems: Array<JsonSchema.JsonSchema> = schema.elements.map((e) => {
          if (e.isOptional) {
            minItems--
          }
          const v = recur(e.type)
          const a = collectJsonSchemaAnnotations(e.annotations)
          return a ? appendJsonSchema(v, a) : v
        })
        if (prefixItems.length > 0) {
          out.prefixItems = prefixItems
          out.maxItems = schema.elements.length
          if (minItems > 0) {
            out.minItems = minItems
          }
        } else {
          out.items = false
        }
        if (schema.rest.length > 0) {
          delete out.maxItems
          const rest = recur(schema.rest[0])
          if (Object.keys(rest).length > 0) {
            out.items = rest
          } else {
            delete out.items
          }
        }
        return out
      }
      case "Objects": {
        if (schema.propertySignatures.length === 0 && schema.indexSignatures.length === 0) {
          return { anyOf: [{ type: "object" }, { type: "array" }] }
        }
        const out: JsonSchema.JsonSchema = { type: "object" }
        const properties: Record<string, JsonSchema.JsonSchema> = {}
        const required: Array<string> = []

        for (const ps of schema.propertySignatures) {
          const name = ps.name
          if (typeof name !== "string") {
            throw new globalThis.Error(`Unsupported property signature name: ${format(name)}`)
          }
          const v = recur(ps.type)
          const a = collectJsonSchemaAnnotations(ps.annotations)
          properties[name] = a ? appendJsonSchema(v, a) : v
          // Property is required only if it's not explicitly optional AND doesn't contain Undefined
          if (!ps.isOptional) {
            required.push(name)
          }
        }

        if (Object.keys(properties).length > 0) {
          out.properties = properties
        }
        if (required.length > 0) {
          out.required = required
        }

        out.additionalProperties = additionalProperties
        const patternProperties: Record<string, JsonSchema.JsonSchema | false> = {}
        // Handle index signatures
        for (const is of schema.indexSignatures) {
          let type: JsonSchema.JsonSchema | false = recur(is.type)
          // Collapse unannotated Never ({ not: {} }) to false, but keep annotated schemas as objects.
          if (Object.keys(type).length === 1 && "not" in type) {
            type = false
          }
          const patterns = getParameterPatterns(is.parameter)
          if (patterns.length > 0) {
            for (const pattern of patterns) {
              patternProperties[pattern] = type
            }
          } else {
            out.additionalProperties = type
          }
        }
        if (Object.keys(patternProperties).length > 0) {
          out.patternProperties = patternProperties
          delete out.additionalProperties
        }
        if (Predicate.isObject(out.additionalProperties) && Rec.isEmptyRecord(out.additionalProperties)) {
          delete out.additionalProperties
        }

        return out
      }
      case "Union": {
        const types = schema.types.map(recur)
        if (types.length === 0) {
          // anyOf MUST be a non-empty array
          return { not: {} }
        }
        if (types.length > 1) {
          const compacted = compactEnums(types)
          if (compacted) return compacted
        }
        return schema.mode === "anyOf" ? { anyOf: types } : { oneOf: types }
      }
    }
  }

  // Collapses [{type:"string",enum:["a"]},{type:"string",enum:["b"]}] into {type:"string",enum:["a","b"]}.
  // Returns undefined if members have different types, extra keys (e.g. title), or empty enums.
  function compactEnums(
    types: ReadonlyArray<JsonSchema.JsonSchema>
  ): JsonSchema.JsonSchema | undefined {
    let sharedType: string | undefined
    const values: Array<unknown> = []
    for (const t of types) {
      const keys = Object.keys(t)
      if (keys.length !== 2 || t.type === undefined || !Array.isArray(t.enum) || t.enum.length === 0) {
        return undefined
      }
      if (sharedType === undefined) {
        sharedType = t.type as string
      } else if (t.type !== sharedType) {
        return undefined
      }
      for (const v of t.enum) {
        values.push(v)
      }
    }
    return { type: sharedType, enum: values }
  }

  function collectJsonSchemaAnnotations(
    annotations: Schema.Annotations.Annotations | undefined
  ): JsonSchema.JsonSchema | undefined {
    if (annotations === undefined) return undefined

    const out: JsonSchema.JsonSchema = {}
    if (typeof annotations.title === "string") out.title = annotations.title
    if (typeof annotations.description === "string") out.description = annotations.description
    else if (generateDescriptions && typeof annotations.expected === "string") out.description = annotations.expected
    if (annotations.default !== undefined) out.default = annotations.default
    if (Array.isArray(annotations.examples)) out.examples = annotations.examples
    if (typeof annotations.readOnly === "boolean") out.readOnly = annotations.readOnly
    if (typeof annotations.writeOnly === "boolean") out.writeOnly = annotations.writeOnly
    if (typeof annotations.format === "string") out.format = annotations.format
    if (typeof annotations.contentEncoding === "string") out.contentEncoding = annotations.contentEncoding
    if (typeof annotations.contentMediaType === "string") out.contentMediaType = annotations.contentMediaType

    if (includeAnnotationKey) {
      for (const [key, value] of Object.entries(annotations)) {
        if (value === undefined) continue
        if (standardJsonSchemaAnnotationKeys.has(key)) continue
        if (!includeAnnotationKey(key)) continue
        out[key] = value
      }
    }

    if (Object.keys(out).length > 0) return out
  }

  function collectJsonSchemaChecks<M>(
    checks: ReadonlyArray<SchemaRepresentation.Check<M>>,
    type: unknown
  ): Array<JsonSchema.JsonSchema> {
    return checks.map(collectJsonSchemaCheck).filter((c) => c !== undefined)

    function collectJsonSchemaCheck<M>(check: SchemaRepresentation.Check<M>): JsonSchema.JsonSchema | undefined {
      switch (check._tag) {
        case "Filter":
          return filterToJsonSchema(check, type)
        case "FilterGroup": {
          const checks = check.checks.map(collectJsonSchemaCheck).filter((c) => c !== undefined)
          if (checks.length === 0) return undefined
          let out = { allOf: checks }
          const a = collectJsonSchemaAnnotations(check.annotations)
          if (a) {
            out = { ...out, ...a }
          }
          return out
        }
      }
    }
  }

  function filterToJsonSchema(
    filter: SchemaRepresentation.Filter<any>,
    type: unknown
  ): JsonSchema.JsonSchema | undefined {
    const meta = filter.meta as SchemaRepresentation.Meta
    if (!meta) return undefined

    let out = on(meta)
    const a = collectJsonSchemaAnnotations(filter.annotations)
    if (a) {
      out = { ...out, ...a }
    }
    return out

    function on(
      meta: SchemaRepresentation.Meta
    ): JsonSchema.JsonSchema | undefined {
      switch (meta._tag) {
        case "isMinLength":
          return type === "array" ? { minItems: meta.minLength } : { minLength: meta.minLength }
        case "isMaxLength":
          return type === "array" ? { maxItems: meta.maxLength } : { maxLength: meta.maxLength }
        case "isLengthBetween":
          return type === "array"
            ? { allOf: [{ minItems: meta.minimum }, { maxItems: meta.maximum }] }
            : { allOf: [{ minLength: meta.minimum }, { maxLength: meta.maximum }] }
        case "isPattern":
        case "isULID":
        case "isBase64":
        case "isBase64Url":
        case "isStartsWith":
        case "isEndsWith":
        case "isIncludes":
        case "isUppercased":
        case "isLowercased":
        case "isCapitalized":
        case "isUncapitalized":
        case "isTrimmed":
        case "isStringFinite":
        case "isStringBigInt":
        case "isStringSymbol":
          return { pattern: meta.regExp.source }
        case "isUUID":
          return { pattern: meta.regExp.source, format: "uuid" }

        case "isFinite":
        case "isInt":
          return undefined
        case "isMultipleOf":
          return { multipleOf: meta.divisor }
        case "isGreaterThanOrEqualTo":
          return { minimum: meta.minimum }
        case "isLessThanOrEqualTo":
          return { maximum: meta.maximum }
        case "isGreaterThan":
          return { exclusiveMinimum: meta.exclusiveMinimum }
        case "isLessThan":
          return { exclusiveMaximum: meta.exclusiveMaximum }
        case "isBetween": {
          return {
            [meta.exclusiveMinimum ? "exclusiveMinimum" : "minimum"]: meta.minimum,
            [meta.exclusiveMaximum ? "exclusiveMaximum" : "maximum"]: meta.maximum
          }
        }

        case "isUnique":
          return { uniqueItems: true }

        case "isMinProperties":
          return { minProperties: meta.minProperties }
        case "isMaxProperties":
          return { maxProperties: meta.maxProperties }
        case "isPropertiesLengthBetween":
          return { minProperties: meta.minimum, maxProperties: meta.maximum }
        case "isPropertyNames":
          return { propertyNames: recur(meta.propertyNames) }

        case "isDateValid":
          return { format: "date-time" }
      }
    }
  }

  function getParameterPatterns(parameter: SchemaRepresentation.Representation): Array<string> {
    switch (parameter._tag) {
      default:
        throw new globalThis.Error(`Unsupported index signature parameter: ${parameter._tag}`)
      case "Reference":
        return getParameterPatterns(multiDocument.references[parameter.$ref])
      case "String":
        return getPatterns(parameter)
      case "TemplateLiteral":
        return [`^${parameter.parts.map(getPartPattern).join("")}$`]
      case "Union":
        return parameter.types.flatMap(getParameterPatterns)
    }
  }
}

function getPatterns(s: SchemaRepresentation.String): Array<string> {
  return recur(s.checks)

  function recur(checks: ReadonlyArray<SchemaRepresentation.Check<SchemaRepresentation.StringMeta>>): Array<string> {
    return checks.flatMap((c) => {
      switch (c._tag) {
        case "Filter": {
          if ("regExp" in c.meta) {
            return [c.meta.regExp.source]
          }
          return []
        }
        case "FilterGroup":
          return recur(c.checks)
      }
    })
  }
}

function hasCheck(checks: ReadonlyArray<SchemaRepresentation.Check<SchemaRepresentation.Meta>>, tag: string): boolean {
  return checks.some((c) => {
    switch (c._tag) {
      case "Filter":
        return c.meta._tag === tag
      case "FilterGroup":
        return hasCheck(c.checks, tag)
    }
  })
}

function appendJsonSchema(a: JsonSchema.JsonSchema, b: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  if (Object.keys(a).length === 0) return b
  const len = Object.keys(b).length
  if (len === 0) return a
  const members = Array.isArray(b.allOf) && len === 1 ? b.allOf : [b]

  if (Array.isArray(a.allOf)) {
    return { ...a, allOf: [...a.allOf, ...members] }
  }

  if (typeof a.$ref === "string") {
    return { allOf: [a, ...members] }
  }

  return { ...a, allOf: members }
}

function getPartPattern(part: SchemaRepresentation.Representation): string {
  switch (part._tag) {
    case "Literal":
      return RegEx.escape(globalThis.String(part.literal))
    case "String":
      return AST.STRING_PATTERN
    case "Number":
      return AST.FINITE_PATTERN
    case "TemplateLiteral":
      return part.parts.map(getPartPattern).join("")
    case "Union":
      return part.types.map(getPartPattern).join("|")
    default:
      throw new globalThis.Error("Unsupported part", { cause: part })
  }
}
