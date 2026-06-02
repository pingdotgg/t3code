/**
 * Convert JSON Schema documents between dialects (Draft-07, Draft-2020-12,
 * OpenAPI 3.0, OpenAPI 3.1). All dialects are normalized to an internal
 * `Document<"draft-2020-12">` representation before optional conversion to
 * an output dialect.
 *
 * ## Mental model
 *
 * - **JsonSchema** — a plain object with string keys; represents any single
 *   JSON Schema node.
 * - **Dialect** — one of `"draft-07"`, `"draft-2020-12"`, `"openapi-3.1"`,
 *   or `"openapi-3.0"`.
 * - **Document** — a structured container holding a root `schema`, its
 *   companion `definitions`, and the target `dialect`. Definitions are
 *   stored separately from the root schema so they can be relocated when
 *   converting between dialects.
 * - **MultiDocument** — same as `Document` but carries multiple root
 *   schemas (at least one). Useful when generating several schemas that
 *   share a single definitions pool.
 * - **Definitions** — a `Record<string, JsonSchema>` keyed by definition
 *   name. The ref pointer prefix depends on the dialect.
 * - **`from*` functions** — parse a raw JSON Schema object into the
 *   canonical `Document<"draft-2020-12">`.
 * - **`to*` functions** — convert from the canonical representation to a
 *   specific output dialect.
 *
 * ## Common tasks
 *
 * - Parse a Draft-07 schema → {@link fromSchemaDraft07}
 * - Parse a Draft-2020-12 schema → {@link fromSchemaDraft2020_12}
 * - Parse an OpenAPI 3.1 schema → {@link fromSchemaOpenApi3_1}
 * - Parse an OpenAPI 3.0 schema → {@link fromSchemaOpenApi3_0}
 * - Convert to Draft-07 output → {@link toDocumentDraft07}
 * - Convert to OpenAPI 3.1 output → {@link toMultiDocumentOpenApi3_1}
 * - Resolve a `$ref` against definitions → {@link resolve$ref}
 * - Inline the root `$ref` of a document → {@link resolveTopLevel$ref}
 *
 * ## Gotchas
 *
 * - All `from*` functions normalize to `Document<"draft-2020-12">`
 *   regardless of the input dialect.
 * - Unsupported or unrecognized JSON Schema keywords are silently dropped
 *   during conversion.
 * - Draft-07 tuple syntax (`items` as array + `additionalItems`) is
 *   converted to 2020-12 form (`prefixItems` + `items`), and vice-versa.
 * - OpenAPI 3.0 `nullable: true` is expanded into `type` arrays or
 *   `anyOf` unions. The `nullable` keyword is removed.
 * - OpenAPI 3.0 singular `example` is converted to `examples` (array).
 * - {@link resolve$ref} only looks up the last segment of the ref path in
 *   the definitions map; it does not follow arbitrary JSON Pointer paths.
 *
 * ## Quickstart
 *
 * **Example** (Parse a Draft-07 schema and convert to Draft-07 output)
 *
 * ```ts
 * import { JsonSchema } from "effect"
 *
 * const raw: JsonSchema.JsonSchema = {
 *   type: "object",
 *   properties: {
 *     name: { type: "string" }
 *   },
 *   required: ["name"]
 * }
 *
 * // Parse into canonical form
 * const doc = JsonSchema.fromSchemaDraft07(raw)
 *
 * // Convert back to Draft-07
 * const draft07 = JsonSchema.toDocumentDraft07(doc)
 *
 * console.log(draft07.dialect) // "draft-07"
 * console.log(draft07.schema) // { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
 * ```
 *
 * ## See also
 *
 * - {@link Document}
 * - {@link MultiDocument}
 * - {@link fromSchemaDraft07}
 * - {@link toDocumentDraft07}
 * - {@link resolve$ref}
 *
 * @since 4.0.0
 */
import * as Arr from "./Array.ts"
import { unescapeToken } from "./JsonPointer.ts"
import * as Predicate from "./Predicate.ts"
import * as Rec from "./Record.ts"

/**
 * A plain object representing a single JSON Schema node.
 *
 * **When to use**
 *
 * Use to represent an arbitrary JSON Schema object regardless of dialect.
 *
 * **Details**
 *
 * This is an open record type (`[x: string]: unknown`) so it can hold any JSON
 * Schema keyword. Most functions in this module accept or return this type.
 *
 * @category models
 * @since 4.0.0
 */
export interface JsonSchema {
  [x: string]: unknown
}

/**
 * The set of JSON Schema dialects supported by this module.
 *
 * **When to use**
 *
 * Use as the dialect marker for `JsonSchema` documents when parsing,
 * converting, or emitting schemas across the supported formats.
 *
 * **Details**
 *
 * Supported values are `"draft-07"` for JSON Schema Draft-07,
 * `"draft-2020-12"` for JSON Schema Draft 2020-12 and the canonical internal
 * form, `"openapi-3.1"` for OpenAPI 3.1, and `"openapi-3.0"` for OpenAPI 3.0.
 *
 * @see {@link Document} for a single root schema tagged with a dialect
 * @see {@link MultiDocument} for multiple root schemas tagged with a dialect
 *
 * @category models
 * @since 4.0.0
 */
export type Dialect = "draft-07" | "draft-2020-12" | "openapi-3.1" | "openapi-3.0"

/**
 * The JSON Schema primitive type names.
 *
 * **When to use**
 *
 * Use to restrict a JSON Schema `type` keyword to the supported primitive names.
 *
 * @category models
 * @since 4.0.0
 */
export type Type = "string" | "number" | "boolean" | "array" | "object" | "null" | "integer"

/**
 * A record of named JSON Schema definitions, keyed by definition name.
 *
 * **When to use**
 *
 * Use as the shared lookup table for named JSON Schema nodes that are
 * referenced from JSON Schema documents.
 *
 * **Details**
 *
 * The map is dialect-neutral. Conversion APIs emit it as `$defs`,
 * `definitions`, or `components.schemas` depending on the target format.
 *
 * @see {@link Document} for a single root schema with definitions
 * @see {@link MultiDocument} for multiple root schemas sharing definitions
 * @see {@link resolve$ref} for resolving a `$ref` against definitions
 *
 * @category models
 * @since 4.0.0
 */
export interface Definitions extends Record<string, JsonSchema> {}

/**
 * A structured container for a single JSON Schema and its associated
 * definitions.
 *
 * **When to use**
 *
 * Use when you need to carry a root schema together with its shared
 * definitions, or when converting between dialects with the `from*` and `to*`
 * functions.
 *
 * **Details**
 *
 * The `schema` field holds the root schema *without* the definitions
 * collection. Root definitions are stored separately in `definitions` and
 * referenced via `#/$defs/<name>` for Draft-2020-12, `#/definitions/<name>`
 * for Draft-07, and `#/components/schemas/<name>` for OpenAPI 3.1 and
 * OpenAPI 3.0.
 *
 * **Example** (Inspecting a parsed document)
 *
 * ```ts
 * import { JsonSchema } from "effect"
 *
 * const raw: JsonSchema.JsonSchema = {
 *   type: "string",
 *   $defs: { Trimmed: { type: "string", minLength: 1 } }
 * }
 *
 * const doc = JsonSchema.fromSchemaDraft2020_12(raw)
 *
 * console.log(doc.dialect)     // "draft-2020-12"
 * console.log(doc.schema)      // { type: "string" }
 * console.log(doc.definitions) // { Trimmed: { type: "string", minLength: 1 } }
 * ```
 *
 * @see {@link MultiDocument}
 * @see {@link fromSchemaDraft2020_12}
 * @category models
 * @since 4.0.0
 */
export interface Document<D extends Dialect> {
  readonly dialect: D
  readonly schema: JsonSchema
  readonly definitions: Definitions
}

/**
 * Like {@link Document}, but carries multiple root schemas that share a
 * single definitions pool.
 *
 * **When to use**
 *
 * Use when generating several schemas, such as a request body
 * and a response body, that reference the same set of definitions.
 *
 * **Details**
 *
 * The `schemas` tuple is non-empty and contains at least one element.
 *
 * @see {@link Document}
 * @see {@link toMultiDocumentOpenApi3_1}
 * @category models
 * @since 4.0.0
 */
export interface MultiDocument<D extends Dialect> {
  readonly dialect: D
  readonly schemas: readonly [JsonSchema, ...Array<JsonSchema>]
  readonly definitions: Definitions
}

/**
 * Represents the `$schema` meta-schema URI for JSON Schema Draft-07.
 *
 * **When to use**
 *
 * Use when constructing a Draft-07 JSON Schema document and you need a stable
 * value for the root `$schema` field.
 *
 * **Details**
 *
 * The exported value is the literal string
 * `http://json-schema.org/draft-07/schema`.
 *
 * @see {@link META_SCHEMA_URI_DRAFT_2020_12} for the Draft 2020-12 `$schema` URI
 *
 * @category constants
 * @since 4.0.0
 */
export const META_SCHEMA_URI_DRAFT_07 = "http://json-schema.org/draft-07/schema"

/**
 * Represents the `$schema` meta-schema URI for JSON Schema Draft 2020-12.
 *
 * **When to use**
 *
 * Use to populate the `$schema` field when emitting a JSON Schema document that
 * should declare JSON Schema Draft 2020-12.
 *
 * **Details**
 *
 * The exported value is the literal string
 * `https://json-schema.org/draft/2020-12/schema`.
 *
 * @see {@link META_SCHEMA_URI_DRAFT_07} for the Draft-07 `$schema` URI
 *
 * @category constants
 * @since 4.0.0
 */
export const META_SCHEMA_URI_DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema"

const RE_DEFINITIONS = /^#\/definitions(?=\/|$)/
const RE_DEFS = /^#\/\$defs(?=\/|$)/
const RE_COMPONENTS_SCHEMAS = /^#\/components\/schemas(?=\/|$)/

/**
 * Parses a raw Draft-07 JSON Schema into a `Document<"draft-2020-12">`.
 *
 * **When to use**
 *
 * Use when you have a JSON Schema that follows Draft-07 conventions and
 * need the canonical Draft-2020-12 document representation.
 *
 * **Details**
 *
 * This converts Draft-07 tuple syntax (`items` as array plus
 * `additionalItems`) to Draft-2020-12 form (`prefixItems` plus `items`),
 * rewrites `#/definitions/...` refs to `#/$defs/...`, and extracts root-level
 * `definitions` into the `definitions` field.
 *
 * **Gotchas**
 *
 * Unsupported keywords, such as `if`/`then`/`else` and `$id`, are dropped.
 *
 * **Example** (Parsing a Draft-07 schema)
 *
 * ```ts
 * import { JsonSchema } from "effect"
 *
 * const raw: JsonSchema.JsonSchema = {
 *   type: "object",
 *   properties: {
 *     tags: {
 *       type: "array",
 *       items: { type: "string" }
 *     }
 *   }
 * }
 *
 * const doc = JsonSchema.fromSchemaDraft07(raw)
 * console.log(doc.dialect) // "draft-2020-12"
 * console.log(doc.schema.properties) // { tags: { type: "array", items: { type: "string" } } }
 * ```
 *
 * @see {@link fromSchemaDraft2020_12}
 * @see {@link fromSchemaOpenApi3_0}
 * @see {@link toDocumentDraft07}
 * @category decoding
 * @since 4.0.0
 */
export function fromSchemaDraft07(js: JsonSchema): Document<"draft-2020-12"> {
  let definitions: Definitions | undefined

  const schema = walk(js, true) as JsonSchema
  return {
    dialect: "draft-2020-12",
    schema,
    definitions: definitions ?? {}
  }

  function walk(node: unknown, isRoot: boolean): unknown {
    if (Array.isArray(node)) return node.map((v) => walk(v, false))
    if (!Predicate.isObject(node)) return node

    const out: Record<string, unknown> = {}

    let prefixItems: unknown = undefined
    let additionalItems: unknown = undefined

    for (const k of Object.keys(node)) {
      const v = node[k]

      switch (k) {
        case "$ref":
          out.$ref = typeof v === "string" ? v.replace(RE_DEFINITIONS, "#/$defs") : v
          break

        case "definitions": {
          const mapped = walk_object(v, walk)
          if (isRoot) {
            definitions = mapped as Definitions | undefined
          } else {
            out.definitions = mapped ?? v
          }
          break
        }

        case "items":
          prefixItems = v
          break
        case "additionalItems":
          additionalItems = v
          break

        case "properties":
        case "patternProperties": {
          const mapped = walk_object(v, walk)
          out[k] = mapped ?? v
          break
        }

        case "additionalProperties":
        case "propertyNames":
          out[k] = walk(v, false)
          break

        case "allOf":
        case "anyOf":
        case "oneOf":
          out[k] = Array.isArray(v) ? v.map((x) => walk(x, false)) : v
          break

        case "type":
        case "required":
        case "enum":
        case "const":
        case "title":
        case "description":
        case "default":
        case "examples":
        case "format":
        case "readOnly":
        case "writeOnly":
        case "pattern":
        case "minimum":
        case "maximum":
        case "exclusiveMinimum":
        case "exclusiveMaximum":
        case "minLength":
        case "maxLength":
        case "minItems":
        case "maxItems":
        case "minProperties":
        case "maxProperties":
        case "multipleOf":
        case "uniqueItems":
          out[k] = v
          break

        default:
          break
      }
    }

    // Draft-07 tuples -> 2020-12 tuples
    if (prefixItems !== undefined) {
      if (Array.isArray(prefixItems)) {
        out.prefixItems = prefixItems.map((x) => walk(x, false))
        if (additionalItems !== undefined) out.items = walk(additionalItems, false)
      } else {
        out.items = walk(prefixItems, false)
      }
    }

    return out
  }
}

/**
 * Parses a raw Draft-2020-12 JSON Schema into a `Document<"draft-2020-12">`.
 *
 * **When to use**
 *
 * Use when you already have a schema in Draft-2020-12 format.
 *
 * **Details**
 *
 * This separates `$defs` from the root schema into the `definitions` field.
 * Unlike {@link fromSchemaDraft07}, this performs no keyword rewriting.
 *
 * **Example** (Parsing a Draft-2020-12 schema)
 *
 * ```ts
 * import { JsonSchema } from "effect"
 *
 * const raw: JsonSchema.JsonSchema = {
 *   type: "number",
 *   minimum: 0,
 *   $defs: { PositiveInt: { type: "integer", minimum: 1 } }
 * }
 *
 * const doc = JsonSchema.fromSchemaDraft2020_12(raw)
 * console.log(doc.schema)      // { type: "number", minimum: 0 }
 * console.log(doc.definitions) // { PositiveInt: { type: "integer", minimum: 1 } }
 * ```
 *
 * @see {@link fromSchemaDraft07}
 * @see {@link fromSchemaOpenApi3_1}
 * @category decoding
 * @since 4.0.0
 */
export function fromSchemaDraft2020_12(js: JsonSchema): Document<"draft-2020-12"> {
  const { $defs, ...schema } = js
  return {
    dialect: "draft-2020-12",
    schema,
    definitions: Predicate.isObject($defs) ? ($defs as Definitions) : {}
  }
}

/**
 * Parses a raw OpenAPI 3.1 JSON Schema into a `Document<"draft-2020-12">`.
 *
 * **When to use**
 *
 * Use when consuming schemas from an OpenAPI 3.1 specification.
 *
 * **Details**
 *
 * This rewrites `#/components/schemas/...` refs to `#/$defs/...`, then delegates
 * to {@link fromSchemaDraft2020_12}.
 *
 * **Example** (Parsing an OpenAPI 3.1 schema)
 *
 * ```ts
 * import { JsonSchema } from "effect"
 *
 * const raw: JsonSchema.JsonSchema = {
 *   type: "object",
 *   properties: {
 *     user: { $ref: "#/components/schemas/User" }
 *   }
 * }
 *
 * const doc = JsonSchema.fromSchemaOpenApi3_1(raw)
 * // $ref is rewritten to Draft-2020-12 form
 * console.log(doc.schema.properties) // { user: { $ref: "#/$defs/User" } }
 * ```
 *
 * @see {@link fromSchemaOpenApi3_0}
 * @see {@link toMultiDocumentOpenApi3_1}
 * @category decoding
 * @since 4.0.0
 */
export function fromSchemaOpenApi3_1(js: JsonSchema): Document<"draft-2020-12"> {
  const schema = rewrite_refs(js, (ref) => ref.replace(RE_COMPONENTS_SCHEMAS, "#/$defs")) as JsonSchema
  return fromSchemaDraft2020_12(schema)
}

/**
 * Parses a raw OpenAPI 3.0 JSON Schema into a `Document<"draft-2020-12">`.
 *
 * **When to use**
 *
 * Use when consuming schemas from an OpenAPI 3.0 specification.
 *
 * **Details**
 *
 * This handles OpenAPI 3.0 extensions, including `nullable`, singular
 * `example`, and boolean `exclusiveMinimum` or `exclusiveMaximum`. It
 * normalizes the schema to Draft-07 first, then converts to Draft-2020-12 via
 * {@link fromSchemaDraft07}.
 *
 * **Example** (Parsing an OpenAPI 3.0 nullable schema)
 *
 * ```ts
 * import { JsonSchema } from "effect"
 *
 * const raw: JsonSchema.JsonSchema = {
 *   type: "string",
 *   nullable: true
 * }
 *
 * const doc = JsonSchema.fromSchemaOpenApi3_0(raw)
 * // nullable is expanded into a type array
 * console.log(doc.schema.type) // ["string", "null"]
 * ```
 *
 * @see {@link fromSchemaOpenApi3_1}
 * @see {@link fromSchemaDraft07}
 * @category decoding
 * @since 4.0.0
 */
export function fromSchemaOpenApi3_0(schema: JsonSchema): Document<"draft-2020-12"> {
  const normalized = normalize_OpenApi3_0_to_Draft07(schema)
  return fromSchemaDraft07(normalized as JsonSchema)
}

/**
 * Converts a `Document<"draft-2020-12">` to a `Document<"draft-07">`.
 *
 * **When to use**
 *
 * Use when you need to output a schema in Draft-07 format.
 *
 * **Details**
 *
 * This rewrites `#/$defs/...` refs to `#/definitions/...`, converts
 * Draft-2020-12 tuple syntax (`prefixItems` plus `items`) to Draft-07 form
 * (`items` as array plus `additionalItems`), and converts both the root schema
 * and all definitions.
 *
 * **Gotchas**
 *
 * Unsupported Draft-2020-12 keywords are dropped.
 *
 * **Example** (Converting to Draft-07)
 *
 * ```ts
 * import { JsonSchema } from "effect"
 *
 * const doc = JsonSchema.fromSchemaDraft2020_12({
 *   type: "array",
 *   prefixItems: [{ type: "string" }, { type: "number" }],
 *   items: { type: "boolean" }
 * })
 *
 * const draft07 = JsonSchema.toDocumentDraft07(doc)
 * console.log(draft07.dialect)                // "draft-07"
 * console.log(draft07.schema.items)           // [{ type: "string" }, { type: "number" }]
 * console.log(draft07.schema.additionalItems) // { type: "boolean" }
 * ```
 *
 * @see {@link fromSchemaDraft07}
 * @see {@link toMultiDocumentOpenApi3_1}
 * @category encoding
 * @since 4.0.0
 */
export function toDocumentDraft07(document: Document<"draft-2020-12">): Document<"draft-07"> {
  return {
    dialect: "draft-07",
    schema: toSchemaDraft07(document.schema),
    definitions: Rec.map(document.definitions, toSchemaDraft07)
  }
}

function toSchemaDraft07(schema: JsonSchema): JsonSchema {
  return rewrite(schema)

  function rewrite(node: unknown): JsonSchema {
    return walk(rewrite_refs(node, (ref) => ref.replace(RE_DEFS, "#/definitions")), true) as JsonSchema
  }

  function walk(node: unknown, _isRoot: boolean): unknown {
    if (Array.isArray(node)) return node.map((v) => walk(v, false))
    if (!Predicate.isObject(node)) return node

    const src = node as Record<string, unknown>
    const out: Record<string, unknown> = {}

    let prefixItems: unknown = undefined
    let items: unknown = undefined

    for (const k of Object.keys(src)) {
      const v = src[k]

      switch (k) {
        // We already rewrote $ref via rewrite_refs, so just copy it through.
        case "$ref":
        case "type":
        case "required":
        case "enum":
        case "const":
        case "title":
        case "description":
        case "default":
        case "examples":
        case "format":
        case "pattern":
        case "minimum":
        case "maximum":
        case "exclusiveMinimum":
        case "exclusiveMaximum":
        case "minLength":
        case "maxLength":
        case "minItems":
        case "maxItems":
        case "minProperties":
        case "maxProperties":
        case "multipleOf":
        case "uniqueItems":
          out[k] = v
          break

        // Schema maps
        case "properties":
        case "patternProperties": {
          const mapped = walk_object(v, walk)
          out[k] = mapped ?? v
          break
        }

        // Single subschemas
        case "additionalProperties":
        case "propertyNames":
          out[k] = walk(v, false)
          break

        // Schema arrays
        case "allOf":
        case "anyOf":
        case "oneOf":
          out[k] = Array.isArray(v) ? v.map((x) => walk(x, false)) : v
          break

        // Tuple handling (2020-12 form)
        case "prefixItems":
          prefixItems = v
          break
        case "items":
          items = v
          break

        default:
          // drop everything else (subset)
          break
      }
    }

    // 2020-12 tuples -> Draft-07 tuples
    if (prefixItems !== undefined) {
      if (Array.isArray(prefixItems)) {
        out.items = prefixItems.map((x) => walk(x, false))
        if (items !== undefined) out.additionalItems = walk(items, false)
      } else {
        // Non-standard, but keep a reasonable behavior
        out.items = walk(prefixItems, false)
      }
    } else if (items !== undefined) {
      // Regular items schema stays as items
      out.items = walk(items, false)
    }

    return out
  }
}

/**
 * Converts a `MultiDocument<"draft-2020-12">` to a
 * `MultiDocument<"openapi-3.1">`.
 *
 * **When to use**
 *
 * Use when generating an OpenAPI 3.1 specification from internal schemas.
 *
 * **Details**
 *
 * This rewrites `#/$defs/...` refs to `#/components/schemas/...`, sanitizes
 * definition keys to match the OpenAPI component key pattern
 * (`^[a-zA-Z0-9.\-_]+$`) by replacing invalid characters with `_`, updates all
 * `$ref` pointers to use the sanitized keys, and converts all schemas and
 * definitions in the multi-document.
 *
 * **Example** (Converting to OpenAPI 3.1)
 *
 * ```ts
 * import { JsonSchema } from "effect"
 *
 * const multi: JsonSchema.MultiDocument<"draft-2020-12"> = {
 *   dialect: "draft-2020-12",
 *   schemas: [{ $ref: "#/$defs/User" }],
 *   definitions: {
 *     User: { type: "object", properties: { name: { type: "string" } } }
 *   }
 * }
 *
 * const openapi = JsonSchema.toMultiDocumentOpenApi3_1(multi)
 * console.log(openapi.dialect) // "openapi-3.1"
 * console.log(openapi.schemas[0]) // { $ref: "#/components/schemas/User" }
 * ```
 *
 * @see {@link toDocumentDraft07}
 * @see {@link MultiDocument}
 * @category encoding
 * @since 4.0.0
 */
export function toMultiDocumentOpenApi3_1(multiDocument: MultiDocument<"draft-2020-12">): MultiDocument<"openapi-3.1"> {
  const keyMap = new Map<string, string>()
  for (const key of Object.keys(multiDocument.definitions)) {
    const sanitized = sanitizeOpenApiComponentsSchemasKey(key)
    if (sanitized !== key) {
      keyMap.set(key, sanitized)
    }
  }

  function rewrite(schema: JsonSchema): JsonSchema {
    return rewrite_refs(schema, ($ref) => {
      const tokens = $ref.split("/")
      if (tokens.length > 0) {
        const identifier = unescapeToken(tokens[tokens.length - 1])
        const sanitized = keyMap.get(identifier)
        if (sanitized !== undefined) {
          $ref = tokens.slice(0, -1).join("/") + "/" + sanitized
        }
      }
      return $ref.replace(RE_DEFS, "#/components/schemas")
    }) as JsonSchema
  }

  return {
    dialect: "openapi-3.1",
    schemas: Arr.map(multiDocument.schemas, rewrite),
    definitions: Rec.mapEntries(
      multiDocument.definitions,
      (definition, key) => [keyMap.get(key) ?? key, rewrite(definition)]
    )
  }
}

/** @internal */
export const VALID_OPEN_API_COMPONENTS_SCHEMAS_KEY_REGEXP = /^[a-zA-Z0-9.\-_]+$/

/**
 * Returns a sanitized key for an OpenAPI component schema.
 * Should match the `^[a-zA-Z0-9.\-_]+$` regular expression.
 *
 * @internal
 */
export function sanitizeOpenApiComponentsSchemasKey(s: string): string {
  if (s.length === 0) return "_"
  if (VALID_OPEN_API_COMPONENTS_SCHEMAS_KEY_REGEXP.test(s)) return s

  const out: Array<string> = []

  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (
      code !== undefined &&
      ((code >= 48 && code <= 57) || // 0-9
        (code >= 65 && code <= 90) || // A-Z
        (code >= 97 && code <= 122) || // a-z
        code === 46 || // .
        code === 45 || // -
        code === 95) // _
    ) {
      out.push(ch)
    } else {
      out.push("_")
    }
  }

  return out.join("")
}

function rewrite_refs(node: unknown, f: ($ref: string) => string): unknown {
  if (Array.isArray(node)) return node.map((v) => rewrite_refs(v, f))
  if (!Predicate.isObject(node)) return node

  const out: Record<string, unknown> = {}

  for (const k of Object.keys(node)) {
    const v = node[k]

    if (k === "$ref") {
      out[k] = typeof v === "string" ? f(v) : v
    } else if (Array.isArray(v) || Predicate.isObject(v)) {
      out[k] = rewrite_refs(v, f)
    } else {
      out[k] = v
    }
  }

  return out
}

function walk_object(
  value: unknown,
  walk: (node: unknown, isRoot: boolean) => unknown
): Record<string, unknown> | undefined {
  if (!Predicate.isObject(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(value)) out[k] = walk(value[k], false)
  return out
}

function normalize_OpenApi3_0_to_Draft07(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize_OpenApi3_0_to_Draft07)
  if (!Predicate.isObject(node)) return node

  const src = node as Record<string, unknown>
  let out: Record<string, unknown> = {}

  for (const k of Object.keys(src)) {
    const v = src[k]
    if (k === "$ref" && typeof v === "string") {
      out[k] = v.replace(RE_COMPONENTS_SCHEMAS, "#/definitions")
    } else if (k === "example") {
      if (src.examples === undefined) {
        out.examples = [v]
      }
    } else if (Array.isArray(v) || Predicate.isObject(v)) {
      out[k] = normalize_OpenApi3_0_to_Draft07(v)
    } else {
      out[k] = v
    }
  }

  // Draft-04-style numeric exclusivity booleans
  out = adjust_exclusivity(out)

  // OpenAPI 3.0 nullable
  if (out.nullable === true) {
    out = apply_nullable(out)
  }
  delete out.nullable

  return out
}

function adjust_exclusivity(node: Record<string, unknown>): Record<string, unknown> {
  let out = node

  if (typeof out.exclusiveMinimum === "boolean") {
    if (out.exclusiveMinimum === true && typeof out.minimum === "number") {
      out = { ...out, exclusiveMinimum: out.minimum }
      delete out.minimum
    } else {
      out = { ...out }
      delete out.exclusiveMinimum
    }
  }

  if (typeof out.exclusiveMaximum === "boolean") {
    if (out.exclusiveMaximum === true && typeof out.maximum === "number") {
      out = { ...out, exclusiveMaximum: out.maximum }
      delete out.maximum
    } else {
      out = { ...out }
      delete out.exclusiveMaximum
    }
  }

  return out
}

function apply_nullable(node: Record<string, unknown>): Record<string, unknown> {
  // enum widening
  if (Array.isArray(node.enum)) {
    return widen_type({
      ...node,
      enum: node.enum.includes(null) ? node.enum : [...node.enum, null]
    })
  }

  // type widening
  if (node.type !== undefined) return widen_type(node)

  // const === null
  if (node.const === null) return node

  // fallback
  return { anyOf: [node, { type: "null" }] }
}

function widen_type(node: Record<string, unknown>): Record<string, unknown> {
  const t = node.type
  if (typeof t === "string") return t === "null" ? node : { ...node, type: [t, "null"] }
  if (Array.isArray(t)) return t.includes("null") ? node : { ...node, type: [...t, "null"] }
  return node
}

/**
 * Resolves a `$ref` string by looking up the last path segment in a
 * definitions map.
 *
 * **When to use**
 *
 * Use when you need to dereference a `$ref` pointer to get the actual
 * schema it points to.
 *
 * **Details**
 *
 * This only resolves the final segment of the ref path, such as `"User"` from
 * `"#/$defs/User"`. It returns `undefined` if the definition is not found.
 *
 * **Gotchas**
 *
 * This function does not follow arbitrary JSON Pointer paths.
 *
 * **Example** (Resolving a $ref)
 *
 * ```ts
 * import { JsonSchema } from "effect"
 *
 * const definitions: JsonSchema.Definitions = {
 *   User: { type: "object", properties: { name: { type: "string" } } }
 * }
 *
 * const result = JsonSchema.resolve$ref("#/$defs/User", definitions)
 * console.log(result) // { type: "object", properties: { name: { type: "string" } } }
 *
 * const missing = JsonSchema.resolve$ref("#/$defs/Unknown", definitions)
 * console.log(missing) // undefined
 * ```
 *
 * @see {@link resolveTopLevel$ref}
 * @see {@link Definitions}
 * @category getters
 * @since 4.0.0
 */
export function resolve$ref($ref: string, definitions: Definitions): JsonSchema | undefined {
  const tokens = $ref.split("/")
  if (tokens.length > 0) {
    const identifier = unescapeToken(tokens[tokens.length - 1])
    const definition = definitions[identifier]
    if (definition !== undefined) {
      return definition
    }
  }
}

/**
 * Resolves a document whose root schema is a top-level `$ref`.
 *
 * **When to use**
 *
 * Use to dereference a top-level `$ref` before inspecting the root
 * schema's properties directly.
 *
 * **Details**
 *
 * This returns the same object if no change is needed, or a shallow copy with
 * the resolved schema.
 *
 * **Example** (Resolving a top-level $ref)
 *
 * ```ts
 * import { JsonSchema } from "effect"
 *
 * const doc: JsonSchema.Document<"draft-2020-12"> = {
 *   dialect: "draft-2020-12",
 *   schema: { $ref: "#/$defs/User" },
 *   definitions: {
 *     User: { type: "object", properties: { name: { type: "string" } } }
 *   }
 * }
 *
 * const resolved = JsonSchema.resolveTopLevel$ref(doc)
 * console.log(resolved.schema) // { type: "object", properties: { name: { type: "string" } } }
 * ```
 *
 * @see {@link resolve$ref}
 * @see {@link Document}
 * @category transforming
 * @since 4.0.0
 */
export function resolveTopLevel$ref(document: Document<"draft-2020-12">): Document<"draft-2020-12"> {
  if (typeof document.schema.$ref === "string") {
    const schema = resolve$ref(document.schema.$ref, document.definitions)
    if (schema !== undefined) {
      return { ...document, schema }
    }
  }
  return document
}
