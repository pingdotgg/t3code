/**
 * Renders parsed OpenAPI operations into generated Effect HttpApi source code.
 *
 * This module maps normalized OpenAPI metadata, tags, request bodies,
 * responses, and security requirements into import declarations, HttpApi
 * groups, endpoint definitions, schema annotations, and middleware classes.
 * The rendered TypeScript can be emitted by the OpenAPI generator as an
 * executable Effect `HttpApi` module.
 *
 * @since 4.0.0
 */
import * as Codegen from "effect/Codegen"
import { namedImport, namespaceImport, printImports } from "./internal/module.ts"
import type {
  ParsedOpenApi,
  ParsedOpenApiSecurityScheme,
  ParsedOpenApiTag,
  ParsedOperation,
  ParsedOperationMediaTypeSchema,
  ParsedOperationResponse
} from "./ParsedOperation.ts"
import * as Utils from "./Utils.ts"

const HttpApi = Codegen.importNamed("effect/http-api", "HttpApi")
const HttpApiEndpoint = Codegen.importNamed("effect/http-api", "HttpApiEndpoint")
const HttpApiGroup = Codegen.importNamed("effect/http-api", "HttpApiGroup")
const HttpApiMiddleware = Codegen.importNamed("effect/http-api", "HttpApiMiddleware")
const HttpApiSchema = Codegen.importNamed("effect/http-api", "HttpApiSchema")
const HttpApiSecurity = Codegen.importNamed("effect/http-api", "HttpApiSecurity")
const OpenApi = Codegen.importNamed("effect/http-api", "OpenApi")

interface GroupRenderModel {
  readonly identifier: string
  readonly topLevel: boolean
  readonly metadata: ParsedOpenApiTag | undefined
  readonly operations: ReadonlyArray<ParsedOperation>
  readonly constName: string
}

interface SecurityRenderModel {
  readonly securityDeclarations: ReadonlyArray<Codegen.Fragment>
  readonly middlewareDeclarations: ReadonlyArray<Codegen.Fragment>
  readonly endpointMiddlewares: ReadonlyMap<string, ReadonlyArray<string>>
}

const fallbackGroupIdentifier = "default"

/**
 * Render the import declarations required by generated HttpApi source.
 *
 * **Details**
 *
 * The schema namespace import is named by the caller so generated code can
 * avoid collisions with symbols already present in the output module. Multipart
 * support is included only when the parsed OpenAPI document needs it.
 *
 * @category code generation
 * @since 4.0.0
 */
export const imports = (
  importName: string,
  options?: {
    readonly multipart?: boolean | undefined
  }
): string => printImports(moduleImports(importName, options?.multipart === true))

const moduleImports = (importName: string, multipart: boolean): ReadonlyArray<Codegen.Import> => [
  namespaceImport("effect/Schema", importName),
  ...(multipart ? [namedImport("effect/http", "Multipart")] : []),
  ...["HttpApi", "HttpApiEndpoint", "HttpApiGroup", "HttpApiMiddleware", "HttpApiSchema", "HttpApiSecurity", "OpenApi"]
    .map((name) => namedImport("effect/http-api", name))
]

/**
 * Convert a parsed OpenAPI document into Effect HttpApi source code.
 *
 * **Details**
 *
 * The generated implementation contains security declarations, reusable
 * middleware classes, HttpApi groups, endpoint definitions, and OpenAPI
 * annotations derived from the parsed operation metadata.
 *
 * @category code generation
 * @since 4.0.0
 */
export const toImplementation = (
  _importName: string,
  name: string,
  parsed: ParsedOpenApi
): string => {
  const module = new Codegen.Module()
  return module.finalize([planImplementation(name, parsed, makeNameAllocator())(parsed)]).roots[0]
}

/** @internal */
export const registerModule = (
  module: Codegen.Module,
  importName: string,
  name: string,
  parsed: ParsedOpenApi
): (parsed: ParsedOpenApi) => Codegen.Fragment => {
  for (const input of moduleImports(importName, false)) module.addImport(input)
  const api = module.declare(name)
  return planImplementation(api.name, parsed, (name) => module.declare(name).name)
}

const planImplementation = (
  name: string,
  parsed: ParsedOpenApi,
  allocateName: (name: string) => string
): (parsed: ParsedOpenApi) => Codegen.Fragment => {
  const security = buildSecurityRenderModel(parsed, allocateName)
  const groups = groupOperations(parsed, allocateName)
  const positions = new Map(parsed.operations.map((operation, index) => [operation, index]))
  const metadataAnnotations = renderApiAnnotations(parsed)

  let apiValue = Codegen.code`export class ${name} extends ${HttpApi}.make(${JSON.stringify(name)})`
  for (const annotation of metadataAnnotations) {
    apiValue = Codegen.code`${apiValue}\n  .${annotation}`
  }
  if (groups.length > 0) {
    apiValue = Codegen.code`${apiValue}\n  .add(${groups.map((group) => group.constName).join(", ")})`
  }
  apiValue = Codegen.code`${apiValue} {}`

  return (resolved) =>
    Codegen.join([
      ...security.securityDeclarations,
      ...security.middlewareDeclarations,
      ...groups.map((group) =>
        renderGroup({
          ...group,
          operations: group.operations.map((operation) => resolved.operations[positions.get(operation)!])
        }, security.endpointMiddlewares)
      ),
      apiValue
    ], "\n\n")
}

const groupOperations = (
  parsed: ParsedOpenApi,
  allocateName: (name: string) => string
): ReadonlyArray<GroupRenderModel> => {
  const tagMetadata = new Map(parsed.tags.map((tag) => [tag.name, tag]))
  const byIdentifier = new Map<string, {
    readonly identifier: string
    topLevel: boolean
    readonly metadata: ParsedOpenApiTag | undefined
    readonly operations: Array<ParsedOperation>
  }>()

  for (const operation of parsed.operations) {
    const identifier = operation.tags[0] ?? fallbackGroupIdentifier
    const topLevel = operation.tags.length === 0
    const existing = byIdentifier.get(identifier)
    if (existing) {
      if (topLevel) {
        existing.topLevel = true
      }
      existing.operations.push(operation)
      continue
    }
    byIdentifier.set(identifier, {
      identifier,
      topLevel,
      metadata: tagMetadata.get(identifier),
      operations: [operation]
    })
  }

  const groups: Array<GroupRenderModel> = []
  for (const group of byIdentifier.values()) {
    const baseName = ensureIdentifier(group.identifier, "Group")
    groups.push({
      ...group,
      constName: allocateName(`${baseName}Group`)
    })
  }
  return groups
}

const renderGroup = (
  group: GroupRenderModel,
  endpointMiddlewares: ReadonlyMap<string, ReadonlyArray<string>>
): Codegen.Fragment => {
  let source = Codegen.code`class ${group.constName} extends ${HttpApiGroup}.make(${JSON.stringify(group.identifier)}${
    group.topLevel ? ", { topLevel: true }" : ""
  })`

  const allocateEndpointName = makeNameAllocator()
  const endpointSources = group.operations.map((operation) =>
    renderEndpoint(
      operation,
      allocateEndpointName(operation.id),
      endpointMiddlewares.get(toOperationKey(operation)) ?? []
    )
  )
  if (endpointSources.length > 0) {
    source = Codegen.code`${source}\n  .add(${Codegen.join(endpointSources, ", \n    ")})`
  }

  if (group.metadata?.description !== undefined) {
    source = Codegen.code`${source}\n  .annotate(${OpenApi}.Description, ${JSON.stringify(group.metadata.description)})`
  }
  if (group.metadata?.externalDocs !== undefined) {
    source = Codegen.code`${source}\n  .annotate(${OpenApi}.ExternalDocs, ${
      JSON.stringify(group.metadata.externalDocs)
    })`
  }

  source = Codegen.code`${source} {}`

  return source
}

const renderEndpoint = (
  operation: ParsedOperation,
  endpointName: string,
  endpointMiddlewares: ReadonlyArray<string>
): Codegen.Fragment => {
  const options: Array<Codegen.Fragment> = []
  if (operation.pathSchema !== undefined) {
    options.push(Codegen.code`params: ${operation.pathSchema}`)
  }
  if (operation.querySchema !== undefined) {
    options.push(Codegen.code`query: ${operation.querySchema}`)
  }
  if (operation.headersSchema !== undefined) {
    options.push(Codegen.code`headers: ${operation.headersSchema}`)
  }

  const payload = renderPayload(operation)
  if (payload !== undefined) {
    options.push(Codegen.code`payload: ${payload}`)
  }

  const success = renderResponseSet(operation.responses, "success")
  if (success !== undefined) {
    options.push(Codegen.code`success: ${success}`)
  }

  const error = renderResponseSet(operation.responses, "error")
  if (error !== undefined) {
    options.push(Codegen.code`error: ${error}`)
  }

  const endpoint = options.length === 0
    ? Codegen.code`${HttpApiEndpoint}.${operation.method}(${JSON.stringify(endpointName)}, ${
      JSON.stringify(toHttpApiPath(operation.path))
    })`
    : Codegen.code`${HttpApiEndpoint}.${operation.method}(${JSON.stringify(endpointName)}, ${
      JSON.stringify(toHttpApiPath(operation.path))
    }, { ${Codegen.join(options, ", ")} })`

  const annotations: Array<Codegen.Fragment> = []
  if (operation.operationId !== undefined) {
    annotations.push(Codegen.code`annotate(${OpenApi}.Identifier, ${JSON.stringify(operation.operationId)})`)
  }
  if (operation.metadata.summary !== undefined) {
    annotations.push(Codegen.code`annotate(${OpenApi}.Summary, ${JSON.stringify(operation.metadata.summary)})`)
  }
  if (operation.metadata.description !== undefined) {
    annotations.push(Codegen.code`annotate(${OpenApi}.Description, ${JSON.stringify(operation.metadata.description)})`)
  }
  if (operation.metadata.deprecated) {
    annotations.push(Codegen.code`annotate(${OpenApi}.Deprecated, true)`)
  }
  if (operation.metadata.externalDocs !== undefined) {
    annotations.push(
      Codegen.code`annotate(${OpenApi}.ExternalDocs, ${JSON.stringify(operation.metadata.externalDocs)})`
    )
  }

  if (annotations.length === 0 && endpointMiddlewares.length === 0) {
    return endpoint
  }

  let out = endpoint
  for (const middleware of endpointMiddlewares) {
    out = Codegen.code`${out}\n      .middleware(${middleware})`
  }
  for (const annotation of annotations) {
    out = Codegen.code`${out}\n      .${annotation}`
  }
  return out
}

const renderPayload = (operation: ParsedOperation): Codegen.Fragment | undefined => {
  if (!methodSupportsBody(operation.method)) {
    return
  }
  const payloads = operation.requestBodyRepresentable.map((schema) => renderMediaSchema(schema))
  if (payloads.length === 0) {
    return
  }

  if (operation.requestBody?.required === false) {
    payloads.unshift(Codegen.code`${HttpApiSchema}.NoContent`)
  }

  return joinSchemas(payloads)
}

const renderResponseSet = (
  responses: ReadonlyArray<ParsedOperationResponse>,
  target: "success" | "error"
): Codegen.Fragment | undefined => {
  const rendered: Array<Codegen.Fragment> = []

  for (const response of responses) {
    const status = toStatus(response.status)
    if (status === undefined) {
      continue
    }

    const isSuccess = status < 400
    if ((target === "success") !== isSuccess) {
      continue
    }

    if (response.isEmpty) {
      rendered.push(Codegen.code`${HttpApiSchema}.Empty(${status})`)
      continue
    }

    for (const media of response.representable) {
      rendered.push(applyStatus(renderMediaSchema(media), status, target))
    }
  }

  if (rendered.length === 0) {
    return
  }

  return joinSchemas(rendered)
}

const joinSchemas = (schemas: ReadonlyArray<Codegen.Fragment>): Codegen.Fragment =>
  schemas.length === 1 ? schemas[0] : Codegen.code`[${Codegen.join(schemas, ", ")}]`

const renderMediaSchema = (media: ParsedOperationMediaTypeSchema): Codegen.Fragment => {
  if (media.effectStream === "sse") {
    const options = media.contentType === "text/event-stream"
      ? Codegen.code`{ events: ${media.schema}, error: ${media.errorSchema} }`
      : Codegen.code`{ contentType: ${
        JSON.stringify(media.contentType)
      }, events: ${media.schema}, error: ${media.errorSchema} }`
    return Codegen.code`${HttpApiSchema}.StreamSse(${options})`
  }

  if (media.effectStream === "uint8array") {
    if (media.contentType === "application/octet-stream") {
      return Codegen.code`${HttpApiSchema}.StreamUint8Array()`
    }
    return Codegen.code`${HttpApiSchema}.StreamUint8Array({ contentType: ${JSON.stringify(media.contentType)} })`
  }

  if (media.effectStream === "ndjson") {
    if (media.contentType === "application/x-ndjson") {
      return Codegen.code`${HttpApiSchema}.StreamNdjson({ schema: ${media.schema} })`
    }
    return Codegen.code`${HttpApiSchema}.StreamNdjson({ schema: ${media.schema}, contentType: ${
      JSON.stringify(media.contentType)
    } })`
  }

  switch (media.encoding) {
    case "json": {
      if (media.contentType === "application/json") {
        return media.schema
      }
      return Codegen.code`${media.schema}.pipe(${HttpApiSchema}.asJson({ contentType: ${
        JSON.stringify(media.contentType)
      } }))`
    }
    case "multipart": {
      return Codegen.code`${media.schema}.pipe(${HttpApiSchema}.asMultipart())`
    }
    case "form-url-encoded": {
      if (media.contentType === "application/x-www-form-urlencoded") {
        return Codegen.code`${media.schema}.pipe(${HttpApiSchema}.asFormUrlEncoded())`
      }
      return Codegen.code`${media.schema}.pipe(${HttpApiSchema}.asFormUrlEncoded({ contentType: ${
        JSON.stringify(media.contentType)
      } }))`
    }
    case "text": {
      if (media.contentType === "text/plain") {
        return Codegen.code`${media.schema}.pipe(${HttpApiSchema}.asText())`
      }
      return Codegen.code`${media.schema}.pipe(${HttpApiSchema}.asText({ contentType: ${
        JSON.stringify(media.contentType)
      } }))`
    }
    case "binary": {
      if (media.contentType === "application/octet-stream") {
        return Codegen.code`${media.schema}.pipe(${HttpApiSchema}.asUint8Array())`
      }
      return Codegen.code`${media.schema}.pipe(${HttpApiSchema}.asUint8Array({ contentType: ${
        JSON.stringify(media.contentType)
      } }))`
    }
  }
}

const renderApiAnnotations = (parsed: ParsedOpenApi): ReadonlyArray<Codegen.Fragment> => {
  const annotations: Array<Codegen.Fragment> = [
    Codegen.code`annotate(${OpenApi}.Title, ${JSON.stringify(parsed.metadata.title)})`,
    Codegen.code`annotate(${OpenApi}.Version, ${JSON.stringify(parsed.metadata.version)})`
  ]

  if (parsed.metadata.summary !== undefined) {
    annotations.push(Codegen.code`annotate(${OpenApi}.Summary, ${JSON.stringify(parsed.metadata.summary)})`)
  }
  if (parsed.metadata.description !== undefined) {
    annotations.push(Codegen.code`annotate(${OpenApi}.Description, ${JSON.stringify(parsed.metadata.description)})`)
  }
  if (parsed.metadata.license !== undefined) {
    annotations.push(Codegen.code`annotate(${OpenApi}.License, ${JSON.stringify(parsed.metadata.license)})`)
  }
  if (parsed.metadata.servers !== undefined) {
    annotations.push(Codegen.code`annotate(${OpenApi}.Servers, ${JSON.stringify(parsed.metadata.servers)})`)
  }

  return annotations
}

const buildSecurityRenderModel = (
  parsed: ParsedOpenApi,
  allocateName: (name: string) => string
): SecurityRenderModel => {
  const securityDeclarations: Array<Codegen.Fragment> = []
  const middlewareDeclarations: Array<Codegen.Fragment> = []
  const endpointMiddlewares = new Map<string, ReadonlyArray<string>>()
  const schemeDeclarations = new Map<string, string>()
  const middlewareNames = new Map<string, string>()

  for (const securityScheme of parsed.securitySchemes) {
    const baseName = ensureIdentifier(securityScheme.name, "Security")
    const declarationName = allocateName(`${baseName}Security`)
    schemeDeclarations.set(securityScheme.name, declarationName)
    securityDeclarations.push(Codegen.code`export const ${declarationName} = ${renderSecurityScheme(securityScheme)}`)
  }

  for (const operation of parsed.operations) {
    if (operation.effectiveSecurity.length === 0) {
      continue
    }
    if (operation.effectiveSecurity.some((requirement) => Object.keys(requirement).length === 0)) {
      continue
    }

    const operationMiddlewareNames: Array<string> = []
    const seenOrSchemes = new Set<string>()
    const andRequirements: Array<ReadonlyArray<string>> = []

    for (const requirement of operation.effectiveSecurity) {
      const schemes = Object.keys(requirement)
      if (schemes.length === 1) {
        const schemeName = schemes[0]
        if (schemeDeclarations.has(schemeName) && !seenOrSchemes.has(schemeName)) {
          seenOrSchemes.add(schemeName)
        }
      } else if (schemes.length > 1) {
        andRequirements.push([...schemes].sort())
      }
    }

    const orSchemeNames = Array.from(seenOrSchemes).sort()
    if (orSchemeNames.length > 0) {
      const className = getOrSecurityMiddlewareName(orSchemeNames)
      operationMiddlewareNames.push(className)
    }

    const seenAndRequirements = new Set<string>()
    for (const requirement of andRequirements) {
      const key = requirement.join("\u0000")
      if (seenAndRequirements.has(key)) {
        continue
      }
      seenAndRequirements.add(key)
      const className = getAndSecurityMiddlewareName(requirement)
      operationMiddlewareNames.push(className)
    }

    if (operationMiddlewareNames.length > 0) {
      endpointMiddlewares.set(toOperationKey(operation), operationMiddlewareNames)
    }
  }

  return {
    securityDeclarations,
    middlewareDeclarations,
    endpointMiddlewares
  }

  function getOrSecurityMiddlewareName(schemes: ReadonlyArray<string>): string {
    const key = `or:${schemes.join("\u0000")}`
    const existing = middlewareNames.get(key)
    if (existing !== undefined) {
      return existing
    }

    const className = allocateName(`${getSecurityMiddlewareBaseName(schemes, "Or")}SecurityMiddleware`)
    const securityEntries = schemes.map((name) => `${JSON.stringify(name)}: ${schemeDeclarations.get(name)!}`).join(
      ", "
    )
    middlewareDeclarations.push(
      Codegen.code`export class ${className} extends ${HttpApiMiddleware}.Service<${className}>()(${
        JSON.stringify(`${schemes.join(" | ")} security`)
      }, { security: { ${securityEntries} } }) {}`
    )
    middlewareNames.set(key, className)
    return className
  }

  function getAndSecurityMiddlewareName(schemes: ReadonlyArray<string>): string {
    const key = `and:${schemes.join("\u0000")}`
    const existing = middlewareNames.get(key)
    if (existing !== undefined) {
      return existing
    }

    const className = allocateName(`${getSecurityMiddlewareBaseName(schemes, "And")}SecurityMiddleware`)
    middlewareDeclarations.push(
      Codegen.code`class ${className} extends ${HttpApiMiddleware}.Service<${className}>()(${
        JSON.stringify(`${schemes.join(" & ")} security`)
      }) {}`
    )
    middlewareNames.set(key, className)
    return className
  }
}

const getSecurityMiddlewareBaseName = (
  schemes: ReadonlyArray<string>,
  joiner: "And" | "Or"
): string => {
  const [head, ...tail] = schemes.map((scheme) => ensureIdentifier(scheme, "Security"))
  return tail.length === 0 ? head : [head, ...tail.map((scheme) => `${joiner}${scheme}`)].join("")
}

const renderSecurityScheme = (securityScheme: ParsedOpenApiSecurityScheme): Codegen.Fragment => {
  let source: Codegen.Fragment
  switch (securityScheme.type) {
    case "basic": {
      source = Codegen.code`${HttpApiSecurity}.basic`
      break
    }
    case "bearer": {
      source = Codegen.code`${HttpApiSecurity}.bearer`
      break
    }
    case "http": {
      source = Codegen.code`${HttpApiSecurity}.http({ scheme: ${JSON.stringify(securityScheme.scheme!)} })`
      break
    }
    case "apiKey": {
      source = Codegen.code`${HttpApiSecurity}.apiKey({ key: ${JSON.stringify(securityScheme.key!)}, in: ${
        JSON.stringify(securityScheme.in!)
      } })`
      break
    }
  }

  if (securityScheme.description !== undefined) {
    source = Codegen.code`${source}.pipe(${HttpApiSecurity}.annotate(${OpenApi}.Description, ${
      JSON.stringify(securityScheme.description)
    }))`
  }
  if (
    (securityScheme.type === "bearer" || securityScheme.type === "http") && securityScheme.bearerFormat !== undefined
  ) {
    source = Codegen.code`${source}.pipe(${HttpApiSecurity}.annotate(${OpenApi}.Format, ${
      JSON.stringify(securityScheme.bearerFormat)
    }))`
  }

  return source
}

const toOperationKey = (operation: ParsedOperation): string => `${operation.method}:${operation.path}`

const toHttpApiPath = (path: string): string => path.replace(/{([^}]+)}/g, ":$1")

const toStatus = (status: string): number | undefined => {
  if (!/^\d{3}$/.test(status)) {
    return
  }
  return Number(status)
}

const applyStatus = (schema: Codegen.Fragment, status: number, target: "success" | "error"): Codegen.Fragment => {
  if ((target === "success" && status === 200) || (target === "error" && status === 500)) {
    return schema
  }
  return Codegen.code`${schema}.pipe(${HttpApiSchema}.status(${status}))`
}

const methodSupportsBody = (method: ParsedOperation["method"]): boolean =>
  method !== "get" && method !== "head" && method !== "options" && method !== "trace"

const ensureIdentifier = (value: string, fallback: string): string => {
  const sanitized = Utils.identifier(value)
  return sanitized.length > 0 ? sanitized : fallback
}

const makeNameAllocator = () => {
  const used = new Set<string>()
  return (base: string) => {
    let candidate = base
    let index = 2
    while (used.has(candidate)) {
      candidate = `${base}${index}`
      index += 1
    }
    used.add(candidate)
    return candidate
  }
}
