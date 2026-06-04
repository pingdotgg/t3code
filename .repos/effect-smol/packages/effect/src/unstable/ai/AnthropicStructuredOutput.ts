/**
 * Adapt Effect Schema codecs to the JSON Schema subset accepted by Anthropic
 * structured output.
 *
 * The main entry point is {@link toCodecAnthropic}. It returns the JSON Schema
 * to send to Anthropic and a codec that preserves the original decoded value
 * type while changing the encoded representation when Anthropic cannot express
 * that shape directly.
 *
 * **Mental model**
 *
 * Anthropic structured output accepts a narrower schema vocabulary than Effect
 * Schema. This module walks the encoded schema AST before JSON Schema
 * generation, rewrites unsupported shapes into provider-safe encodings, and
 * leaves the returned codec responsible for translating model output back into
 * the original application shape.
 *
 * **Common tasks**
 *
 * - Convert a `Schema.Codec` for Anthropic structured output with
 *   {@link toCodecAnthropic}
 * - Decode model output with the returned codec so transformed tuples, records,
 *   and optional properties become the original values again
 * - Preserve provider-compatible descriptions and formats while dropping or
 *   rewriting annotations Anthropic cannot represent
 *
 * **Gotchas**
 *
 * - The emitted JSON Schema may use an encoded shape: tuples become objects
 *   with numeric string keys, records become arrays of `[key, value]` pairs, and
 *   optional properties become required properties that accept `null`.
 * - Unsupported schema kinds throw during conversion rather than producing a
 *   lossy schema.
 * - `oneOf` unions are emitted as `anyOf` unions because Anthropic's structured
 *   output subset does not support the full JSON Schema vocabulary.
 *
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as JsonSchema from "../../JsonSchema.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import * as AST from "../../SchemaAST.ts"
import * as Transformation from "../../SchemaTransformation.ts"
import * as LanguageModel from "./LanguageModel.ts"
import * as OpenAiStructuredOutput from "./OpenAiStructuredOutput.ts"
import * as Tool from "./Tool.ts"

/**
 * Transforms a `Schema.Codec` into a form compatible with Anthropic's structured output constraints.
 *
 * **When to use**
 *
 * Use to adapt an `Effect` `Schema.Codec` for Anthropic structured output by
 * returning an Anthropic-compatible JSON Schema together with a codec that
 * preserves the decoded value type.
 *
 * **Details**
 *
 * The transformation walks the schema AST and rewrites constructs that Anthropic does not support natively:
 *
 * - **Tuples** are converted to objects with numeric string keys (e.g.
 *   `"0"`, `"1"`) since Anthropic does not support tuple schemas. Rest
 *   elements are placed under a `"__rest__"` key.
 * - **Optional properties** are replaced with `T | null` unions, because
 *   Anthropic requires all properties to be present.
 * - **Records** (index signatures) are converted to arrays of `[key, value]`
 *   pairs.
 * - **`oneOf` unions** are rewritten as `anyOf` unions.
 * - **Filters and annotations** are preserved where compatible (e.g.
 *   `description`, supported `format` values like `"date-time"`, `"email"`,
 *   `"uuid"`, etc.), and stripped otherwise.
 *
 * If the schema is already compatible, the original codec is returned
 * unchanged.
 *
 * @see {@link LanguageModel.CodecTransformer} for the structured-output transformer contract
 * @see {@link OpenAiStructuredOutput.toCodecOpenAI} for the OpenAI-specific transformer
 *
 * @category Codec Transformation
 * @since 4.0.0
 */
export function toCodecAnthropic<T, E, RD, RE>(
  schema: Schema.Codec<T, E, RD, RE>
): {
  readonly codec: Schema.Codec<T, unknown, RD, RE>
  readonly jsonSchema: JsonSchema.JsonSchema
} {
  const to = schema.ast
  const from = recur(AST.toEncoded(to))
  const codec = from === to ? schema : Schema.make<typeof schema>(AST.decodeTo(from, to, Transformation.passthrough()))
  const document = JsonSchema.resolveTopLevel$ref(Schema.toJsonSchemaDocument(codec))
  const jsonSchema = { ...document.schema }
  if (Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions
  }
  return { codec, jsonSchema }
}

function recur(ast: AST.AST): AST.AST {
  switch (ast._tag) {
    case "Declaration":
    case "Void":
    case "Never":
    case "Unknown":
    case "Any":
    case "BigInt":
    case "Symbol":
    case "UniqueSymbol":
    case "ObjectKeyword":
    case "Enum":
    case "TemplateLiteral":
    case "Suspend":
      return unsupportedAst(
        ast,
        "Anthropic structured output does not support this schema kind; consider transforming the schema or using a different provider"
      )
    case "Undefined":
      return unsupportedAst(
        ast,
        "Anthropic structured output does not support undefined; consider transforming the schema or using a different provider; if using `Schema.optional`, consider using `Schema.optionalKey` instead"
      )
    case "Null":
      return ast
    case "String": {
      const { annotations, filters } = get(ast)
      if (annotations !== undefined || filters !== undefined) {
        return new AST.String(annotations, filters)
      }
      return ast
    }
    case "Number": {
      const { annotations, filters } = get(ast)
      if (annotations !== undefined || filters !== undefined) {
        return new AST.Number(annotations, filters)
      }
      return ast
    }
    case "Boolean":
      return ast
    case "Literal": {
      const literal = ast.literal
      if (typeof literal === "string" || typeof literal === "number" || typeof literal === "boolean") {
        const { annotations, filters } = get(ast)
        if (annotations !== undefined || filters !== undefined) {
          return new AST.Literal(ast.literal, annotations, filters)
        }
        return ast
      }
      throw new Error(
        `${errorPrefix}: Unsupported literal type ${typeof literal} (value: ${
          String(literal)
        }) (supported: string | number | boolean)`
      )
    }
    case "Union": {
      if (ast.mode === "oneOf") {
        return new AST.Union(ast.types, "anyOf", ast.annotations, ast.checks)
      }
      const types = AST.mapOrSame(ast.types, recur)
      const { annotations, filters } = get(ast)
      if (types !== ast.types || annotations !== undefined || filters !== undefined) {
        return new AST.Union(types, "anyOf", annotations, filters)
      }
      return ast
    }
    case "Arrays": {
      if (ast.rest.length > 1) {
        throw new Error(
          `${errorPrefix}: Post-rest elements are not supported for arrays (rest length: ${ast.rest.length})`
        )
      }
      let { annotations, filters } = get(ast)
      if (ast.elements.length > 0) {
        // tuples are not supported by Anthropic, we translate them to objects with string keys
        if (annotations !== undefined && typeof annotations.description === "string") {
          annotations.description = `${TUPLE_DESCRIPTION}; ${annotations.description}`
        } else {
          annotations ??= {}
          annotations.description = TUPLE_DESCRIPTION
        }
        const propertySignatures = ast.elements.map((e, i) => {
          return new AST.PropertySignature(String(i), e)
        })
        if (ast.rest.length === 1) {
          propertySignatures.push(new AST.PropertySignature(REST_PROPERTY_NAME, new AST.Arrays(false, [], ast.rest)))
        }
        return AST.decodeTo(
          recur(new AST.Objects(propertySignatures, [], annotations, filters)),
          ast,
          Transformation.transform({
            decode: (o) => {
              let t: Array<unknown> = []
              for (let i = 0; i < ast.elements.length; i++) {
                const k = String(i)
                if (o[k] !== undefined) {
                  t.push(o[k])
                }
              }
              if (REST_PROPERTY_NAME in o) {
                t = [...t, ...o[REST_PROPERTY_NAME]]
              }
              return t
            },
            encode: (t) => {
              const o: Record<string, unknown> = {}
              for (let i = 0; i < ast.elements.length; i++) {
                if (t.length >= i) {
                  o[String(i)] = t[i]
                }
              }
              if (ast.rest.length === 1) {
                o[REST_PROPERTY_NAME] = t.length >= ast.elements.length ? t.slice(ast.elements.length) : []
              }
              return o
            }
          })
        )
      } else {
        const rest = AST.mapOrSame(ast.rest, recur)
        if (rest !== ast.rest || annotations !== undefined || filters !== undefined) {
          return new AST.Arrays(false, [], rest, annotations, filters)
        }
        return ast
      }
    }
    case "Objects": {
      let { annotations, filters } = get(ast)
      if (ast.indexSignatures.length === 0) {
        const propertySignatures = AST.mapOrSame(ast.propertySignatures, (ps) => {
          if (typeof ps.name !== "string") {
            throw new Error(
              `${errorPrefix}: Property names must be strings (got ${typeof ps.name})`
            )
          }
          let type = recur(ps.type)
          // opttional properties are not supported by Anthropic, so we translate them to nullable unions
          if (AST.isOptional(ps.type)) {
            type = AST.decodeTo(
              new AST.Union([type, AST.null], "anyOf"),
              AST.optionalKey(type),
              Transformation.transformOptional({
                decode: Option.filter(Predicate.isNotNull),
                encode: Option.orElseSome(() => null)
              })
            )
          }
          if (type === ps.type) {
            return ps
          }
          return new AST.PropertySignature(ps.name, type)
        })
        if (
          propertySignatures !== ast.propertySignatures || annotations !== undefined || filters !== undefined
        ) {
          return new AST.Objects(propertySignatures, [], annotations, filters)
        }
      } else if (ast.indexSignatures.length === 1 && ast.propertySignatures.length === 0) {
        const is = ast.indexSignatures[0]
        if (Tool.isEmptyParamsRecord(is)) {
          return ast
        }
        // records are not supported by Anthropic, so we translate them to arrays of key-value pairs
        if (annotations !== undefined && typeof annotations.description === "string") {
          annotations.description = `${RECORD_DESCRIPTION}; ${annotations.description}`
        } else {
          annotations ??= {}
          annotations.description = RECORD_DESCRIPTION
        }
        return AST.decodeTo(
          recur(new AST.Arrays(false, [], [new AST.Arrays(false, [is.parameter, is.type], [])], annotations)),
          ast,
          Transformation.transform({
            decode: Object.fromEntries,
            encode: Object.entries
          })
        )
      } else {
        throw new Error(
          `${errorPrefix}: unsupported object schema shape (properties: ${ast.propertySignatures.length}, indexSignatures: ${ast.indexSignatures.length}). Supported: plain objects (properties only) or records (single index signature, no properties)`
        )
      }
      return ast
    }
  }
}

const errorPrefix = "AnthropicStructuredOutput"

function unsupportedAst(ast: AST.AST, details?: string): never {
  const base = `Unsupported AST ${ast._tag}`
  const full = `${errorPrefix}: ${base}`
  throw new Error(details !== undefined ? `${full} (${details})` : full)
}

const REST_PROPERTY_NAME = "__rest__"

const RECORD_DESCRIPTION =
  "Object encoded as array of [key, value] pairs. Apply object constraints to the decoded object"

const TUPLE_DESCRIPTION =
  "Tuple encoded as an object with numeric string keys ('0', '1', ...). If present, '__rest__' contains remaining elements"

type Annotation =
  | { readonly _tag: "description"; readonly description: string }
  | { readonly _tag: "format"; readonly format: string }

type Filter =
  | Annotation
  | { readonly _tag: "filter"; readonly filter: AST.Filter<any> }

const get = (ast: AST.AST): {
  annotations: Record<string, string> | undefined
  filters: [AST.Check<any>, ...AST.Check<any>[]] | undefined
} => {
  const annotations: Record<string, string> = {}
  const filters: Array<AST.Filter<any>> = []
  const checks = getChecks(ast)
  if (checks.length > 0) {
    for (const check of checks) {
      switch (check._tag) {
        case "description": {
          if (annotations.description !== undefined) {
            annotations.description += ` and ${check.description}`
          } else {
            annotations.description = check.description
          }
          break
        }
        case "format": {
          annotations.format = check.format
          break
        }
        case "filter": {
          filters.push(check.filter)
          break
        }
      }
    }
  }
  return {
    annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
    filters: Arr.isArrayNonEmpty(filters) ? filters : undefined
  }
}

const getChecks = (ast: AST.AST): Array<Filter> => [
  ...(ast.checks !== undefined ? getFilters(ast.checks) : []),
  ...getAnnotations(ast.annotations)
]

const getAnnotations = (annotations: Schema.Annotations.Filter | undefined): Array<Annotation> => {
  const out: Array<Annotation> = []
  if (annotations !== undefined) {
    const description = annotations?.description
      ?? (annotations.meta?._tag === "isInt" || annotations.meta?._tag === "isFinite"
        ? undefined
        : annotations?.expected)
    if (typeof description === "string") {
      out.push({ _tag: "description", description })
    }
    const format = annotations?.format
    if (typeof format === "string") {
      if (formats.includes(format)) {
        out.push({ _tag: "format", format })
      } else {
        out.push({ _tag: "description", description: `a value with a format of ${format}` })
      }
    }
  }
  return out
}

function getFilter(filter: AST.Filter<any>): Array<Filter> {
  let out: Array<Filter> = []
  const annotations = getAnnotations(filter.annotations)
  const meta = filter.annotations?.meta
  if (meta !== undefined) {
    switch (meta._tag) {
      case "isInt":
      case "isFinite": {
        out = out.concat(annotations)
        out.push({ _tag: "filter", filter: resetFilter(filter) })
        break
      }
      default: {
        out = out.concat(annotations)
        break
      }
    }
    if ("regExp" in meta && meta.regExp instanceof RegExp) {
      out.push({ _tag: "filter", filter: resetFilter(filter) })
    }
  }
  return out
}

function resetFilter(filter: AST.Filter<any>): AST.Filter<any> {
  return filter.annotate({
    description: undefined,
    expected: undefined,
    title: undefined,
    format: undefined
  })
}

function getFilters(checks: readonly [AST.Check<any>, ...AST.Check<any>[]]): Array<Filter> {
  return checks.flatMap((check) => {
    switch (check._tag) {
      case "Filter":
        return getFilter(check)
      case "FilterGroup":
        return getFilters(check.checks)
    }
  })
}

const formats = [
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid"
]
