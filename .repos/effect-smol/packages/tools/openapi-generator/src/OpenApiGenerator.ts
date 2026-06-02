/**
 * The `OpenApiGenerator` module orchestrates converting OpenAPI and Swagger
 * documents into generated Effect source.
 *
 * It normalizes Swagger 2.0 input, resolves local references, builds the
 * parsed operation model, registers request and response schemas, applies
 * HttpApi-specific adaptations such as multipart helpers and security metadata,
 * emits warnings for unsupported or lossy OpenAPI features, and then delegates
 * final rendering to the HttpClient or HttpApi code generators.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as JsonSchema from "effect/JsonSchema"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as String from "effect/String"
import type { OpenAPISecurityScheme, OpenAPISpec, OpenAPISpecMethodName } from "effect/unstable/httpapi/OpenApi"
import SwaggerToOpenApi from "swagger2openapi"
import * as HttpApiTransformer from "./HttpApiTransformer.ts"
import * as JsonSchemaGenerator from "./JsonSchemaGenerator.ts"
import * as OpenApiTransformer from "./OpenApiTransformer.ts"
import * as ParsedOperation from "./ParsedOperation.ts"
import * as Utils from "./Utils.ts"

/**
 * Service for turning OpenAPI or Swagger specifications into generated Effect
 * HTTP client or HttpApi source code.
 *
 * @category services
 * @since 4.0.0
 */
export class OpenApiGenerator extends Context.Service<
  OpenApiGenerator,
  { readonly generate: (spec: OpenAPISpec, options: OpenApiGenerateOptions) => Effect.Effect<string> }
>()("OpenApiGenerator") {}

/**
 * Output targets supported by the OpenAPI generator.
 *
 * @category models
 * @since 4.0.0
 */
export type OpenApiGeneratorFormat = "httpclient" | "httpclient-type-only" | "httpapi"

/**
 * Stable identifiers for non-fatal OpenAPI generation warnings.
 *
 * @category models
 * @since 4.0.0
 */
export type OpenApiGeneratorWarningCode =
  | "cookie-parameter-dropped"
  | "additional-tags-dropped"
  | "sse-operation-skipped"
  | "response-headers-ignored"
  | "optional-request-body-approximated"
  | "default-response-remapped"
  | "security-and-downgraded"
  | "no-body-method-request-body-skipped"
  | "naming-collision"

/**
 * Describes a non-fatal issue encountered while mapping an OpenAPI operation to
 * generated Effect source.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenApiGeneratorWarning {
  readonly code: OpenApiGeneratorWarningCode
  readonly message: string
  readonly path?: string | undefined
  readonly method?: OpenAPISpecMethodName | undefined
  readonly operationId?: string | undefined
}

/**
 * Options that control one OpenAPI generation run.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenApiGenerateOptions {
  /**
   * The name to give to the generated output.
   */
  readonly name: string
  /**
   * The output format to generate.
   */
  readonly format: OpenApiGeneratorFormat
  /**
   * Hook to transform each JSON Schema node before processing.
   */
  readonly onEnter?: ((js: JsonSchema.JsonSchema) => JsonSchema.JsonSchema) | undefined
  /**
   * Callback to receive non-fatal generation warnings.
   */
  readonly onWarning?: ((warning: OpenApiGeneratorWarning) => void) | undefined
}

interface HttpApiMultipartSchemaRefs {
  readonly singleFile: string
  readonly files: string
}

const methodNames: ReadonlyArray<OpenAPISpecMethodName> = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace"
]

/**
 * Constructs the OpenAPI generator service implementation.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.gen(function*() {
  const generate = Effect.fn(
    function*(spec: OpenAPISpec, options: OpenApiGenerateOptions) {
      const generator = JsonSchemaGenerator.make()
      const openApiTransformer = yield* OpenApiTransformer.OpenApiTransformer
      const emitWarning = makeWarningEmitter(options)

      // If we receive a Swagger 2.0 spec, convert it to an OpenApi 3.0 spec
      if (isSwaggerSpec(spec)) {
        spec = yield* convertSwaggerSpec(spec)
      }

      function resolveRef(ref: string) {
        const parts = ref.split("/").slice(1)
        let current: any = spec
        for (const part of parts) {
          current = current[part]
        }
        return current
      }

      const multipartSchemaRefs = options.format === "httpapi"
        ? makeHttpApiMultipartSchemaRefs(spec.components?.schemas ?? {})
        : undefined

      const parsed = parseOpenApi(spec, generator, resolveRef, options.format, emitWarning, multipartSchemaRefs)

      // TODO: make a CLI option ?
      const importName = "Schema"
      const source = getDialect(spec)
      const generation = options.format === "httpapi"
        ? generator.generateHttpApi(
          source,
          withHttpApiMultipartSchemas(spec.components?.schemas ?? {}, multipartSchemaRefs),
          {
            onEnter: options.onEnter,
            multipartSchemaRefs
          }
        )
        : generator.generate(
          source,
          spec.components?.schemas ?? {},
          options.format === "httpclient-type-only",
          {
            onEnter: options.onEnter
          }
        )

      if (options.format === "httpapi") {
        const needsMultipartImport = generation.includes("Multipart.")
        return String.stripMargin(
          `|${HttpApiTransformer.imports(importName, { multipart: needsMultipartImport })}
           |${generation}
           |${HttpApiTransformer.toImplementation(importName, options.name, parsed)}`
        )
      }

      return String.stripMargin(
        `|${openApiTransformer.imports(importName, parsed)}
         |${generation}
         |${openApiTransformer.toImplementation(importName, options.name, parsed)}
         |
         |${openApiTransformer.toTypes(importName, options.name, parsed)}`
      )
    },
    (effect, _, options) =>
      Effect.provideServiceEffect(
        effect,
        OpenApiTransformer.OpenApiTransformer,
        options.format === "httpclient-type-only"
          ? Effect.sync(OpenApiTransformer.makeTransformerTs)
          : Effect.sync(OpenApiTransformer.makeTransformerSchema)
      )
  )

  return { generate } as const
})

type WarningEmitter = (warning: OpenApiGeneratorWarning) => void

const makeWarningEmitter = (options: OpenApiGenerateOptions): WarningEmitter => (warning) => {
  options.onWarning?.(warning)
}

const parseOpenApi = (
  spec: OpenAPISpec,
  generator: ReturnType<typeof JsonSchemaGenerator.make>,
  resolveRef: (ref: string) => unknown,
  format: OpenApiGeneratorFormat,
  emitWarning: WarningEmitter,
  multipartSchemaRefs: HttpApiMultipartSchemaRefs | undefined
): ParsedOperation.ParsedOpenApi => {
  const operations: Array<ParsedOperation.ParsedOperation> = []
  const reservedSchemaNames = new Set<string>(Object.keys(spec.components?.schemas ?? {}))
  const isHttpApi = format === "httpapi"
  const securitySchemes = isHttpApi ? parseSecuritySchemes(spec, resolveRef) : []

  const addSchema = (
    baseName: string,
    schema: JsonSchema.JsonSchema,
    operation: ParsedOperation.ParsedOperation
  ): string => {
    let candidate = baseName
    let index = 2
    while (reservedSchemaNames.has(candidate)) {
      candidate = `${baseName}${index}`
      index += 1
    }
    if (candidate !== baseName) {
      warnForOperation(emitWarning, operation, {
        code: "naming-collision",
        message: `Schema name "${baseName}" collided with an existing name and was renamed to "${candidate}".`
      })
    }
    reservedSchemaNames.add(candidate)
    return generator.addSchema(candidate, schema)
  }

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of methodNames) {
      const operation = methods[method]

      if (Predicate.isUndefined(operation)) {
        continue
      }

      const id = operation.operationId
        ? Utils.camelize(operation.operationId)
        : `${method.toUpperCase()}${path}`

      const description = Utils.nonEmptyString(operation.description) ?? Utils.nonEmptyString(operation.summary)

      const { pathIds, pathTemplate } = processPath(path)

      const op = ParsedOperation.makeDeepMutable({
        id,
        method,
        description,
        pathIds,
        pathTemplate
      })
      op.path = path
      op.operationId = Utils.nonEmptyString(operation.operationId)
      op.tags = [...(operation.tags ?? [])]
      if (isHttpApi && op.tags.length > 1) {
        warnForOperation(emitWarning, op, {
          code: "additional-tags-dropped",
          message: `Additional tags (${op.tags.slice(1).join(", ")}) were dropped. Only the first tag ("${
            op.tags[0]
          }") is used for grouping.`
        })
      }
      op.metadata = {
        summary: Utils.nonEmptyString(operation.summary),
        description: Utils.nonEmptyString(operation.description),
        deprecated: operation.deprecated === true,
        externalDocs: operation.externalDocs
      }
      op.effectiveSecurity = cloneSecurityRequirements(operation.security ?? spec.security ?? [])
      if (isHttpApi) {
        warnForAndSecurityRequirements(emitWarning, op)
      }

      const schemaId = Utils.identifier(operation.operationId ?? path)

      const pathParameters = Predicate.isObject(methods) && Array.isArray((methods as any).parameters)
        ? (methods as any).parameters as ReadonlyArray<unknown>
        : undefined
      const parameters = resolveOperationParameters(
        pathParameters,
        Array.isArray(operation.parameters) ? operation.parameters : undefined,
        resolveRef
      )
      for (const parameter of parameters) {
        const parsedParameter: ParsedOperation.ParsedOperationParameter = {
          name: parameter.name,
          in: parameter.in,
          required: parameter.required === true,
          description: Utils.nonEmptyString(parameter.description),
          schema: parameter.schema
        }
        switch (parameter.in) {
          case "path": {
            op.parameters.path.push(parsedParameter)
            break
          }
          case "query": {
            op.parameters.query.push(parsedParameter)
            break
          }
          case "header": {
            op.parameters.header.push(parsedParameter)
            break
          }
          case "cookie": {
            op.parameters.cookie.push(parsedParameter)
            warnForOperation(emitWarning, op, {
              code: "cookie-parameter-dropped",
              message:
                `Cookie parameter "${parameter.name}" was dropped because non-security cookie parameters are not supported.`
            })
            break
          }
        }
      }

      const requestBody = resolveReference(operation.requestBody, resolveRef)
      if (isHttpApi && !methodSupportsRequestBody(op.method) && Predicate.isObject(requestBody)) {
        warnForOperation(emitWarning, op, {
          code: "no-body-method-request-body-skipped",
          message: `Operation was skipped because ${op.method.toUpperCase()} does not support request bodies.`
        })
        continue
      }

      const resolvedResponses = Object.entries(operation.responses ?? {}).map(
        ([status, response]) => [status, resolveReference(response, resolveRef)] as const
      )
      const hasExplicitSuccessResponse = resolvedResponses.some(([status]) => {
        if (!/^\d{3}$/.test(status)) {
          return false
        }
        return Number(status) < 400
      })

      if (isHttpApi && hasSuccessfulSseResponse(resolvedResponses, hasExplicitSuccessResponse)) {
        warnForOperation(emitWarning, op, {
          code: "sse-operation-skipped",
          message:
            "Operation was skipped because successful text/event-stream responses are not supported in HttpApi generation."
        })
        continue
      }

      const validParameters = parameters.filter((parameter) => parameter.in !== "path" && parameter.in !== "cookie")

      const combinedParameterSchema = buildParameterSchema(validParameters, (parameter, added) => {
        if (parameter.in === "query") {
          Utils.spreadElementsInto(added, op.urlParams)
        } else if (parameter.in === "header") {
          Utils.spreadElementsInto(added, op.headers)
        } else if (parameter.in === "cookie") {
          Utils.spreadElementsInto(added, op.cookies)
        }
      })

      if (combinedParameterSchema !== undefined) {
        op.params = addSchema(`${schemaId}Params`, combinedParameterSchema.schema, op)
        op.paramsOptional = combinedParameterSchema.optional
      }

      if (isHttpApi) {
        const pathParameterSchema = buildParameterSchema(op.parameters.path)
        if (pathParameterSchema !== undefined) {
          op.pathSchema = addSchema(`${schemaId}PathParams`, pathParameterSchema.schema, op)
        }

        const queryParameterSchema = buildParameterSchema(op.parameters.query)
        if (queryParameterSchema !== undefined) {
          op.querySchema = addSchema(`${schemaId}Query`, queryParameterSchema.schema, op)
          op.querySchemaOptional = queryParameterSchema.optional
        }

        const headerParameterSchema = buildParameterSchema(op.parameters.header)
        if (headerParameterSchema !== undefined) {
          op.headersSchema = addSchema(`${schemaId}Headers`, headerParameterSchema.schema, op)
          op.headersSchemaOptional = headerParameterSchema.optional
        }
      }

      if (Predicate.isNotUndefined(requestBody) && Predicate.isObject(requestBody)) {
        const content = Predicate.isObject(requestBody.content)
          ? requestBody.content as Record<string, any>
          : {}
        const requestSchemaNames = new Map<string, string>()
        op.requestBody = {
          required: requestBody.required === true,
          contentTypes: Object.keys(content)
        }
        if (isHttpApi && requestBody.required === false) {
          warnForOperation(emitWarning, op, {
            code: "optional-request-body-approximated",
            message: "Optional request body was approximated by adding a no-content payload alternative."
          })
        }

        if (Predicate.isNotUndefined(content["application/json"]?.schema)) {
          op.payload = addSchema(`${schemaId}RequestJson`, content["application/json"].schema, op)
          requestSchemaNames.set("application/json", op.payload)
        }

        if (Predicate.isNotUndefined(content["multipart/form-data"]?.schema)) {
          op.payload = addSchema(
            `${schemaId}RequestFormData`,
            transformMultipartSchema(content["multipart/form-data"].schema, multipartSchemaRefs, resolveRef),
            op
          )
          op.payloadFormData = true
          requestSchemaNames.set("multipart/form-data", op.payload)
        }

        if (Predicate.isNotUndefined(content["application/x-www-form-urlencoded"]?.schema)) {
          op.payload = addSchema(
            `${schemaId}RequestFormUrlEncoded`,
            content["application/x-www-form-urlencoded"].schema,
            op
          )
          op.payloadFormUrlEncoded = true
          requestSchemaNames.set("application/x-www-form-urlencoded", op.payload)
        }

        if (isHttpApi) {
          const representableRequestBody: Array<ParsedOperation.ParsedOperationMediaTypeSchema> = []
          for (const [contentType, mediaType] of Object.entries(content)) {
            if (!Predicate.isObject(mediaType) || Predicate.isUndefined(mediaType.schema)) {
              continue
            }
            const encoding = getRequestMediaTypeEncoding(contentType)
            if (encoding === undefined) {
              continue
            }
            let schemaName = requestSchemaNames.get(contentType)
            if (schemaName === undefined) {
              const schema = encoding === "multipart"
                ? transformMultipartSchema(mediaType.schema as JsonSchema.JsonSchema, multipartSchemaRefs, resolveRef)
                : mediaType.schema as JsonSchema.JsonSchema
              schemaName = addSchema(
                `${schemaId}Request${mediaTypeToSuffix(contentType)}`,
                schema,
                op
              )
              requestSchemaNames.set(contentType, schemaName)
            }
            representableRequestBody.push({
              contentType,
              encoding,
              schema: schemaName
            })
          }
          op.requestBodyRepresentable = representableRequestBody
        }
      }

      let defaultSchema: string | undefined
      for (const [status, response] of resolvedResponses) {
        if (!Predicate.isObject(response)) {
          continue
        }

        const parsedStatus = isHttpApi
          ? remapDefaultResponseStatusForHttpApi(status, hasExplicitSuccessResponse)
          : status
        if (isHttpApi && status === "default") {
          warnForOperation(emitWarning, op, {
            code: "default-response-remapped",
            message: `Default response was remapped to status ${parsedStatus} for HttpApi generation.`
          })
        }

        const content = Predicate.isObject(response.content)
          ? response.content as Record<string, any>
          : undefined
        if (isHttpApi && Predicate.isNotUndefined(response.headers)) {
          warnForOperation(emitWarning, op, {
            code: "response-headers-ignored",
            message: `Response headers on status ${status} were ignored in HttpApi generation.`
          })
        }
        const representable: Array<ParsedOperation.ParsedOperationMediaTypeSchema> = []

        let jsonSchemaName: string | undefined
        const jsonResponseSchema = content?.["application/json"]?.schema
        if (Predicate.isNotUndefined(jsonResponseSchema)) {
          jsonSchemaName = addSchema(`${schemaId}${status}`, jsonResponseSchema, op)
          if (isHttpApi) {
            representable.push({
              contentType: "application/json",
              encoding: "json",
              schema: jsonSchemaName
            })
          }
        }

        if (isHttpApi) {
          for (const [contentType, mediaType] of Object.entries(content ?? {})) {
            if (contentType === "application/json") {
              continue
            }
            if (!Predicate.isObject(mediaType) || Predicate.isUndefined(mediaType.schema)) {
              continue
            }
            const encoding = getResponseMediaTypeEncoding(contentType)
            if (encoding === undefined) {
              continue
            }
            const schemaName = addSchema(
              `${schemaId}${status}${mediaTypeToSuffix(contentType)}`,
              mediaType.schema as JsonSchema.JsonSchema,
              op
            )
            representable.push({
              contentType,
              encoding,
              schema: schemaName
            })
          }
        }

        const isEmptyResponse = Predicate.isUndefined(content) || Object.keys(content).length === 0
        const parsedResponse = {
          status: parsedStatus,
          description: Utils.nonEmptyString(response.description),
          contentTypes: Predicate.isNotUndefined(content) ? Object.keys(content) : [],
          hasHeaders: Predicate.isNotUndefined(response.headers),
          isEmpty: isEmptyResponse,
          representable
        }
        op.responses.push(parsedResponse)
        if (status === "default") {
          op.defaultResponse = parsedResponse
        }

        if (Predicate.isNotUndefined(jsonSchemaName)) {
          const schemaName = jsonSchemaName

          if (status === "default" && !isHttpApi) {
            defaultSchema = schemaName
            continue
          }

          const statusLower = parsedStatus.toLowerCase()
          const statusMajorNumber = Number(parsedStatus[0])
          if (Number.isNaN(statusMajorNumber)) {
            continue
          }
          if (statusMajorNumber < 4) {
            op.successSchemas.set(statusLower, schemaName)
          } else {
            op.errorSchemas.set(statusLower, schemaName)
          }
        }

        const sseResponseSchema = content?.["text/event-stream"]?.schema
        if (Predicate.isUndefined(op.sseSchema) && Predicate.isNotUndefined(sseResponseSchema)) {
          const statusMajorNumber = Number(parsedStatus[0])
          if (!Number.isNaN(statusMajorNumber) && statusMajorNumber < 4) {
            op.sseSchema = addSchema(`${schemaId}${status}Sse`, sseResponseSchema, op)
          }
        }

        if (Predicate.isNotUndefined(content?.["application/octet-stream"])) {
          const statusMajorNumber = Number(parsedStatus[0])
          if (!Number.isNaN(statusMajorNumber) && statusMajorNumber < 4) {
            op.binaryResponse = true
          }
        }

        if (isEmptyResponse) {
          if (parsedStatus !== "default") {
            op.voidSchemas.add(parsedStatus.toLowerCase())
          }
        }
      }

      if (!isHttpApi && op.successSchemas.size === 0 && Predicate.isNotUndefined(defaultSchema)) {
        op.successSchemas.set("2xx", defaultSchema)
        warnForOperation(emitWarning, op, {
          code: "default-response-remapped",
          message: "Default response was remapped to 2xx for the current HttpClient outputs."
        })
      }

      operations.push(op)
    }
  }

  return {
    metadata: {
      title: spec.info.title,
      version: spec.info.version,
      summary: Utils.nonEmptyString(spec.info.summary),
      description: Utils.nonEmptyString(spec.info.description),
      license: spec.info.license,
      servers: spec.servers
    },
    tags: (spec.tags ?? []).map((tag) => ({
      name: tag.name,
      description: Utils.nonEmptyString(tag.description),
      externalDocs: tag.externalDocs
    })),
    securitySchemes,
    operations
  }
}

interface OpenApiParameter {
  readonly name: string
  readonly in: "path" | "query" | "header" | "cookie"
  readonly required: boolean
  readonly schema: {}
  readonly description?: string | undefined
}

const isOpenApiParameter = (parameter: unknown): parameter is OpenApiParameter => {
  if (!Predicate.isObject(parameter)) {
    return false
  }
  return (
    typeof parameter.name === "string" &&
    (parameter.in === "path" || parameter.in === "query" || parameter.in === "header" || parameter.in === "cookie")
  )
}

const resolveOperationParameters = (
  pathParameters: ReadonlyArray<unknown> | undefined,
  operationParameters: ReadonlyArray<unknown> | undefined,
  resolveRef: (ref: string) => unknown
): Array<OpenApiParameter> => {
  const resolved = new Map<string, OpenApiParameter>()
  const add = (parameter: unknown): void => {
    const current = resolveReference(parameter, resolveRef)
    if (!isOpenApiParameter(current)) {
      return
    }

    const key = `${current.in}:${current.name}`
    if (resolved.has(key)) {
      resolved.delete(key)
    }
    resolved.set(key, current)
  }

  for (const parameter of pathParameters ?? []) {
    add(parameter)
  }

  for (const parameter of operationParameters ?? []) {
    add(parameter)
  }

  return [...resolved.values()]
}

const buildParameterSchema = <
  Parameter extends {
    readonly name: string
    readonly required: boolean
    readonly schema: {}
    readonly in?: "path" | "query" | "header" | "cookie" | undefined
  }
>(
  parameters: ReadonlyArray<Parameter>,
  onAdded?: ((parameter: Parameter, added: Array<string>) => void) | undefined
): {
  readonly schema: JsonSchema.JsonSchema
  readonly optional: boolean
} | undefined => {
  if (parameters.length === 0) {
    return
  }

  const schema = {
    type: "object" as JsonSchema.Type,
    properties: {} as Record<string, JsonSchema.JsonSchema>,
    required: [] as Array<string>,
    additionalProperties: false
  }

  for (const parameter of parameters) {
    const paramSchema = parameter.schema as any
    const added: Array<string> = []
    if (
      Predicate.isObject(paramSchema) &&
      "properties" in paramSchema &&
      Predicate.isObject(paramSchema.properties)
    ) {
      const required = "required" in paramSchema
        ? paramSchema.required as Array<string>
        : []

      for (const [name, propertySchema] of Object.entries(paramSchema.properties)) {
        const adjustedName = `${parameter.name}[${name}]`
        schema.properties[adjustedName] = propertySchema as JsonSchema.JsonSchema
        if (required.includes(name)) {
          schema.required.push(adjustedName)
        }
        added.push(adjustedName)
      }
    } else {
      schema.properties[parameter.name] = parameter.schema as JsonSchema.JsonSchema
      if (parameter.required) {
        schema.required.push(parameter.name)
      }
      added.push(parameter.name)
    }

    onAdded?.(parameter, added)
  }

  return {
    schema,
    optional: schema.required.length === 0
  }
}

const mediaTypeToSuffix = (contentType: string): string => {
  const normalized = contentType.toLowerCase()
  switch (normalized) {
    case "application/json":
      return "Json"
    case "multipart/form-data":
      return "FormData"
    case "application/x-www-form-urlencoded":
      return "FormUrlEncoded"
    case "text/plain":
      return "Text"
    case "application/octet-stream":
      return "Binary"
  }
  const suffix = Utils.identifier(contentType)
  return suffix.length > 0 ? suffix : "Body"
}

const makeHttpApiMultipartSchemaRefs = (definitions: JsonSchema.Definitions): HttpApiMultipartSchemaRefs => {
  const names = new Set(Object.keys(definitions))
  const allocate = (base: string): string => {
    let candidate = base
    let index = 2
    while (names.has(candidate)) {
      candidate = `${base}${index}`
      index += 1
    }
    names.add(candidate)
    return candidate
  }
  return {
    singleFile: allocate("__HttpApiMultipartSingleFile"),
    files: allocate("__HttpApiMultipartFiles")
  }
}

const toDefinitionRef = (name: string): string => `#/$defs/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`

const withHttpApiMultipartSchemas = (
  definitions: JsonSchema.Definitions,
  multipartSchemaRefs: HttpApiMultipartSchemaRefs | undefined
): JsonSchema.Definitions => {
  if (multipartSchemaRefs === undefined) {
    return definitions
  }
  return {
    ...definitions,
    [multipartSchemaRefs.singleFile]: {
      type: "string",
      format: "binary"
    },
    [multipartSchemaRefs.files]: {
      type: "array",
      items: {
        $ref: toDefinitionRef(multipartSchemaRefs.singleFile)
      }
    }
  }
}

const transformMultipartSchema = (
  schema: JsonSchema.JsonSchema,
  multipartSchemaRefs: HttpApiMultipartSchemaRefs | undefined,
  resolveRef: (ref: string) => unknown
): JsonSchema.JsonSchema => {
  if (multipartSchemaRefs === undefined) {
    return schema
  }

  const singleFileRef = toDefinitionRef(multipartSchemaRefs.singleFile)
  const filesRef = toDefinitionRef(multipartSchemaRefs.files)
  const cache = new Map<string, unknown>()
  const stack = new Set<string>()

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(visit)
    }
    if (!Predicate.isObject(value)) {
      return value
    }

    if (typeof value.$ref === "string" && value.$ref.startsWith("#/components/schemas/")) {
      const cached = cache.get(value.$ref)
      if (cached !== undefined) {
        return cached
      }
      if (stack.has(value.$ref)) {
        return value
      }
      stack.add(value.$ref)
      const transformed = visit(resolveSchemaReference(value.$ref, resolveRef))
      stack.delete(value.$ref)
      cache.set(value.$ref, transformed)
      return transformed
    }

    if (isMultipartBinaryFile(value)) {
      return { $ref: singleFileRef }
    }

    const out: Record<string, unknown> = {}
    for (const [key, current] of Object.entries(value)) {
      out[key] = visit(current)
    }

    if (isMultipartBinaryFiles(out, singleFileRef)) {
      return { $ref: filesRef }
    }

    return out
  }

  return visit(schema) as JsonSchema.JsonSchema
}

const resolveSchemaReference = (ref: string, resolveRef: (ref: string) => unknown): unknown => {
  let current: unknown = { $ref: ref }
  const seen = new Set<string>()
  while (Predicate.isObject(current) && typeof current.$ref === "string") {
    if (seen.has(current.$ref)) {
      return current
    }
    seen.add(current.$ref)
    current = resolveRef(current.$ref)
  }
  return current
}

const isMultipartBinaryFile = (value: unknown): value is JsonSchema.JsonSchema =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  (
    (typeof value.format === "string" && value.format.toLowerCase() === "binary") ||
    (typeof value.contentEncoding === "string" && value.contentEncoding.toLowerCase() === "binary")
  )

const isMultipartBinaryFiles = (value: Record<string, unknown>, singleFileRef: string): boolean => {
  if (value.type !== "array") {
    return false
  }
  const items = value.items
  return isMultipartBinaryFile(items) || (Predicate.isObject(items) && items.$ref === singleFileRef)
}

const isJsonMediaType = (contentType: string): boolean =>
  contentType === "application/json" ||
  (contentType.startsWith("application/") && contentType.endsWith("+json"))

const isTextMediaType = (contentType: string): boolean => contentType.startsWith("text/")

const isBinaryMediaType = (contentType: string): boolean =>
  contentType === "application/octet-stream" ||
  (contentType.startsWith("application/") && (contentType.includes("binary") || contentType.endsWith("+octet-stream")))

const getRequestMediaTypeEncoding = (
  contentType: string
): ParsedOperation.ParsedOperationMediaTypeEncoding | undefined => {
  const normalized = contentType.toLowerCase()
  if (isJsonMediaType(normalized)) {
    return "json"
  }
  if (normalized === "multipart/form-data") {
    return "multipart"
  }
  if (normalized === "application/x-www-form-urlencoded") {
    return "form-url-encoded"
  }
  if (isTextMediaType(normalized)) {
    return "text"
  }
  if (isBinaryMediaType(normalized)) {
    return "binary"
  }
  return
}

const getResponseMediaTypeEncoding = (
  contentType: string
): ParsedOperation.ParsedOperationMediaTypeEncoding | undefined => {
  const normalized = contentType.toLowerCase()
  if (isJsonMediaType(normalized)) {
    return "json"
  }
  if (normalized === "application/x-www-form-urlencoded") {
    return "form-url-encoded"
  }
  if (isTextMediaType(normalized)) {
    return "text"
  }
  if (isBinaryMediaType(normalized)) {
    return "binary"
  }
  return
}

const resolveReference = (input: unknown, resolveRef: (ref: string) => unknown): any => {
  let current = input
  while (Predicate.isObject(current) && typeof current.$ref === "string") {
    current = resolveRef(current.$ref)
  }
  return current
}

const cloneSecurityRequirements = (
  security: ReadonlyArray<Record<string, ReadonlyArray<string>>>
): Array<ParsedOperation.ParsedOperationSecurityRequirement> =>
  security.map((requirement) =>
    Object.fromEntries(
      Object.entries(requirement).map(([name, scopes]) => [name, [...scopes]])
    )
  )

const parseSecuritySchemes = (
  spec: OpenAPISpec,
  resolveRef: (ref: string) => unknown
): Array<ParsedOperation.ParsedOpenApiSecurityScheme> => {
  const securitySchemes = spec.components?.securitySchemes ?? {}
  const parsed: Array<ParsedOperation.ParsedOpenApiSecurityScheme> = []

  for (const [name, value] of Object.entries(securitySchemes)) {
    const scheme = resolveReference(value, resolveRef) as OpenAPISecurityScheme | undefined
    if (!Predicate.isObject(scheme)) {
      continue
    }

    if (scheme.type === "http" && typeof scheme.scheme === "string") {
      const normalizedScheme = scheme.scheme.toLowerCase()
      if (normalizedScheme === "basic") {
        parsed.push({
          name,
          type: "basic",
          description: Utils.nonEmptyString(scheme.description),
          bearerFormat: undefined,
          scheme: undefined,
          key: undefined,
          in: undefined
        })
      } else if (normalizedScheme === "bearer") {
        parsed.push({
          name,
          type: "bearer",
          description: Utils.nonEmptyString(scheme.description),
          bearerFormat: Utils.nonEmptyString(scheme.bearerFormat),
          scheme: undefined,
          key: undefined,
          in: undefined
        })
      } else {
        parsed.push({
          name,
          type: "http",
          description: Utils.nonEmptyString(scheme.description),
          bearerFormat: Utils.nonEmptyString(scheme.bearerFormat),
          scheme: scheme.scheme,
          key: undefined,
          in: undefined
        })
      }
      continue
    }

    if (
      scheme.type === "apiKey" &&
      (scheme.in === "header" || scheme.in === "query" || scheme.in === "cookie") &&
      typeof scheme.name === "string"
    ) {
      parsed.push({
        name,
        type: "apiKey",
        description: Utils.nonEmptyString(scheme.description),
        bearerFormat: undefined,
        scheme: undefined,
        key: scheme.name,
        in: scheme.in
      })
    }
  }

  return parsed
}

const warnForAndSecurityRequirements = (
  emitWarning: WarningEmitter,
  operation: ParsedOperation.ParsedOperation
): void => {
  if (operation.effectiveSecurity.some((requirement) => Object.keys(requirement).length === 0)) {
    return
  }
  for (const requirement of operation.effectiveSecurity) {
    const schemes = Object.keys(requirement)
    if (schemes.length <= 1) {
      continue
    }
    warnForOperation(emitWarning, operation, {
      code: "security-and-downgraded",
      message: `Security requirement requiring all of [${
        schemes.join(", ")
      }] was downgraded to a placeholder middleware.`
    })
  }
}

const hasSuccessfulSseResponse = (
  responses: ReadonlyArray<readonly [string, unknown]>,
  hasExplicitSuccessResponse: boolean
): boolean => {
  for (const [status, response] of responses) {
    if (!Predicate.isObject(response)) {
      continue
    }
    const content = Predicate.isObject(response.content)
      ? response.content as Record<string, any>
      : undefined
    if (Predicate.isUndefined(content?.["text/event-stream"]?.schema)) {
      continue
    }

    const remappedStatus = remapDefaultResponseStatusForHttpApi(status, hasExplicitSuccessResponse)
    const statusCode = Number(remappedStatus)
    if (!Number.isNaN(statusCode) && statusCode < 400) {
      return true
    }
  }
  return false
}

const remapDefaultResponseStatusForHttpApi = (status: string, hasExplicitSuccessResponse: boolean): string =>
  status === "default" ? (hasExplicitSuccessResponse ? "500" : "200") : status

const methodSupportsRequestBody = (method: OpenAPISpecMethodName): boolean =>
  method !== "get" && method !== "head" && method !== "options" && method !== "trace"

const warnForOperation = (
  emitWarning: WarningEmitter,
  operation: ParsedOperation.ParsedOperation,
  warning: {
    readonly code: OpenApiGeneratorWarningCode
    readonly message: string
  }
): void => {
  emitWarning({
    ...warning,
    path: operation.path,
    method: operation.method,
    operationId: operation.operationId
  })
}

function getDialect(spec: OpenAPISpec): "openapi-3.0" | "openapi-3.1" {
  return spec.openapi.trim().startsWith("3.0") ? "openapi-3.0" : "openapi-3.1"
}

/**
 * Layer providing an OpenAPI generator for Schema-backed HTTP client and HttpApi output.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerTransformerSchema: Layer.Layer<OpenApiGenerator> = Layer.effect(OpenApiGenerator, make)

/**
 * Layer providing an OpenAPI generator for type-only HTTP client output.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerTransformerTs: Layer.Layer<OpenApiGenerator> = Layer.effect(OpenApiGenerator, make)

const isSwaggerSpec = (spec: OpenAPISpec) => "swagger" in spec

const convertSwaggerSpec = Effect.fn((spec: OpenAPISpec) =>
  Effect.callback<OpenAPISpec>((resume) => {
    SwaggerToOpenApi.convertObj(
      spec as any,
      { laxDefaults: true, laxurls: true, patch: true, warnOnly: true },
      (err, result) => {
        if (err) {
          resume(Effect.die(err))
        } else {
          resume(Effect.succeed(result.openapi as any))
        }
      }
    )
  }).pipe(Effect.withSpan("OpenApi.convertSwaggerSpec"))
)

const processPath = (path: string): {
  readonly pathIds: Array<string>
  readonly pathTemplate: string
} => {
  const pathIds: Array<string> = []
  path = path.replace(/{([^}]+)}/g, (_, name) => {
    const id = Utils.camelize(name)
    pathIds.push(id)
    return "${" + id + "}"
  })
  const pathTemplate = "`" + path + "`"
  return { pathIds, pathTemplate } as const
}
