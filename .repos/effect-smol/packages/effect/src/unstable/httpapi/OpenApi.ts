/**
 * Generates OpenAPI 3.1 documents from declarative `HttpApi` contracts.
 *
 * The generator reads API groups, endpoints, schemas, security definitions, and
 * annotations, then produces an OpenAPI document. This module also provides the
 * annotations used to shape that output and the TypeScript model for the
 * OpenAPI objects it generates.
 *
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import type { NonEmptyArray } from "../../Array.ts"
import * as Context from "../../Context.ts"
import * as Equal from "../../Equal.ts"
import { constFalse } from "../../Function.ts"
import * as InternalRecord from "../../internal/record.ts"
import * as InternalToJsonSchemaDocument from "../../internal/schema/toJsonSchemaDocument.ts"
import * as InternalToRepresentation from "../../internal/schema/toRepresentation.ts"
import * as JsonPatch from "../../JsonPatch.ts"
import { escapeToken } from "../../JsonPointer.ts"
import * as JsonSchema from "../../JsonSchema.ts"
import * as Option from "../../Option.ts"
import * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import * as HttpMethod from "../http/HttpMethod.ts"
import * as HttpApi from "./HttpApi.ts"
import * as HttpApiEndpoint from "./HttpApiEndpoint.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"
import * as HttpApiMiddleware from "./HttpApiMiddleware.ts"
import * as HttpApiSchema from "./HttpApiSchema.ts"
import type { HttpApiSecurity } from "./HttpApiSecurity.ts"

/**
 * OpenAPI annotation for overriding generated identifiers, including operation ids.
 *
 * @category annotations
 * @since 4.0.0
 */
export class Identifier extends Context.Service<Identifier, string>()("effect/httpapi/OpenApi/Identifier") {}

/**
 * OpenAPI annotation for setting the API title or group tag name.
 *
 * @category annotations
 * @since 4.0.0
 */
export class Title extends Context.Service<Title, string>()("effect/httpapi/OpenApi/Title") {}

/**
 * OpenAPI annotation for setting the generated API version.
 *
 * @category annotations
 * @since 4.0.0
 */
export class Version extends Context.Service<Version, string>()("effect/httpapi/OpenApi/Version") {}

/**
 * OpenAPI annotation for setting generated descriptions on APIs, groups, endpoints, or security schemes.
 *
 * @category annotations
 * @since 4.0.0
 */
export class Description extends Context.Service<Description, string>()("effect/httpapi/OpenApi/Description") {}

/**
 * OpenAPI annotation for setting the generated API license metadata.
 *
 * @category annotations
 * @since 4.0.0
 */
export class License extends Context.Service<License, OpenAPISpecLicense>()("effect/httpapi/OpenApi/License") {}

/**
 * OpenAPI annotation for adding external documentation metadata to groups or endpoints.
 *
 * @category annotations
 * @since 4.0.0
 */
export class ExternalDocs
  extends Context.Service<ExternalDocs, OpenAPISpecExternalDocs>()("effect/httpapi/OpenApi/ExternalDocs")
{}

/**
 * OpenAPI annotation for setting the generated API server list.
 *
 * @category annotations
 * @since 4.0.0
 */
export class Servers
  extends Context.Service<Servers, ReadonlyArray<OpenAPISpecServer>>()("effect/httpapi/OpenApi/Servers")
{}

/**
 * OpenAPI annotation for setting the format metadata, such as a bearer token format on security schemes.
 *
 * @category annotations
 * @since 4.0.0
 */
export class Format extends Context.Service<Format, string>()("effect/httpapi/OpenApi/Format") {}

/**
 * OpenAPI annotation for setting generated summary text.
 *
 * @category annotations
 * @since 4.0.0
 */
export class Summary extends Context.Service<Summary, string>()("effect/httpapi/OpenApi/Summary") {}

/**
 * OpenAPI annotation for marking a generated endpoint operation as deprecated.
 *
 * @category annotations
 * @since 4.0.0
 */
export class Deprecated extends Context.Service<Deprecated, boolean>()("effect/httpapi/OpenApi/Deprecated") {}

/**
 * OpenAPI annotation for shallowly merging additional fields into a generated OpenAPI object.
 *
 * @category annotations
 * @since 4.0.0
 */
export class Override extends Context.Service<Override, Record<string, unknown>>()("effect/httpapi/OpenApi/Override") {}

/**
 * Annotation that excludes an annotated group or endpoint from the generated
 * OpenAPI specification.
 *
 * **When to use**
 *
 * Use to hide internal, experimental, or otherwise undocumented HTTP API groups
 * and endpoints from generated OpenAPI output.
 *
 * @category annotations
 * @since 4.0.0
 */
export const Exclude = Context.Reference<boolean>("effect/httpapi/OpenApi/Exclude", {
  defaultValue: constFalse
})

/**
 * OpenAPI annotation for transforming a generated OpenAPI object.
 *
 * **Details**
 *
 * The function is applied during generation to the annotated API, group tag, or
 * endpoint operation.
 *
 * @category annotations
 * @since 4.0.0
 */
export class Transform extends Context.Service<
  Transform,
  (openApiSpec: Record<string, any>) => Record<string, any>
>()("effect/httpapi/OpenApi/Transform") {}

const servicesPartial = <Tags extends Record<string, Context.Key<any, any> | Context.Key<never, any>>>(
  tags: Tags
): (
  options: {
    readonly [K in keyof Tags]?: Context.Service.Shape<Tags[K]> | undefined
  }
) => Context.Context<never> => {
  const entries = Object.entries(tags)
  return (options) => {
    let context = Context.empty()
    for (const [key, tag] of entries) {
      if (options[key] !== undefined) {
        context = Context.add(context, tag as any, options[key]!)
      }
    }
    return context
  }
}

/**
 * Builds a `Context` containing OpenAPI annotations from the supplied options.
 *
 * @category annotations
 * @since 4.0.0
 */
export const annotations: (
  options: {
    readonly identifier?: string | undefined
    readonly title?: string | undefined
    readonly version?: string | undefined
    readonly description?: string | undefined
    readonly license?: OpenAPISpecLicense | undefined
    readonly summary?: string | undefined
    readonly deprecated?: boolean | undefined
    readonly externalDocs?: OpenAPISpecExternalDocs | undefined
    readonly servers?: ReadonlyArray<OpenAPISpecServer> | undefined
    readonly format?: string | undefined
    readonly override?: Record<string, unknown> | undefined
    readonly exclude?: boolean | undefined
    readonly transform?: ((openApiSpec: Record<string, any>) => Record<string, any>) | undefined
  }
) => Context.Context<never> = servicesPartial({
  identifier: Identifier,
  title: Title,
  version: Version,
  description: Description,
  license: License,
  summary: Summary,
  deprecated: Deprecated,
  externalDocs: ExternalDocs,
  servers: Servers,
  format: Format,
  override: Override,
  exclude: Exclude,
  transform: Transform
})

const apiCache = new WeakMap<HttpApi.Constraint, OpenAPISpec>()

type CompileSchemas = (
  asts: readonly [SchemaAST.AST, ...Array<SchemaAST.AST>]
) => JsonSchema.MultiDocument<"openapi-3.1">

const compileSchemas: CompileSchemas = (asts) =>
  JsonSchema.toMultiDocumentOpenApi3_1(
    InternalToJsonSchemaDocument.toJsonSchemaMultiDocument(
      InternalToRepresentation.toRepresentations(Arr.map(asts, Schema.toCodecJsonAST))
    )
  )

/**
 * This function checks if a given tag exists within the provided context. If
 * the tag is present, it retrieves the associated value and applies the given
 * callback function to it. If the tag is not found, the function does nothing.
 */
function processAnnotation<Services, S, I>(
  ctx: Context.Context<Services>,
  annotation: Context.Key<I, S>,
  f: (s: S) => void
) {
  const o = Context.getOption(ctx, annotation)
  if (Option.isSome(o)) {
    f(o.value)
  }
}

/**
 * Converts an `HttpApi` instance into an OpenAPI Specification object.
 *
 * **Details**
 *
 * This function takes an `HttpApi` instance, which defines a structured API,
 * and generates an OpenAPI Specification (`OpenAPISpec`). The resulting spec
 * adheres to the OpenAPI 3.1.0 standard and includes detailed metadata such as
 * paths, operations, security schemes, and components. The function processes
 * the API's annotations, middleware, groups, and endpoints to build a complete
 * and accurate representation of the API in OpenAPI format.
 *
 * The function also deduplicates schemas, applies transformations, and
 * integrates annotations like descriptions, summaries, external documentation,
 * and overrides. Cached results are used for better performance when the same
 * `HttpApi` instance is processed multiple times.
 *
 * @category constructors
 * @since 4.0.0
 */
export function fromApi<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>
): OpenAPISpec {
  return fromApiWith(api, apiCache, compileSchemas)
}

function fromApiWith<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  cache: WeakMap<HttpApi.Constraint, OpenAPISpec>,
  compileSchemas: CompileSchemas
): OpenAPISpec {
  const cached = cache.get(api)
  if (cached !== undefined) {
    return cached
  }
  let spec: OpenAPISpec = {
    openapi: "3.1.0",
    info: {
      title: "Api",
      version: "0.0.1"
    },
    paths: {},
    components: {
      schemas: {},
      securitySchemes: {}
    },
    security: [],
    tags: []
  }

  const pathOps: Array<
    {
      readonly _tag: "schema"
      readonly ast: SchemaAST.AST
      readonly path: ReadonlyArray<string>
    } | {
      readonly _tag: "parameter"
      readonly ast: SchemaAST.AST
      readonly path: ReadonlyArray<string>
    }
  > = []
  const pathOperations = new Set<string>()
  const operationIds = new Set<string>()

  processAnnotation(api.annotations, Title, (title) => {
    spec.info.title = title
  })
  processAnnotation(api.annotations, Version, (version) => {
    spec.info.version = version
  })
  processAnnotation(api.annotations, Description, (description) => {
    spec.info.description = description
  })
  processAnnotation(api.annotations, License, (license) => {
    spec.info.license = license
  })
  processAnnotation(api.annotations, Summary, (summary) => {
    spec.info.summary = summary
  })
  processAnnotation(api.annotations, Servers, (servers) => {
    spec.servers = [...servers]
  })

  HttpApi.reflect(api, {
    onGroup({ group }) {
      if (Context.get(group.annotations, Exclude)) {
        return
      }
      let tag: OpenAPISpecTag = {
        name: Context.getOrElse(group.annotations, Title, () => group.identifier)
      }
      processAnnotation(group.annotations, Description, (description) => {
        tag.description = description
      })
      processAnnotation(group.annotations, ExternalDocs, (externalDocs) => {
        tag.externalDocs = externalDocs
      })
      processAnnotation(group.annotations, Override, (override) => {
        // OpenAPI documents are JSON, so symbol keys are intentionally ignored.
        for (const [key, value] of Object.entries(override)) {
          InternalRecord.assignProperty(tag as any, key, value)
        }
      })
      processAnnotation(group.annotations, Transform, (transformFn) => {
        tag = transformFn(tag) as OpenAPISpecTag
      })

      spec.tags.push(tag)
    },
    onEndpoint({ endpoint, group, mergedAnnotations, middleware }) {
      if (Context.get(mergedAnnotations, Exclude)) {
        return
      }
      let op: OpenAPISpecOperation = {
        tags: [Context.getOrElse(group.annotations, Title, () => group.identifier)],
        operationId: Context.getOrElse(
          endpoint.annotations,
          Identifier,
          () => group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`
        ),
        parameters: [],
        security: [],
        responses: {}
      }

      const path = endpoint.path.replace(/:(\w+)\??/g, "{$1}")
      const method = endpoint.method.toLowerCase() as OpenAPISpecMethodName

      function processResponseBodies(bodies: ResponseBodies, defaultDescription: () => string) {
        for (const [status, { content, descriptions, streamContent }] of bodies) {
          const description = descriptions.size > 0 ? Array.from(descriptions).join(" | ") : defaultDescription()
          InternalRecord.assignProperty(op.responses, status, {
            description
          })
          if (content !== undefined) {
            content.forEach((map, encoding) => {
              map.forEach((schemas, contentType) => {
                const asts = Array.from(schemas, SchemaAST.getAST)
                const ast = asts.length === 1 ? asts[0] : new SchemaAST.Union(asts, "anyOf")

                pathOps.push({
                  _tag: "schema",
                  ast: toEncodingAST(ast, encoding),
                  path: ["paths", path, method, "responses", String(status), "content", contentType, "schema"]
                })
                op.responses[status].content ??= {}
                InternalRecord.assignProperty(op.responses[status].content, contentType, {
                  schema: {}
                })
              })
            })
          }
          if (streamContent !== undefined) {
            streamContent.forEach((stream, contentType) => {
              op.responses[status].content ??= {}
              if (HttpApiSchema.isStreamSse(stream)) {
                pathOps.push({
                  _tag: "schema",
                  ast: SchemaAST.getAST(stream.events),
                  path: ["paths", path, method, "responses", String(status), "content", contentType, "schema"]
                })
                pathOps.push({
                  _tag: "schema",
                  ast: SchemaAST.getAST(Schema.toCodecJson(Schema.Cause(stream.error, Schema.Defect()))),
                  path: [
                    "paths",
                    path,
                    method,
                    "responses",
                    String(status),
                    "content",
                    contentType,
                    "x-effect-stream",
                    "causeSchema"
                  ]
                })
                pathOps.push({
                  _tag: "schema",
                  ast: SchemaAST.getAST(stream.error),
                  path: [
                    "paths",
                    path,
                    method,
                    "responses",
                    String(status),
                    "content",
                    contentType,
                    "x-effect-stream",
                    "errorSchema"
                  ]
                })
                InternalRecord.assignProperty(op.responses[status].content, contentType, {
                  schema: {},
                  "x-effect-stream": {
                    encoding: "sse",
                    causeSchema: {},
                    errorSchema: {},
                    failureEvent: reservedStreamFailureEvent
                  }
                })
              } else {
                InternalRecord.assignProperty(op.responses[status].content, contentType, {
                  schema: {
                    type: "string",
                    format: "binary"
                  },
                  "x-effect-stream": {
                    encoding: "uint8array"
                  }
                })
              }
            })
          }
        }
      }

      function processParameters(schema: Schema.Constraint | undefined, i: OpenAPISpecParameter["in"]) {
        if (schema) {
          const ast = SchemaAST.getLastEncoding(schema.ast)
          if (SchemaAST.isObjects(ast)) {
            for (const ps of ast.propertySignatures) {
              op.parameters.push({
                name: String(ps.name),
                in: i,
                schema: {},
                required: i === "path" || !SchemaAST.isOptional(ps.type)
              })
              pathOps.push({
                _tag: "parameter",
                ast: ps.type,
                path: ["paths", path, method, "parameters", String(op.parameters.length - 1), "schema"]
              })
            }
          }
        }
      }

      processAnnotation(endpoint.annotations, Description, (description) => {
        op.description = description
      })
      processAnnotation(endpoint.annotations, Summary, (summary) => {
        op.summary = summary
      })
      processAnnotation(endpoint.annotations, Deprecated, (deprecated) => {
        op.deprecated = deprecated
      })
      processAnnotation(endpoint.annotations, ExternalDocs, (externalDocs) => {
        op.externalDocs = externalDocs
      })

      middleware.forEach((middleware) => {
        if (!HttpApiMiddleware.isSecurity(middleware)) {
          return
        }
        for (const [name, security] of Object.entries(middleware.security)) {
          processHttpApiSecurity(name, security)
          op.security.push({ [name]: [] })
        }
      })

      function processHttpApiSecurity(
        name: string,
        security: HttpApiSecurity
      ) {
        const scheme = makeSecurityScheme(security)
        if (!Object.hasOwn(spec.components.securitySchemes, name)) {
          InternalRecord.assignProperty(spec.components.securitySchemes, name, scheme)
          return
        }
        if (
          !Equal.equals(
            securitySchemeForComparison(spec.components.securitySchemes[name]),
            securitySchemeForComparison(scheme)
          )
        ) {
          throw new globalThis.Error(`Conflicting OpenAPI security scheme: ${name}`)
        }
      }

      const hasBody = HttpMethod.hasBody(endpoint.method)
      if (hasBody) {
        const schemasByContentType = new Map<string, {
          readonly encoding: HttpApiSchema.PayloadEncoding
          readonly schemas: Array<Schema.Top>
        }>()
        for (const schema of HttpApiEndpoint.getPayloadSchemas(endpoint)) {
          if (HttpApiSchema.isNoContent(schema.ast)) continue
          const encoding = HttpApiSchema.getPayloadEncoding(schema.ast, endpoint.method)
          const existing = schemasByContentType.get(encoding.contentType)
          if (existing === undefined) {
            schemasByContentType.set(encoding.contentType, { encoding, schemas: [schema] })
          } else {
            existing.schemas.push(schema)
          }
        }
        if (schemasByContentType.size > 0) {
          const content: OpenApiSpecContent = {}
          for (const [contentType, { encoding, schemas }] of schemasByContentType) {
            const asts = schemas.map(SchemaAST.getAST)
            const ast = asts.length === 1 ? asts[0] : new SchemaAST.Union(asts, "anyOf")
            pathOps.push({
              _tag: "schema",
              ast: toEncodingAST(ast, encoding._tag),
              path: ["paths", path, method, "requestBody", "content", contentType, "schema"]
            })
            InternalRecord.assignProperty(content, contentType, {
              schema: {}
            })
          }
          op.requestBody = { content, required: true }
        }
      }

      processParameters(endpoint.params, "path")
      if (!hasBody && endpoint.payload.size === 1) {
        const entry = endpoint.payload.values().next().value!
        processParameters(entry.schemas[0], "query")
      }
      processParameters(endpoint.headers, "header")
      processParameters(endpoint.query, "query")

      processResponseBodies(
        extractSuccessResponseBodies(endpoint),
        () => "Success"
      )
      processResponseBodies(
        extractResponseBodies(
          HttpApiEndpoint.getErrorSchemas(endpoint),
          HttpApiSchema.getStatusError,
          resolveDescriptionOrIdentifier
        ),
        () => "Error"
      )

      processAnnotation(endpoint.annotations, Override, (override) => {
        // OpenAPI documents are JSON, so symbol keys are intentionally ignored.
        for (const [key, value] of Object.entries(override)) {
          InternalRecord.assignProperty(op as any, key, value)
        }
      })
      processAnnotation(endpoint.annotations, Transform, (transformFn) => {
        op = transformFn(op) as OpenAPISpecOperation
      })

      const pathOperation = `${method} ${path.replace(/\{[^}]+\}/g, "{}")}`
      if (pathOperations.has(pathOperation)) {
        throw new globalThis.Error(`Duplicate OpenAPI operation for ${endpoint.method} ${path}`)
      }
      const operationId = op.operationId
      if (operationId !== undefined) {
        if (operationIds.has(operationId)) {
          throw new globalThis.Error(`Duplicate OpenAPI operationId: ${operationId}`)
        }
        operationIds.add(operationId)
      }
      pathOperations.add(pathOperation)
      if (!Object.hasOwn(spec.paths, path)) {
        InternalRecord.assignProperty(spec.paths, path, {})
      }
      spec.paths[path][method] = op
    }
  })

  processAnnotation(api.annotations, HttpApi.AdditionalSchemas, (componentSchemas) => {
    componentSchemas.forEach((componentSchema) => {
      const identifier = SchemaAST.resolveIdentifier(componentSchema.ast)
      if (identifier !== undefined) {
        if (Object.hasOwn(spec.components.schemas, identifier)) {
          throw new globalThis.Error(`Duplicate component schema identifier: ${identifier}`)
        }
        InternalRecord.assignProperty(spec.components.schemas, identifier, {})
        pathOps.push({
          _tag: "schema",
          ast: componentSchema.ast,
          path: ["components", "schemas", identifier]
        })
      }
    })
  })

  function escapePath(path: ReadonlyArray<string>): string {
    return "/" + path.map(escapeToken).join("/")
  }

  if (Arr.isArrayNonEmpty(pathOps)) {
    const jsonSchemaMultiDocument = compileSchemas(Arr.map(pathOps, (op) => op.ast))
    const patchOps: Array<JsonPatch.JsonPatchOperation> = pathOps.map((op, i) => {
      const oppath = escapePath(op.path)
      const value = jsonSchemaMultiDocument.schemas[i]
      return {
        op: "replace",
        path: oppath,
        value: value as Schema.Json
      }
    })

    Object.entries(jsonSchemaMultiDocument.definitions).forEach(([name, definition]) => {
      patchOps.push({
        op: "add",
        path: escapePath(["components", "schemas", name]),
        value: definition as Schema.Json
      })
    })

    spec = JsonPatch.apply(patchOps, spec as any) as any
  }

  Object.keys(spec.components.schemas).forEach((key) => {
    if (!JsonSchema.VALID_OPEN_API_COMPONENTS_SCHEMAS_KEY_REGEXP.test(key)) {
      throw new globalThis.Error(`Invalid component schema key: ${key}`)
    }
  })

  processAnnotation(api.annotations, Override, (override) => {
    // OpenAPI documents are JSON, so symbol keys are intentionally ignored.
    for (const [key, value] of Object.entries(override)) {
      InternalRecord.assignProperty(spec as any, key, value)
    }
  })
  processAnnotation(api.annotations, Transform, (transformFn) => {
    spec = transformFn(spec) as OpenAPISpec
  })

  cache.set(api, spec)

  return spec
}

type ResponseBodies = Map<
  number, // status
  {
    descriptions: Set<string>
    content: Content | undefined // undefined means no content
    streamContent: StreamContent | undefined
  }
>

const reservedStreamFailureEvent = "effect/httpapi/stream/failure"

function extractSuccessResponseBodies(endpoint: HttpApiEndpoint.Top): ResponseBodies {
  return extractResponseBodies(
    HttpApiEndpoint.getSuccessSchemas(endpoint),
    HttpApiSchema.getStatusSuccess,
    resolveDescriptionOrIdentifier
  )
}

function extractResponseBodies(
  schemas: Array<Schema.Constraint>,
  getStatus: (ast: SchemaAST.AST) => number,
  getDescription: (ast: SchemaAST.AST) => string | undefined
): ResponseBodies {
  const map = new Map<number, {
    descriptions: Set<string>
    content: Content | undefined
    streamContent: StreamContent | undefined
  }>()

  schemas.forEach(process)

  return map

  function process(schema: Schema.Constraint) {
    if (HttpApiSchema.isStreamSchema(schema)) {
      addStreamContent(schema)
      return
    }
    const ast = schema.ast
    const status = getStatus(ast)
    if (HttpApiSchema.isNoContent(ast)) {
      addNoContent(status, getDescription(schema.ast) ?? "<No Content>")
    } else {
      addContent(schema, status, HttpApiSchema.getResponseEncoding(ast))
    }
  }

  function addNoContent(status: number, description: string) {
    const statusMap = map.get(status)
    if (statusMap === undefined) {
      map.set(status, {
        descriptions: new Set([description]),
        content: undefined,
        streamContent: undefined
      })
    } else {
      if (description !== undefined) {
        statusMap.descriptions.add(description)
      }
    }
  }

  function addContent(schema: Schema.Constraint, status: number, encoding: HttpApiSchema.Encoding) {
    const description = getDescription(schema.ast)
    const statusMap = map.get(status)
    const { _tag, contentType } = encoding
    if (statusMap === undefined) {
      map.set(status, {
        descriptions: new Set(description !== undefined ? [description] : []),
        content: new Map([[_tag, new Map([[contentType, new Set([schema])]])]]),
        streamContent: undefined
      })
    } else {
      // concat descriptions
      if (description !== undefined) {
        statusMap.descriptions.add(description)
      }

      if (statusMap.content === undefined) {
        statusMap.content = new Map([[_tag, new Map([[contentType, new Set([schema])]])]])
      } else {
        const schemasByContentType = statusMap.content.get(_tag)
        if (schemasByContentType === undefined) {
          statusMap.content.set(_tag, new Map([[contentType, new Set([schema])]]))
        } else {
          const set = schemasByContentType.get(contentType)
          if (set === undefined) {
            schemasByContentType.set(contentType, new Set([schema]))
          } else {
            set.add(schema)
          }
        }
      }
    }
  }

  function addStreamContent(stream: HttpApiSchema.StreamSchema) {
    const status = HttpApiSchema.getStatusStream(stream)
    const statusMap = map.get(status)
    if (statusMap === undefined) {
      map.set(status, {
        descriptions: new Set(),
        content: undefined,
        streamContent: new Map([[stream.contentType, stream]])
      })
    } else if (statusMap.streamContent === undefined) {
      statusMap.streamContent = new Map([[stream.contentType, stream]])
    } else {
      statusMap.streamContent.set(stream.contentType, stream)
    }
  }
}

function resolveDescriptionOrIdentifier(ast: SchemaAST.AST): string | undefined {
  return SchemaAST.resolveDescription(ast) ?? SchemaAST.resolveIdentifier(ast)
}

type Content = Map<
  HttpApiSchema.Encoding["_tag"],
  Map<
    string, // contentType
    Set<Schema.Constraint>
  >
>

type StreamContent = Map<string, HttpApiSchema.StreamSchema>

const Uint8ArrayEncoding = Schema.String.annotate({
  format: "binary"
})

function toEncodingAST(ast: SchemaAST.AST, _tag: HttpApiSchema.Encoding["_tag"]): SchemaAST.AST {
  switch (_tag) {
    case "Uint8Array":
      return Uint8ArrayEncoding.ast
    case "Text":
      return Schema.String.ast
    case "FormUrlEncoded":
    case "Json":
      return ast
    case "Multipart":
      return persistedFileToBinaryEncoding(ast)
  }
}

function persistedFileToBinaryEncoding(ast: SchemaAST.AST): SchemaAST.AST {
  if (
    SchemaAST.isDeclaration(ast) &&
    ((ast.annotations as (Schema.Annotations.Declaration<unknown, readonly []> | undefined))?.representation?.id ===
      "effect/http/PersistedFile")
  ) {
    return Uint8ArrayEncoding.ast
  }

  if (typeof (ast as any)?.recur === "function") {
    return (ast as any).recur(persistedFileToBinaryEncoding)
  }

  return ast
}

const makeSecurityScheme = (security: HttpApiSecurity): OpenAPISecurityScheme => {
  const meta: Partial<OpenAPISecurityScheme> = {}
  processAnnotation(security.annotations, Description, (description) => {
    meta.description = description
  })
  switch (security._tag) {
    case "Basic": {
      return {
        ...meta,
        type: "http",
        scheme: "basic"
      }
    }
    case "Http": {
      const format = Context.getOption(security.annotations, Format).pipe(
        Option.map((format) => ({ bearerFormat: format })),
        Option.getOrUndefined
      )
      return {
        ...meta,
        type: "http",
        scheme: security.scheme,
        ...format
      }
    }
    case "ApiKey": {
      return {
        ...meta,
        type: "apiKey",
        name: security.key,
        in: security.in
      }
    }
  }
}

const securitySchemeForComparison = (scheme: OpenAPISecurityScheme): OpenAPISecurityScheme => {
  if (scheme.type === "http") {
    return { ...scheme, scheme: scheme.scheme.toLowerCase() }
  }
  if (scheme.in === "header") {
    return { ...scheme, name: scheme.name.toLowerCase() }
  }
  return scheme
}

/**
 * This model describes the OpenAPI specification (version 3.1.0) returned by
 * {@link fromApi}. It is not intended to describe the entire OpenAPI
 * specification, only the output of `fromApi`.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpec {
  openapi: "3.1.0"
  info: OpenAPISpecInfo
  paths: OpenAPISpecPaths
  components: OpenAPIComponents
  security: Array<OpenAPISecurityRequirement>
  tags: Array<OpenAPISpecTag>
  servers?: Array<OpenAPISpecServer>
}

/**
 * OpenAPI `info` object generated by `fromApi`.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecInfo {
  title: string
  version: string
  description?: string
  license?: OpenAPISpecLicense
  summary?: string
}

/**
 * OpenAPI tag object generated for an HTTP API group.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecTag {
  name: string
  description?: string
  externalDocs?: OpenAPISpecExternalDocs
}

/**
 * OpenAPI external documentation metadata.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecExternalDocs {
  url: string
  description?: string
}

/**
 * OpenAPI license metadata used in the generated `info` object.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecLicense {
  name: string
  url?: string
  [key: string]: unknown
}

/**
 * OpenAPI server object used in the generated `servers` array.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecServer {
  url: string
  description?: string
  variables?: Record<string, OpenAPISpecServerVariable>
}

/**
 * OpenAPI variable definition for templated server URLs.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecServerVariable {
  default: string
  enum?: NonEmptyArray<string>
  description?: string
}

/**
 * Generated OpenAPI `paths` object, keyed by route path.
 *
 * @category models
 * @since 4.0.0
 */
export type OpenAPISpecPaths = Record<string, OpenAPISpecPathItem>

/**
 * Lowercase HTTP method names used as keys in generated OpenAPI path items.
 *
 * @category models
 * @since 4.0.0
 */
export type OpenAPISpecMethodName =
  | "get"
  | "put"
  | "post"
  | "delete"
  | "options"
  | "head"
  | "patch"
  | "trace"

/**
 * Generated OpenAPI path item mapping HTTP methods to operations for a single route path.
 *
 * @category models
 * @since 4.0.0
 */
export type OpenAPISpecPathItem = {
  [K in OpenAPISpecMethodName]?: OpenAPISpecOperation
}

/**
 * Generated OpenAPI parameter object for path, query, header, or cookie parameters.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecParameter {
  name: string
  in: "query" | "header" | "path" | "cookie"
  schema: object
  required: boolean
  description?: string
}

/**
 * Generated OpenAPI responses object, keyed by HTTP status code.
 *
 * @category models
 * @since 4.0.0
 */
export type OpenAPISpecResponses = Record<number, OpenApiSpecResponse>

/**
 * Generated OpenAPI content object, keyed by media type.
 *
 * @category models
 * @since 4.0.0
 */
export type OpenApiSpecContent = {
  [K in string]: OpenApiSpecMediaType
}

/**
 * Generated OpenAPI response object for an endpoint success or error schema.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenApiSpecResponse {
  description: string
  content?: OpenApiSpecContent
}

/**
 * Generated OpenAPI media type object containing the JSON Schema for a request or response body.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenApiSpecMediaType {
  schema: JsonSchema.JsonSchema
  "x-effect-stream"?: OpenApiSpecEffectStream
}

/**
 * Effect-specific metadata for generated streaming response media types.
 *
 * @category models
 * @since 4.0.0
 */
export type OpenApiSpecEffectStream =
  | {
    encoding: "sse"
    causeSchema: JsonSchema.JsonSchema
    errorSchema: JsonSchema.JsonSchema
    failureEvent: "effect/httpapi/stream/failure"
  }
  | {
    encoding: "uint8array"
  }

/**
 * Generated OpenAPI request body object for endpoint payloads.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecRequestBody {
  content: OpenApiSpecContent
  required: true
}

/**
 * Generated OpenAPI components containing shared schemas and security schemes.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPIComponents {
  schemas: JsonSchema.Definitions
  securitySchemes: Record<string, OpenAPISecurityScheme>
}

/**
 * Generated OpenAPI HTTP security scheme, such as bearer or basic authentication.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPIHTTPSecurityScheme {
  readonly type: "http"
  scheme: "bearer" | "basic" | string
  description?: string
  /* only for scheme: 'bearer' */
  bearerFormat?: string
}

/**
 * Generated OpenAPI API key security scheme.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPIApiKeySecurityScheme {
  readonly type: "apiKey"
  name: string
  in: "query" | "header" | "cookie"
  description?: string
}

/**
 * Union of security scheme objects emitted in generated OpenAPI components.
 *
 * @category models
 * @since 4.0.0
 */
export type OpenAPISecurityScheme =
  | OpenAPIHTTPSecurityScheme
  | OpenAPIApiKeySecurityScheme

/**
 * Generated OpenAPI security requirement, keyed by security scheme name.
 *
 * @category models
 * @since 4.0.0
 */
export type OpenAPISecurityRequirement = Record<string, Array<string>>

/**
 * Generated OpenAPI operation object for an HTTP API endpoint.
 *
 * @category models
 * @since 4.0.0
 */
export interface OpenAPISpecOperation {
  operationId: string
  parameters: Array<OpenAPISpecParameter>
  responses: OpenAPISpecResponses
  /** Always contains at least the title annotation or the group identifier */
  tags: NonEmptyArray<string>
  security: Array<OpenAPISecurityRequirement>
  requestBody?: OpenAPISpecRequestBody
  description?: string
  summary?: string
  deprecated?: boolean
  externalDocs?: OpenAPISpecExternalDocs
}
