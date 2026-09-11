import * as JsonSchema from "../../JsonSchema.ts"
import { remainder } from "../../Number.ts"
import * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import type * as SchemaRepresentation from "../../SchemaRepresentation.ts"
import { errorWithPath } from "../errors.ts"
import * as InternalRecord from "../record.ts"
import { fromRepresentation, fromRepresentations } from "./fromRepresentation.ts"

type Path = ReadonlyArray<string | number>
type Representation = SchemaRepresentation.Representation
type Check = SchemaRepresentation.Check

type ImportedJsonSchemaRepresentation = Extract<Representation, {
  readonly _tag:
    | "Reference"
    | "Suspend"
    | "Never"
    | "Unknown"
    | "Null"
    | "String"
    | "Number"
    | "Boolean"
    | "Literal"
    | "Arrays"
    | "Objects"
    | "Union"
}>

interface ImportedObjectPattern {
  readonly source: string
  readonly parameter: SchemaRepresentation.String
  readonly type: ImportedJsonSchemaRepresentation
}

interface ImportedObjectProperty {
  readonly type: ImportedJsonSchemaRepresentation | undefined
  readonly isOptional: boolean
}

interface ImportedObjectScope {
  readonly properties: ReadonlyMap<string, ImportedObjectProperty>
  readonly hasProperties: boolean
  readonly patterns: ReadonlyArray<ImportedObjectPattern>
  readonly additionalProperties: ImportedJsonSchemaRepresentation
}

const never: ImportedJsonSchemaRepresentation = { _tag: "Never", checks: [] }
const unknown: ImportedJsonSchemaRepresentation = { _tag: "Unknown", checks: [] }
const string: ImportedJsonSchemaRepresentation = { _tag: "String", checks: [] }

function makeJsonLiteral(input: unknown): ImportedJsonSchemaRepresentation | undefined {
  if (input === null) return { _tag: "Null", checks: [] }
  return typeof input === "string" || typeof input === "number" || typeof input === "boolean"
    ? { _tag: "Literal", literal: input, checks: [] }
    : undefined
}

const jsonSchemaValueTypes = ["null", "string", "number", "boolean", "object", "array"] as const

const jsonSchemaTypeSpecificKeys = [
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems"
]
function isImportedJsonSchemaType(input: unknown): input is JsonSchema.Type {
  return input === "integer" || typeof input === "string" && jsonSchemaValueTypes.some((type) => type === input)
}

function hasTypeSpecificKeywords(schema: JsonSchema.JsonSchema): boolean {
  return jsonSchemaTypeSpecificKeys.some((key) => schema[key] !== undefined)
}

function jsonSchemaFilter(
  id: string,
  payload: Schema.Json,
  schemas?: ReadonlyArray<Representation>
): Check {
  return {
    _tag: "Filter",
    aborted: false,
    representation: {
      id,
      payload,
      ...(schemas === undefined ? undefined : { schemas })
    }
  }
}

function addNumberCheck(
  checks: Array<Check>,
  value: unknown,
  id: string,
  key: string
): void {
  if (typeof value === "number") {
    checks.push(jsonSchemaFilter(id, { [key]: value }))
  }
}

function jsonSchemaAnnotations(
  schema: JsonSchema.JsonSchema
): Schema.Annotations.Annotations | undefined {
  const annotations: Record<string, Schema.Json> = {}
  if (typeof schema.title === "string") annotations.title = schema.title
  if (typeof schema.description === "string") annotations.description = schema.description
  if (Object.hasOwn(schema, "default")) annotations.default = schema.default as Schema.Json
  if (Array.isArray(schema.examples)) annotations.examples = schema.examples as ReadonlyArray<Schema.Json>
  if (typeof schema.readOnly === "boolean") annotations.readOnly = schema.readOnly
  if (typeof schema.writeOnly === "boolean") annotations.writeOnly = schema.writeOnly
  if (typeof schema.format === "string") annotations.format = schema.format
  if (typeof schema.contentEncoding === "string") annotations.contentEncoding = schema.contentEncoding
  if (typeof schema.contentMediaType === "string") annotations.contentMediaType = schema.contentMediaType
  if (SchemaAST.isJson(schema.contentSchema)) annotations.contentSchema = schema.contentSchema
  return Object.keys(annotations).length === 0 ? undefined : annotations
}

function jsonDeclaration(
  annotations: Schema.Annotations.Annotations | undefined
): Representation {
  return {
    _tag: "Declaration",
    representation: {
      id: "effect/schema/Json",
      payload: null
    },
    annotations: {
      ...annotations,
      expected: "JSON value"
    },
    checks: [],
    typeParameters: []
  }
}

function unknownJsonSchemas(representation: Representation): Representation {
  switch (representation._tag) {
    case "Unknown":
      return jsonDeclaration(representation.annotations)
    case "Suspend":
      return { ...representation, thunk: unknownJsonSchemas(representation.thunk) }
    case "Arrays":
      return {
        ...representation,
        elements: representation.elements.map((element) => ({
          ...element,
          type: unknownJsonSchemas(element.type)
        })),
        rest: representation.rest.map(unknownJsonSchemas)
      }
    case "Objects":
      return {
        ...representation,
        propertySignatures: representation.propertySignatures.map((property) => ({
          ...property,
          type: unknownJsonSchemas(property.type)
        })),
        indexSignatures: representation.indexSignatures.map((indexSignature) => ({
          parameter: unknownJsonSchemas(indexSignature.parameter),
          type: unknownJsonSchemas(indexSignature.type)
        })),
        checks: representation.checks.map(unknownJsonSchemaCheck)
      }
    case "Union":
      return { ...representation, types: representation.types.map(unknownJsonSchemas) }
    default:
      return representation
  }
}

function unknownJsonSchemaCheck(check: Check): Check {
  const representation = check.representation
  const schemas = representation?.schemas
  if (representation === undefined || schemas === undefined) {
    return check
  }
  return {
    ...check,
    representation: {
      ...representation,
      schemas: schemas.map(unknownJsonSchemas)
    }
  }
}

function translateJsonSchemaMultiDocument(
  document: JsonSchema.MultiDocument<"draft-2020-12">,
  options?: SchemaRepresentation.FromJsonSchemaOptions,
  singleRoot = false
): SchemaRepresentation.MultiDocument {
  const definitionCache = new Map<string, ImportedJsonSchemaRepresentation | null>()
  const reachableDefinitions = new Map<string, Path>()
  const objectScopesByProperties = new WeakMap<
    SchemaRepresentation.Objects["propertySignatures"],
    ReadonlyArray<ImportedObjectScope>
  >()
  const annotatedReferences: Array<{
    readonly reference: SchemaRepresentation.Reference
    readonly path: Path
  }> = []
  const resolvingChoices = new Set<string>()

  function annotate(
    representation: ImportedJsonSchemaRepresentation,
    annotations: Schema.Annotations.Annotations | undefined
  ): ImportedJsonSchemaRepresentation {
    if (annotations === undefined) return representation
    if (representation._tag === "Reference") {
      return { _tag: "Suspend", annotations, checks: [], thunk: representation }
    }
    return {
      ...representation,
      annotations: { ...representation.annotations, ...annotations }
    }
  }

  function translateDefinition(
    key: string,
    path: Path,
    recursiveReferenceError?: string
  ): ImportedJsonSchemaRepresentation {
    const cached = definitionCache.get(key)
    if (cached !== undefined) {
      if (cached === null) {
        throw errorWithPath(recursiveReferenceError ?? `Invalid reference ${key}`, [...path, "$ref"])
      }
      return cached
    }
    if (!Object.hasOwn(document.definitions, key)) {
      throw errorWithPath(`Invalid reference ${key}`, [...path, "$ref"])
    }
    definitionCache.set(key, null)
    const representation = recur(document.definitions[key], ["definitions", key])
    definitionCache.set(key, representation)
    return representation
  }

  function resolveReference(
    reference: SchemaRepresentation.Reference,
    path: Path,
    options?: { readonly recursiveReferenceError?: string },
    seen: Set<string> = new Set()
  ): ImportedJsonSchemaRepresentation {
    if (seen.has(reference.$ref)) {
      throw errorWithPath(`Invalid reference ${reference.$ref}`, [...path, "$ref"])
    }
    seen.add(reference.$ref)
    const representation = translateDefinition(reference.$ref, path, options?.recursiveReferenceError)
    if (representation._tag === "Reference") {
      return resolveReference(representation, path, options, seen)
    }
    if (representation._tag === "Suspend" && representation.thunk._tag === "Reference") {
      return annotate(
        resolveReference(representation.thunk, path, options, seen),
        representation.annotations
      )
    }
    return representation
  }

  function mergeAnnotations(
    left: Schema.Annotations.Annotations | undefined,
    right: Schema.Annotations.Annotations | undefined
  ): Schema.Annotations.Annotations | undefined {
    if (left === undefined) return right
    if (right === undefined) return left
    return { ...left, ...right }
  }

  function combinedAnnotations(
    representation: ImportedJsonSchemaRepresentation,
    left: ImportedJsonSchemaRepresentation,
    right: ImportedJsonSchemaRepresentation
  ): ImportedJsonSchemaRepresentation {
    return annotate(
      representation,
      mergeAnnotations(
        left._tag === "Reference" ? undefined : left.annotations,
        right._tag === "Reference" ? undefined : right.annotations
      )
    )
  }

  function asChecks(
    checks: ReadonlyArray<Check>,
    annotations: Schema.Annotations.Annotations | undefined
  ): ReadonlyArray<Check> | undefined {
    if (checks.length === 0) return undefined
    if (annotations === undefined) return checks
    if (checks.length === 1 && checks[0].annotations === undefined) {
      return [{
        ...checks[0],
        annotations
      }]
    }
    return [{
      _tag: "FilterGroup",
      checks: checks as [Check, ...Array<Check>],
      annotations
    }]
  }

  function combineChecks(
    left: ReadonlyArray<Check>,
    right: ReadonlyArray<Check>,
    annotations: Schema.Annotations.Annotations | undefined,
    deduplicate: ReadonlyArray<string> = []
  ): ReadonlyArray<Check> | undefined {
    for (const id of deduplicate) {
      if (left.some((check) => checkId(check) === id)) {
        right = right.filter((check) => checkId(check) !== id)
      }
    }
    const checks = asChecks(right, annotations)
    return checks === undefined ? undefined : [...left, ...checks]
  }

  function checkId(check: Check): string | undefined {
    return check._tag === "Filter" ? check.representation?.id : undefined
  }

  function satisfiesPrimitiveCheck(check: Check, value: string | number): boolean | undefined {
    if (check._tag === "FilterGroup") {
      return check.checks.every((check) => satisfiesPrimitiveCheck(check, value))
    }
    const representation = check.representation!
    const payload = representation.payload as Record<string, any>
    switch (representation.id) {
      case "effect/schema/isMinLength":
        return (value as string).length >= payload.minLength
      case "effect/schema/isMaxLength":
        return (value as string).length <= payload.maxLength
      case "effect/schema/isPattern":
        return new RegExp(payload.source as string, payload.flags as string).test(value as string)
      case "effect/schema/isFinite":
        return globalThis.Number.isFinite(value as number)
      case "effect/schema/isInt":
        return globalThis.Number.isSafeInteger(value as number)
      case "effect/schema/isMultipleOf":
        return remainder(value as number, payload.divisor) === 0
      case "effect/schema/isGreaterThan":
        return (value as number) > payload.exclusiveMinimum
      case "effect/schema/isGreaterThanOrEqualTo":
        return (value as number) >= payload.minimum
      case "effect/schema/isLessThan":
        return (value as number) < payload.exclusiveMaximum
      case "effect/schema/isLessThanOrEqualTo":
        return (value as number) <= payload.maximum
    }
  }

  function satisfiesLiteral(
    representation:
      | SchemaRepresentation.String
      | SchemaRepresentation.Number,
    literal: SchemaRepresentation.Literal
  ): boolean {
    const value = literal.literal
    if (representation._tag === "String" ? typeof value !== "string" : typeof value !== "number") {
      return false
    }
    return representation.checks.every((check) => satisfiesPrimitiveCheck(check, value as string | number))
  }

  function combinePrimitiveWithLiteral(
    primitive:
      | SchemaRepresentation.String
      | SchemaRepresentation.Number
      | SchemaRepresentation.Boolean,
    literal: SchemaRepresentation.Literal
  ): ImportedJsonSchemaRepresentation {
    const satisfies = primitive._tag === "Boolean"
      ? typeof literal.literal === "boolean"
      : satisfiesLiteral(primitive, literal)
    return satisfies ? combinedAnnotations(literal, primitive, literal) : never
  }

  function combineArrays(
    left: SchemaRepresentation.Arrays,
    right: SchemaRepresentation.Arrays,
    path: Path
  ): Pick<SchemaRepresentation.Arrays, "elements" | "rest"> | undefined {
    const elements: Array<SchemaRepresentation.Element> = []
    const length = Math.max(left.elements.length, right.elements.length)
    for (let index = 0; index < length; index++) {
      const leftElement = left.elements[index]
      const rightElement = right.elements[index]
      const isOptional = leftElement?.isOptional !== false && rightElement?.isOptional !== false
      const leftType = leftElement?.type ?? left.rest[0]
      const rightType = rightElement?.type ?? right.rest[0]
      if (leftType === undefined || rightType === undefined) {
        return isOptional ? { elements, rest: [] } : undefined
      }
      const type = combine(
        leftType as ImportedJsonSchemaRepresentation,
        rightType as ImportedJsonSchemaRepresentation,
        [...path, "elements", index, "type"]
      )
      if (type._tag === "Never") {
        return isOptional ? { elements, rest: [] } : undefined
      }
      elements.push({
        isOptional,
        type
      })
    }

    const leftRest = left.rest[0]
    const rightRest = right.rest[0]
    if (leftRest === undefined || rightRest === undefined) {
      return { elements, rest: [] }
    }
    const rest = combine(
      leftRest as ImportedJsonSchemaRepresentation,
      rightRest as ImportedJsonSchemaRepresentation,
      [...path, "rest", 0]
    )
    return { elements, rest: rest._tag === "Never" ? [] : [rest] }
  }

  function combineTypes(
    types: ReadonlyArray<ImportedJsonSchemaRepresentation>,
    path: Path
  ): ImportedJsonSchemaRepresentation {
    let out = types[0] ?? unknown
    for (let index = 1; index < types.length; index++) {
      out = combine(out, types[index], [...path, index])
    }
    return out
  }

  function lowerObject(
    scopes: ReadonlyArray<ImportedObjectScope>,
    checks: ReadonlyArray<Check>,
    annotations: Schema.Annotations.Annotations | undefined,
    path: Path
  ): ImportedJsonSchemaRepresentation {
    const names = new Set<string>()
    let hasFiniteKeyDomain = false
    let requiresFiniteKeyDomain = false
    for (const scope of scopes) {
      for (const name of scope.properties.keys()) names.add(name)
      hasFiniteKeyDomain ||= scope.additionalProperties._tag === "Never" && scope.patterns.length === 0
      requiresFiniteKeyDomain ||= scope.additionalProperties._tag === "Never" ||
        scope.additionalProperties._tag !== "Unknown" && (scope.hasProperties || scope.patterns.length > 0)
    }
    if (!hasFiniteKeyDomain && requiresFiniteKeyDomain) {
      throw errorWithPath("Unsupported object keyword scopes", path)
    }

    const properties: Array<SchemaRepresentation.PropertySignature> = []
    for (const name of names) {
      let isOptional = true
      const types: Array<ImportedJsonSchemaRepresentation> = []
      for (const scope of scopes) {
        const property = scope.properties.get(name)
        if (property !== undefined) {
          if (!property.isOptional) isOptional = false
          if (property.type !== undefined) types.push(property.type)
        }
        let matches = false
        for (const pattern of scope.patterns) {
          if (globalThis.RegExp(pattern.source).test(name)) {
            types.push(pattern.type)
            matches = true
          }
        }
        if (property?.type === undefined && !matches) types.push(scope.additionalProperties)
      }
      const type = combineTypes(types, [...path, "properties", name])
      if (!isOptional && type._tag === "Never") return never
      properties.push({ name, type, isOptional, isMutable: false })
    }

    const indexSignatures: Array<SchemaRepresentation.IndexSignature> = []
    if (!hasFiniteKeyDomain) {
      const additionalProperties = combineTypes(
        scopes.map((scope) => scope.additionalProperties),
        [...path, "additionalProperties"]
      )
      const patterns = new Map<string, ImportedObjectPattern>()
      for (const scope of scopes) {
        for (const pattern of scope.patterns) {
          const previous = patterns.get(pattern.source)
          patterns.set(
            pattern.source,
            previous === undefined
              ? pattern
              : {
                ...pattern,
                type: combine(
                  previous.type,
                  pattern.type,
                  [...path, "patternProperties", pattern.source]
                )
              }
          )
        }
      }
      for (const { parameter, type } of patterns.values()) {
        indexSignatures.push({
          parameter,
          type: combine(type, additionalProperties, [...path, "indexSignatures"])
        })
      }
      indexSignatures.push({ parameter: string, type: additionalProperties })
    } else if (properties.length === 0) {
      indexSignatures.push({ parameter: string, type: never })
    }

    objectScopesByProperties.set(properties, scopes)
    return {
      _tag: "Objects",
      propertySignatures: properties,
      indexSignatures,
      checks,
      annotations
    }
  }

  const jsonRootTags = ["Null", "String", "Number", "Boolean", "Objects", "Arrays"] as const
  const allMasks = (1 << jsonRootTags.length) - 1

  function rootMask(representation: ImportedJsonSchemaRepresentation): number {
    switch (representation._tag) {
      case "Never":
        return 0
      case "Unknown":
      case "Reference":
        return allMasks
      case "Literal":
        switch (typeof representation.literal) {
          case "string":
            return 2
          case "number":
            return 4
          case "boolean":
            return 8
          default:
            return 0
        }
      case "Suspend":
        return rootMask(representation.thunk as ImportedJsonSchemaRepresentation)
      case "Union": {
        let out = 0
        for (const type of representation.types) {
          out |= rootMask(type as ImportedJsonSchemaRepresentation)
        }
        return out
      }
      default:
        return 1 << jsonRootTags.indexOf(representation._tag)
    }
  }

  function hasChoices(representation: ImportedJsonSchemaRepresentation): boolean {
    switch (representation._tag) {
      case "Reference": {
        const key = representation.$ref
        const cached = definitionCache.get(key)
        if (cached === null || resolvingChoices.has(key)) return true
        resolvingChoices.add(key)
        const out = hasChoices(cached ?? translateDefinition(key, reachableDefinitions.get(key)!))
        resolvingChoices.delete(key)
        return out
      }
      case "Suspend":
        return hasChoices(representation.thunk as ImportedJsonSchemaRepresentation)
      case "Union":
        return representation.types.length > 1 ||
          representation.types.some((type) => hasChoices(type as ImportedJsonSchemaRepresentation))
      case "Arrays":
        return representation.elements.some((element) =>
          hasChoices(element.type as ImportedJsonSchemaRepresentation)
        ) || representation.rest.some((type) => hasChoices(type as ImportedJsonSchemaRepresentation))
      case "Objects":
        return representation.propertySignatures.some((property) =>
          hasChoices(property.type as ImportedJsonSchemaRepresentation)
        ) ||
          representation.indexSignatures.some((indexSignature) =>
            hasChoices(indexSignature.parameter as ImportedJsonSchemaRepresentation) ||
            hasChoices(indexSignature.type as ImportedJsonSchemaRepresentation)
          ) || representation.checks.some(checkHasChoices)
      default:
        return false
    }
  }

  function checkHasChoices(check: Check): boolean {
    return check._tag === "FilterGroup"
      ? check.checks.some(checkHasChoices)
      : check.representation?.schemas?.some((schema) => hasChoices(schema as ImportedJsonSchemaRepresentation)) === true
  }

  function makeUnion(
    source: SchemaRepresentation.Union,
    types: ReadonlyArray<ImportedJsonSchemaRepresentation>
  ): ImportedJsonSchemaRepresentation {
    if (types.length === 0) return never
    if (types.length === 1 && source.checks.length === 0) return annotate(types[0], source.annotations)
    return { ...source, types }
  }

  function literalValue(
    representation: ImportedJsonSchemaRepresentation
  ): string | number | boolean | null | undefined {
    if (representation._tag === "Null") return null
    if (representation._tag !== "Literal") return undefined
    const literal = representation.literal
    return typeof literal === "string" || typeof literal === "number" || typeof literal === "boolean"
      ? literal
      : undefined
  }

  function combineLiteralUnions(
    left: SchemaRepresentation.Union,
    right: SchemaRepresentation.Union,
    path: Path
  ): ImportedJsonSchemaRepresentation | undefined {
    if (left.mode !== "anyOf" || right.mode !== "anyOf") return undefined
    const rightByValue = new Map<string | number | boolean | null, ImportedJsonSchemaRepresentation>()
    for (const type of right.types) {
      const representation = type as ImportedJsonSchemaRepresentation
      const value = literalValue(representation)
      if (value === undefined) return undefined
      rightByValue.set(value, representation)
    }
    const types: Array<ImportedJsonSchemaRepresentation> = []
    for (const type of left.types) {
      const representation = type as ImportedJsonSchemaRepresentation
      const value = literalValue(representation)
      if (value === undefined) return undefined
      const match = rightByValue.get(value)
      if (match !== undefined) types.push(combine(representation, annotate(match, right.annotations), path))
    }
    return makeUnion(left, types)
  }

  function combineUnionWithType(
    union: SchemaRepresentation.Union,
    type: ImportedJsonSchemaRepresentation,
    path: Path,
    unionOnLeft: boolean
  ): ImportedJsonSchemaRepresentation {
    const mask = rootMask(type)
    const members = union.types
      .map((member, index) => ({
        index,
        type: member as ImportedJsonSchemaRepresentation
      }))
      .filter((member) => (rootMask(member.type) & mask) !== 0)
    if (members.length > 1 && hasChoices(type)) {
      return unsupportedIntersection(path)
    }
    if (members.length === 1 && union.checks.length === 0) {
      const member = annotate(members[0].type, union.annotations)
      return unionOnLeft
        ? combine(member, type, [...path, "types", members[0].index])
        : combine(type, member, [...path, "types", members[0].index])
    }
    return makeUnion(
      union,
      members
        .map((member) =>
          unionOnLeft
            ? combine(member.type, type, [...path, "types", member.index])
            : combine(type, member.type, [...path, "types", member.index])
        )
        .filter((type) => type._tag !== "Never")
    )
  }

  function isTypePartition(union: SchemaRepresentation.Union): boolean {
    let mask = 0
    for (const type of union.types) {
      const memberMask = rootMask(type as ImportedJsonSchemaRepresentation)
      if ((mask & memberMask) !== 0) return false
      mask |= memberMask
    }
    return true
  }

  function unsupportedIntersection(path: Path): never {
    throw errorWithPath("Unsupported intersection of overlapping unions", path)
  }

  function combinePartition(
    partition: SchemaRepresentation.Union,
    other: SchemaRepresentation.Union,
    path: Path,
    partitionOnLeft: boolean
  ): ImportedJsonSchemaRepresentation {
    const partitionTypes = partition.types as ReadonlyArray<ImportedJsonSchemaRepresentation>
    const otherTypes = other.types as ReadonlyArray<ImportedJsonSchemaRepresentation>
    for (const type of otherTypes) {
      const mask = rootMask(type)
      if (partitionTypes.filter((member) => (rootMask(member) & mask) !== 0).length > 1 && hasChoices(type)) {
        return unsupportedIntersection(path)
      }
    }
    const types: Array<ImportedJsonSchemaRepresentation> = []
    for (let index = 0; index < partitionTypes.length; index++) {
      const member = partitionTypes[index]
      const type = combineUnionWithType(other, member, [...path, "types", index], !partitionOnLeft)
      if (type._tag !== "Never") types.push(type)
    }
    return makeUnion(partition, types)
  }

  function combineUnions(
    left: SchemaRepresentation.Union,
    right: SchemaRepresentation.Union,
    path: Path
  ): ImportedJsonSchemaRepresentation {
    const literals = combineLiteralUnions(left, right, path)
    if (literals !== undefined) return literals
    if (isTypePartition(left)) return combinePartition(left, right, path, true)
    if (isTypePartition(right)) return combinePartition(right, left, path, false)
    return unsupportedIntersection(path)
  }

  function combine(
    left: ImportedJsonSchemaRepresentation,
    right: ImportedJsonSchemaRepresentation,
    path: Path
  ): ImportedJsonSchemaRepresentation {
    if (left._tag === "Never") return left
    if (right._tag === "Never") return right
    if (left._tag === "Unknown") return combinedAnnotations(right, left, right)
    if (right._tag === "Unknown") return combinedAnnotations(left, left, right)
    if (left._tag === "Reference") return combine(resolveReference(left, path), right, path)
    if (right._tag === "Reference") return combine(left, resolveReference(right, path), path)
    if (left._tag === "Suspend") {
      return annotate(
        combine(left.thunk as ImportedJsonSchemaRepresentation, right, path),
        left.annotations
      )
    }
    if (right._tag === "Suspend") {
      return annotate(
        combine(left, right.thunk as ImportedJsonSchemaRepresentation, path),
        right.annotations
      )
    }
    if (left._tag === "Union" && right._tag === "Union") return combineUnions(left, right, path)
    if (left._tag === "Union") return combineUnionWithType(left, right, path, true)
    if (right._tag === "Union") return combineUnionWithType(right, left, path, false)

    switch (left._tag) {
      case "Null":
        return right._tag === "Null"
          ? combinedAnnotations({ _tag: "Null", checks: [...left.checks, ...right.checks] }, left, right)
          : never
      case "String":
        if (right._tag === "Literal") {
          return combinePrimitiveWithLiteral(left, right)
        }
        if (right._tag !== "String") return never
        const stringChecks = combineChecks(left.checks, right.checks, right.annotations)
        return annotate(
          {
            _tag: "String",
            checks: stringChecks ?? left.checks
          },
          mergeAnnotations(left.annotations, stringChecks === undefined ? right.annotations : undefined)
        )
      case "Number":
        if (right._tag === "Literal") {
          return combinePrimitiveWithLiteral(left, right)
        }
        if (right._tag !== "Number") return never
        const numberChecks = combineChecks(left.checks, right.checks, right.annotations, [
          "effect/schema/isFinite",
          "effect/schema/isInt"
        ])
        return annotate(
          {
            _tag: "Number",
            checks: numberChecks ?? left.checks
          },
          mergeAnnotations(left.annotations, numberChecks === undefined ? right.annotations : undefined)
        )
      case "Boolean":
        if (right._tag === "Literal") {
          return combinePrimitiveWithLiteral(left, right)
        }
        return right._tag === "Boolean"
          ? combinedAnnotations(
            {
              _tag: "Boolean",
              checks: [...left.checks, ...right.checks]
            },
            left,
            right
          )
          : never
      case "Literal":
        if (right._tag === "Literal") {
          return left.literal === right.literal
            ? combinedAnnotations(
              {
                ...left,
                checks: [...left.checks, ...right.checks]
              },
              left,
              right
            )
            : never
        }
        if (
          (right._tag === "String" || right._tag === "Number") && satisfiesLiteral(right, left) ||
          right._tag === "Boolean" && typeof left.literal === "boolean"
        ) {
          return combinedAnnotations(left, left, right)
        }
        return never
      case "Arrays": {
        if (right._tag !== "Arrays") return never
        const arrays = combineArrays(left, right, path)
        if (arrays === undefined) return never
        const arrayChecks = combineChecks(left.checks, right.checks, right.annotations, ["effect/schema/isUnique"])
        return annotate(
          {
            _tag: "Arrays",
            elements: arrays.elements,
            rest: arrays.rest,
            checks: arrayChecks ?? left.checks
          },
          mergeAnnotations(left.annotations, arrayChecks === undefined ? right.annotations : undefined)
        )
      }
      case "Objects": {
        if (right._tag !== "Objects") return never
        const objectChecks = combineChecks(left.checks, right.checks, right.annotations)
        const scopes = [
          ...objectScopesByProperties.get(left.propertySignatures)!,
          ...objectScopesByProperties.get(right.propertySignatures)!
        ]
        return lowerObject(
          scopes,
          objectChecks ?? left.checks,
          mergeAnnotations(left.annotations, objectChecks === undefined ? right.annotations : undefined),
          path
        )
      }
    }
  }

  function recur(input: unknown, path: Path): ImportedJsonSchemaRepresentation {
    if (input === false) {
      return never
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) return unknown
    const schema = options?.onEnter === undefined
      ? input as JsonSchema.JsonSchema
      : options.onEnter(input as JsonSchema.JsonSchema)
    if (schema === undefined) {
      return unknown
    }
    const enumIndex = Array.isArray(schema.enum)
      ? schema.enum.findIndex((value) => typeof value === "object" && value !== null)
      : -1
    if (enumIndex !== -1) {
      throw errorWithPath(`Unsupported structured JSON Schema value for "enum"`, [...path, "enum", enumIndex])
    }
    for (const keyword of Object.keys(schema)) {
      if (keyword === "if" && !Object.hasOwn(schema, "then") && !Object.hasOwn(schema, "else")) continue
      switch (keyword) {
        case "if":
        case "$dynamicRef":
        case "contains":
        case "dependentRequired":
        case "dependentSchemas":
        case "not":
        case "unevaluatedItems":
        case "unevaluatedProperties":
          throw errorWithPath(`Unsupported JSON Schema keyword "${keyword}"`, [...path, keyword])
      }
    }

    let representation = on(schema, path)
    if (Object.hasOwn(schema, "const")) {
      const literal = makeJsonLiteral(schema.const)
      if (literal === undefined && typeof schema.const === "object") {
        throw errorWithPath(`Unsupported structured JSON Schema value for "const"`, [...path, "const"])
      }
      if (literal !== undefined) representation = combine(representation, literal, [...path, "const"])
    }
    if (Array.isArray(schema.enum)) {
      const types = schema.enum.map((value) => makeJsonLiteral(value) ?? unknown)
      representation = combine(
        representation,
        types.length === 1
          ? types[0]
          : { _tag: "Union", types, mode: "anyOf", checks: [] },
        [...path, "enum"]
      )
    }
    if (typeof schema.$ref === "string") {
      const $ref = JsonSchema.getReferenceKey(schema.$ref)
      if ($ref === undefined) {
        throw errorWithPath(`Unsupported reference ${JSON.stringify(schema.$ref)}`, [...path, "$ref"])
      }
      if (!Object.hasOwn(document.definitions, $ref)) {
        throw errorWithPath(`Invalid reference ${JSON.stringify(schema.$ref)}`, [...path, "$ref"])
      }
      if (!reachableDefinitions.has($ref)) reachableDefinitions.set($ref, path)
      const reference: SchemaRepresentation.Reference = { _tag: "Reference", $ref }
      representation = representation._tag === "Unknown"
        ? reference
        : representation._tag === "Never"
        ? never
        : combine(
          resolveReference(reference, path, {
            recursiveReferenceError: `Unsupported assertion siblings on recursive reference ${reference.$ref}`
          }),
          representation,
          path
        )
    }
    const annotations = jsonSchemaAnnotations(schema)
    if (annotations !== undefined && representation._tag === "Reference") {
      annotatedReferences.push({ reference: representation, path })
    }
    representation = annotate(representation, annotations)

    if (Array.isArray(schema.allOf)) {
      for (let index = 0; index < schema.allOf.length; index++) {
        representation = combine(
          representation,
          recur(schema.allOf[index], [...path, "allOf", index]),
          [...path, "allOf", index]
        )
      }
    }

    for (const mode of ["anyOf", "oneOf"] as const) {
      const members = schema[mode]
      if (Array.isArray(members)) {
        const union: ImportedJsonSchemaRepresentation = {
          _tag: "Union",
          types: members.map((member, index) => recur(member, [...path, mode, index])),
          mode,
          checks: []
        }
        representation = combine(union, representation, [...path, mode])
      }
    }
    return representation
  }

  function on(schema: JsonSchema.JsonSchema, path: Path): ImportedJsonSchemaRepresentation {
    const types = Array.isArray(schema.type) && schema.type.every(isImportedJsonSchemaType)
      ? schema.type
      : !isImportedJsonSchemaType(schema.type) && hasTypeSpecificKeywords(schema)
      ? jsonSchemaValueTypes
      : undefined
    if (types !== undefined) {
      return {
        _tag: "Union",
        types: types.map((type) => on({ ...schema, type }, path)),
        mode: "anyOf",
        checks: []
      }
    }

    const type = isImportedJsonSchemaType(schema.type) ? schema.type : undefined
    switch (type) {
      case "null":
        return { _tag: "Null", checks: [] }
      case "string":
        return {
          _tag: "String",
          checks: collectStringChecks(schema, path)
        }
      case "number":
      case "integer":
        return {
          _tag: "Number",
          checks: [
            jsonSchemaFilter(type === "number" ? "effect/schema/isFinite" : "effect/schema/isInt", null),
            ...collectNumberChecks(schema)
          ]
        }
      case "boolean":
        return { _tag: "Boolean", checks: [] }
      case "array": {
        const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : undefined
        const minItems = typeof schema.minItems === "number" ? schema.minItems : 0
        const elements = prefixItems?.map((element, index) => ({
          isOptional: index + 1 > minItems,
          type: recur(element, [...path, "prefixItems", index])
        })) ?? []
        const isTupleClosed = schema.items === false ||
          (schema.items === undefined &&
            prefixItems !== undefined &&
            schema.maxItems === prefixItems.length)
        const isMaxItemsRedundant = isTupleClosed &&
          typeof schema.maxItems === "number" &&
          schema.maxItems >= elements.length
        return {
          _tag: "Arrays",
          elements,
          rest: isTupleClosed
            ? []
            : [schema.items === undefined ? unknown : recur(schema.items, [...path, "items"])],
          checks: collectArrayChecks(schema, isMaxItemsRedundant)
        }
      }
      case "object": {
        const scope = collectObjectScope(schema, path)
        return lowerObject([scope], collectObjectChecks(schema, path), undefined, path)
      }
      default:
        return unknown
    }
  }

  function importPatternChecks(pattern: string, path: Path): Array<Check> {
    switch (options?.patterns ?? "error") {
      case "error":
        throw errorWithPath(`Pattern encountered while patterns is set to "error"`, path)
      case "ignore":
        return []
      case "apply":
        return [jsonSchemaFilter("effect/schema/isPattern", { source: pattern, flags: "" })]
    }
  }

  function collectStringChecks(schema: JsonSchema.JsonSchema, path: Path): Array<Check> {
    const checks: Array<Check> = []
    addNumberCheck(checks, schema.minLength, "effect/schema/isMinLength", "minLength")
    addNumberCheck(checks, schema.maxLength, "effect/schema/isMaxLength", "maxLength")
    if (typeof schema.pattern === "string") {
      checks.push(...importPatternChecks(schema.pattern, [...path, "pattern"]))
    }
    return checks
  }

  function collectNumberChecks(schema: JsonSchema.JsonSchema): Array<Check> {
    const checks: Array<Check> = []
    addNumberCheck(checks, schema.minimum, "effect/schema/isGreaterThanOrEqualTo", "minimum")
    addNumberCheck(checks, schema.maximum, "effect/schema/isLessThanOrEqualTo", "maximum")
    addNumberCheck(checks, schema.exclusiveMinimum, "effect/schema/isGreaterThan", "exclusiveMinimum")
    addNumberCheck(checks, schema.exclusiveMaximum, "effect/schema/isLessThan", "exclusiveMaximum")
    addNumberCheck(checks, schema.multipleOf, "effect/schema/isMultipleOf", "divisor")
    return checks
  }

  function collectArrayChecks(schema: JsonSchema.JsonSchema, isMaxItemsRedundant: boolean): Array<Check> {
    const checks: Array<Check> = []
    if (
      !Array.isArray(schema.prefixItems) ||
      typeof schema.minItems === "number" && schema.minItems > schema.prefixItems.length
    ) {
      addNumberCheck(checks, schema.minItems, "effect/schema/isMinLength", "minLength")
    }
    if (!isMaxItemsRedundant) {
      addNumberCheck(checks, schema.maxItems, "effect/schema/isMaxLength", "maxLength")
    }
    if (schema.uniqueItems === true) {
      checks.push(jsonSchemaFilter("effect/schema/isUnique", null))
    }
    return checks
  }

  function collectObjectScope(
    schema: JsonSchema.JsonSchema,
    path: Path
  ): ImportedObjectScope {
    const sourceProperties =
      typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties)
        ? schema.properties as Record<string, unknown>
        : {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : []
    const propertyNames = Object.keys(sourceProperties)
    const keys = new Set([...propertyNames, ...required])
    const properties = new Map(Array.from(keys, (name) => [name, {
      type: Object.hasOwn(sourceProperties, name)
        ? recur(sourceProperties[name], [...path, "properties", name])
        : undefined,
      isOptional: !required.includes(name)
    }]))
    const hasProperties = propertyNames.length > 0
    const patterns: Array<ImportedObjectPattern> = []
    if (
      typeof schema.patternProperties === "object" &&
      schema.patternProperties !== null &&
      !Array.isArray(schema.patternProperties)
    ) {
      for (const [pattern, value] of Object.entries(schema.patternProperties)) {
        const checks = importPatternChecks(pattern, [...path, "patternProperties", pattern])
        if (checks.length === 0) return { properties, hasProperties, patterns: [], additionalProperties: unknown }
        patterns.push({
          source: pattern,
          parameter: {
            _tag: "String",
            checks
          },
          type: recur(value, [...path, "patternProperties", pattern])
        })
      }
    }
    const additionalProperties = schema.additionalProperties === false
      ? never
      : typeof schema.additionalProperties === "object" && schema.additionalProperties !== null
      ? recur(schema.additionalProperties, [...path, "additionalProperties"])
      : unknown
    return { properties, hasProperties, patterns, additionalProperties }
  }

  function collectObjectChecks(
    schema: JsonSchema.JsonSchema,
    path: Path
  ): Array<Check> {
    const checks: Array<Check> = []
    addNumberCheck(checks, schema.minProperties, "effect/schema/isMinProperties", "minProperties")
    addNumberCheck(checks, schema.maxProperties, "effect/schema/isMaxProperties", "maxProperties")
    if (schema.propertyNames !== undefined) {
      const propertyNamesPath = [...path, "propertyNames"]
      checks.push(jsonSchemaFilter(
        "effect/schema/isPropertyNames",
        null,
        [combine(string, recur(schema.propertyNames, propertyNamesPath), propertyNamesPath)]
      ))
    }
    return checks
  }

  const references: Record<string, Representation> = {}
  const representations = document.schemas.map((schema, index) =>
    unknownJsonSchemas(recur(schema, singleRoot ? ["schema"] : ["schemas", index]))
  ) as [Representation, ...Array<Representation>]
  for (const [key, path] of reachableDefinitions) {
    InternalRecord.assignProperty(references, key, unknownJsonSchemas(translateDefinition(key, path)))
  }
  for (const { reference, path } of annotatedReferences) {
    resolveReference(reference, path)
  }
  return { representations, references }
}

const jsonSchemaRevivers: ReadonlyArray<SchemaRepresentation.AnyReviver> = [
  Schema.JsonReviver,
  Schema.isPatternReviver,
  Schema.isFiniteReviver,
  Schema.isGreaterThanReviver,
  Schema.isGreaterThanOrEqualToReviver,
  Schema.isLessThanReviver,
  Schema.isLessThanOrEqualToReviver,
  Schema.isMultipleOfReviver,
  Schema.isIntReviver,
  Schema.isMinLengthReviver,
  Schema.isMaxLengthReviver,
  Schema.isMinPropertiesReviver,
  Schema.isMaxPropertiesReviver,
  Schema.isPropertyNamesReviver,
  Schema.isUniqueReviver
]

/** @internal */
export function fromJsonSchemaDocument(
  document: JsonSchema.Document<"draft-2020-12">,
  options?: SchemaRepresentation.FromJsonSchemaOptions
): Schema.Top {
  const translated = translateJsonSchemaMultiDocument(
    {
      dialect: document.dialect,
      schemas: [document.schema],
      definitions: document.definitions
    },
    options,
    true
  )
  return fromRepresentation({
    representation: translated.representations[0],
    references: translated.references
  }, jsonSchemaRevivers)
}

/** @internal */
export function fromJsonSchemaMultiDocument(
  document: JsonSchema.MultiDocument<"draft-2020-12">,
  options?: SchemaRepresentation.FromJsonSchemaOptions
): readonly [Schema.Top, ...Array<Schema.Top>] {
  return fromRepresentations(translateJsonSchemaMultiDocument(document, options), jsonSchemaRevivers)
}
