/**
 * OpenAPI-to-HttpClient code generation for the OpenAPI generator.
 *
 * This module defines the `OpenApiTransformer` service used to render parsed
 * OpenAPI operations into Effect `HttpClient` modules. It provides both
 * schema-backed and type-only transformer implementations, including generated
 * imports, public client interfaces, operation implementations, typed API
 * errors, optional response handling, and helpers for server-sent events and
 * binary response streams.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import type { ParsedOpenApi, ParsedOperation } from "./ParsedOperation.ts"
import * as Utils from "./Utils.ts"

/**
 * Service used by the OpenAPI generator to render parsed operations as an
 * Effect HttpClient module.
 *
 * **Details**
 *
 * A transformer owns the code-generation dialect for imports, public client
 * types, and the implementation body. The generator swaps implementations to
 * choose between schema-backed clients and type-only clients.
 *
 * @category code generation
 * @since 4.0.0
 */
export class OpenApiTransformer extends Context.Service<
  OpenApiTransformer,
  {
    readonly imports: (importName: string, parsed: ParsedOpenApi) => string
    readonly toTypes: (importName: string, name: string, parsed: ParsedOpenApi) => string
    readonly toImplementation: (importName: string, name: string, parsed: ParsedOpenApi) => string
  }
>()("OpenApiTransformer") {}

interface ImportRequirements {
  readonly eventStream: boolean
  readonly octetStream: boolean
}

const computeImportRequirements = (operations: ReadonlyArray<ParsedOperation>): ImportRequirements => {
  let eventStream = false
  let octetStream = false
  for (const op of operations) {
    if (op.sseSchema) {
      eventStream = true
    }
    if (op.binaryResponse) {
      octetStream = true
    }
  }
  return { eventStream, octetStream }
}

const requiresStreaming = (requirements: ImportRequirements): boolean =>
  requirements.eventStream || requirements.octetStream

/**
 * Create the transformer used for schema-backed HttpClient output.
 *
 * **Details**
 *
 * Generated clients import Effect Schema values and use them at runtime to
 * decode successful responses and typed API errors. Request parameters and
 * payloads are typed against each schema's encoded representation.
 *
 * @category code generation
 * @since 4.0.0
 */
export const makeTransformerSchema = () => {
  const operationsToInterface = (
    _importName: string,
    name: string,
    operations: ReadonlyArray<ParsedOperation>
  ) => {
    const methods: Array<string> = []
    for (const op of operations) {
      methods.push(operationToMethod(name, op))
      if (op.sseSchema) {
        methods.push(operationToSseMethod(name, op))
      }
      if (op.binaryResponse) {
        methods.push(operationToBinaryMethod(name, op))
      }
    }
    return `export interface ${name} {
  readonly httpClient: HttpClient.HttpClient
  ${methods.join("\n  ")}
}

${clientErrorSource(name)}`
  }

  const operationToMethod = (name: string, operation: ParsedOperation) => {
    const args: Array<string> = []
    if (operation.pathIds.length > 0) {
      Utils.spreadElementsInto(operation.pathIds.map((id) => `${id}: string`), args)
    }

    const options: Array<string> = []
    if (operation.params) {
      const key = `readonly params${operation.paramsOptional ? "?" : ""}`
      const type = `typeof ${operation.params}.Encoded${operation.paramsOptional ? " | undefined" : ""}`
      options.push(`${key}: ${type}`)
    }
    if (operation.payload) {
      const key = `readonly payload`
      const type = `typeof ${operation.payload}.Encoded`
      options.push(`${key}: ${type}`)
    }
    options.push("readonly config?: Config | undefined")

    // If all options are optional, the argument itself should be optional
    const hasOptions = (operation.params && !operation.paramsOptional) || operation.payload
    if (hasOptions) {
      args.push(`options: { ${options.join("; ")} }`)
    } else {
      args.push(`options: { ${options.join("; ")} } | undefined`)
    }

    let success = "void"
    if (operation.successSchemas.size > 0) {
      success = Array.from(operation.successSchemas.values())
        .map((schema) => `typeof ${schema}.Type`)
        .join(" | ")
    }
    const errors = ["HttpClientError.HttpClientError", "SchemaError"]
    if (operation.errorSchemas.size > 0) {
      Utils.spreadElementsInto(
        Array.from(operation.errorSchemas.values()).map(
          (schema) => `${name}Error<"${schema}", typeof ${schema}.Type>`
        ),
        errors
      )
    }

    const jsdoc = Utils.toComment(operation.description)
    const methodKey = `readonly "${operation.id}"`
    const generic = `<Config extends OperationConfig>`
    const parameters = args.join(", ")
    const returnType = `Effect.Effect<WithOptionalResponse<${success}, Config>, ${errors.join(" | ")}>`
    return `${jsdoc}${methodKey}: ${generic}(${parameters}) => ${returnType}`
  }

  const operationToSseMethod = (_name: string, operation: ParsedOperation) => {
    const args: Array<string> = []
    if (operation.pathIds.length > 0) {
      Utils.spreadElementsInto(operation.pathIds.map((id) => `${id}: string`), args)
    }

    const options: Array<string> = []
    if (operation.params) {
      const key = `readonly params${operation.paramsOptional ? "?" : ""}`
      const type = `typeof ${operation.params}.Encoded${operation.paramsOptional ? " | undefined" : ""}`
      options.push(`${key}: ${type}`)
    }
    if (operation.payload) {
      options.push(`readonly payload: typeof ${operation.payload}.Encoded`)
    }

    const hasOptions = (operation.params && !operation.paramsOptional) || operation.payload
    if (hasOptions) {
      args.push(`options: { ${options.join("; ")} }`)
    } else if (options.length > 0) {
      args.push(`options: { ${options.join("; ")} } | undefined`)
    }

    const jsdoc = Utils.toComment(operation.description)
    const methodKey = `readonly "${operation.id}Sse"`
    const parameters = args.join(", ")
    const returnType =
      `Stream.Stream<{ readonly event: string; readonly id: string | undefined; readonly data: typeof ${operation.sseSchema}.Type }, HttpClientError.HttpClientError | SchemaError | Sse.Retry, typeof ${operation.sseSchema}.DecodingServices>`
    return `${jsdoc}${methodKey}: (${parameters}) => ${returnType}`
  }

  const operationToBinaryMethod = (_name: string, operation: ParsedOperation) => {
    const args: Array<string> = []
    if (operation.pathIds.length > 0) {
      Utils.spreadElementsInto(operation.pathIds.map((id) => `${id}: string`), args)
    }

    const options: Array<string> = []
    if (operation.params) {
      const key = `readonly params${operation.paramsOptional ? "?" : ""}`
      const type = `typeof ${operation.params}.Encoded${operation.paramsOptional ? " | undefined" : ""}`
      options.push(`${key}: ${type}`)
    }
    if (operation.payload) {
      options.push(`readonly payload: typeof ${operation.payload}.Encoded`)
    }

    const hasOptions = (operation.params && !operation.paramsOptional) || operation.payload
    if (hasOptions) {
      args.push(`options: { ${options.join("; ")} }`)
    } else if (options.length > 0) {
      args.push(`options: { ${options.join("; ")} } | undefined`)
    }

    const jsdoc = Utils.toComment(operation.description)
    const methodKey = `readonly "${operation.id}Stream"`
    const parameters = args.join(", ")
    const returnType = `Stream.Stream<Uint8Array, HttpClientError.HttpClientError>`
    return `${jsdoc}${methodKey}: (${parameters}) => ${returnType}`
  }

  const operationsToImpl = (
    importName: string,
    name: string,
    operations: ReadonlyArray<ParsedOperation>
  ) => {
    const requirements = computeImportRequirements(operations)
    const implMethods: Array<string> = []
    for (const op of operations) {
      implMethods.push(operationToImpl(op))
      if (op.sseSchema) {
        implMethods.push(operationToSseImpl(importName, op))
      }
      if (op.binaryResponse) {
        implMethods.push(operationToBinaryImpl(op))
      }
    }

    const helpers: Array<string> = [commonSource]
    if (requirements.eventStream) {
      helpers.push(sseRequestSource(importName))
    }
    if (requirements.octetStream) {
      helpers.push(binaryRequestSource)
    }

    return `export interface OperationConfig {
  /**
   * Whether or not the response should be included in the value returned from
   * an operation.
   *
   * If set to \`true\`, a tuple of \`[A, HttpClientResponse]\` will be returned,
   * where \`A\` is the success type of the operation.
   *
   * If set to \`false\`, only the success type of the operation will be returned.
   */
  readonly includeResponse?: boolean | undefined
}

/**
 * A utility type which optionally includes the response in the return result
 * of an operation based upon the value of the \`includeResponse\` configuration
 * option.
 */
export type WithOptionalResponse<A, Config extends OperationConfig> = Config extends {
  readonly includeResponse: true
} ? [A, HttpClientResponse.HttpClientResponse] : A

export const make = (
  httpClient: HttpClient.HttpClient,
  options: {
    readonly transformClient?: ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>) | undefined
  } = {}
): ${name} => {
  ${helpers.join("\n  ")}
  const decodeSuccess =
    <Schema extends ${importName}.Top>(schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response)
  const decodeError =
    <const Tag extends string, Schema extends ${importName}.Top>(tag: Tag, schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(schema)(response),
        (cause) => Effect.fail(${name}Error(tag, cause, response)),
      )
  return {
    httpClient,
    ${implMethods.join(",\n    ")}
  }
}`
  }

  const operationToImpl = (operation: ParsedOperation) => {
    const args: Array<string> = [...operation.pathIds, "options"]
    const params = `${args.join(", ")}`

    const pipeline: Array<string> = []

    if (operation.params) {
      const paramsAccessor = resolveParamsAccessor(operation, "options", "params")

      if (operation.urlParams.length > 0) {
        const props = operation.urlParams.map(
          (param) => `"${param}": ${paramsAccessor}["${param}"] as any`
        )
        pipeline.push(`HttpClientRequest.setUrlParams({ ${props.join(", ")} })`)
      }
      if (operation.headers.length > 0) {
        const props = operation.headers.map(
          (param) => `"${param}": ${paramsAccessor}["${param}"] ?? undefined`
        )
        pipeline.push(`HttpClientRequest.setHeaders({ ${props.join(", ")} })`)
      }
    }

    const payloadVarName = "options.payload"
    if (operation.payloadFormData) {
      pipeline.push(`HttpClientRequest.bodyFormData(${payloadVarName} as any)`)
    } else if (operation.payloadFormUrlEncoded) {
      pipeline.push(`HttpClientRequest.bodyUrlParams(${payloadVarName} as any)`)
    } else if (operation.payload) {
      pipeline.push(`HttpClientRequest.bodyJsonUnsafe(${payloadVarName})`)
    }

    const decodes: Array<string> = []
    const singleSuccessCode = operation.successSchemas.size === 1
    operation.successSchemas.forEach((schema, status) => {
      const statusCode = singleSuccessCode && status.startsWith("2") ? "2xx" : status
      decodes.push(`"${statusCode}": decodeSuccess(${schema})`)
    })
    operation.errorSchemas.forEach((schema, status) => {
      decodes.push(`"${status}": decodeError("${schema}", ${schema})`)
    })
    operation.voidSchemas.forEach((status) => {
      decodes.push(`"${status}": () => Effect.void`)
    })
    decodes.push(`orElse: unexpectedStatus`)

    const configAccessor = resolveConfigAccessor(operation, "options", "config")
    pipeline.push(`withResponse(${configAccessor})(HttpClientResponse.matchStatus({
      ${decodes.join(",\n      ")}
    }))`)

    return (
      `"${operation.id}": (${params}) => ` +
      `HttpClientRequest.${operation.method}(${operation.pathTemplate})` +
      `.pipe(\n    ${pipeline.join(",\n    ")}\n  )`
    )
  }

  const operationToSseImpl = (_importName: string, operation: ParsedOperation) => {
    const args: Array<string> = [...operation.pathIds]
    const hasOptions = (operation.params && !operation.paramsOptional) || operation.payload
    if (hasOptions || operation.params || operation.payload) {
      args.push("options")
    }
    const params = args.join(", ")

    const pipeline: Array<string> = []

    if (operation.params) {
      const paramsAccessor = resolveParamsAccessor(operation, "options", "params")
      if (operation.urlParams.length > 0) {
        const props = operation.urlParams.map(
          (param) => `"${param}": ${paramsAccessor}["${param}"] as any`
        )
        pipeline.push(`HttpClientRequest.setUrlParams({ ${props.join(", ")} })`)
      }
      if (operation.headers.length > 0) {
        const props = operation.headers.map(
          (param) => `"${param}": ${paramsAccessor}["${param}"] ?? undefined`
        )
        pipeline.push(`HttpClientRequest.setHeaders({ ${props.join(", ")} })`)
      }
    }

    if (operation.payloadFormData) {
      pipeline.push(`HttpClientRequest.bodyFormData(options.payload as any)`)
    } else if (operation.payload) {
      pipeline.push(`HttpClientRequest.bodyJsonUnsafe(options.payload)`)
    }

    pipeline.push(`sseRequest(${operation.sseSchema})`)

    return (
      `"${operation.id}Sse": (${params}) => ` +
      `HttpClientRequest.${operation.method}(${operation.pathTemplate})` +
      `.pipe(\n      ${pipeline.join(",\n      ")}\n    )`
    )
  }

  const operationToBinaryImpl = (operation: ParsedOperation) => {
    const args: Array<string> = [...operation.pathIds]
    const hasOptions = (operation.params && !operation.paramsOptional) || operation.payload
    if (hasOptions || operation.params || operation.payload) {
      args.push("options")
    }
    const params = args.join(", ")

    const pipeline: Array<string> = []

    if (operation.params) {
      const paramsAccessor = resolveParamsAccessor(operation, "options", "params")
      if (operation.urlParams.length > 0) {
        const props = operation.urlParams.map(
          (param) => `"${param}": ${paramsAccessor}["${param}"] as any`
        )
        pipeline.push(`HttpClientRequest.setUrlParams({ ${props.join(", ")} })`)
      }
      if (operation.headers.length > 0) {
        const props = operation.headers.map(
          (param) => `"${param}": ${paramsAccessor}["${param}"] ?? undefined`
        )
        pipeline.push(`HttpClientRequest.setHeaders({ ${props.join(", ")} })`)
      }
    }

    if (operation.payloadFormData) {
      pipeline.push(`HttpClientRequest.bodyFormData(options.payload as any)`)
    } else if (operation.payload) {
      pipeline.push(`HttpClientRequest.bodyJsonUnsafe(options.payload)`)
    }

    pipeline.push(`binaryRequest`)

    return (
      `"${operation.id}Stream": (${params}) => ` +
      `HttpClientRequest.${operation.method}(${operation.pathTemplate})` +
      `.pipe(\n      ${pipeline.join(",\n      ")}\n    )`
    )
  }

  return OpenApiTransformer.of({
    imports: (importName, parsed) => {
      const operations = parsed.operations
      const requirements = computeImportRequirements(operations)
      const imports = [
        `import * as Data from "effect/Data"`,
        `import * as Effect from "effect/Effect"`,
        `import type { SchemaError } from "effect/Schema"`,
        `import * as ${importName} from "effect/Schema"`
      ]
      if (requiresStreaming(requirements)) {
        imports.push(`import * as Stream from "effect/Stream"`)
      }
      if (requirements.eventStream) {
        imports.push(`import * as Sse from "effect/unstable/encoding/Sse"`)
      }
      // HttpClient needs to be a value import when streaming is used (for filterStatusOk)
      if (requiresStreaming(requirements)) {
        imports.push(`import * as HttpClient from "effect/unstable/http/HttpClient"`)
      } else {
        imports.push(`import type * as HttpClient from "effect/unstable/http/HttpClient"`)
      }
      imports.push(
        `import * as HttpClientError from "effect/unstable/http/HttpClientError"`,
        `import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"`,
        `import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"`
      )
      return imports.join("\n")
    },
    toTypes: (importName, name, parsed) => operationsToInterface(importName, name, parsed.operations),
    toImplementation: (importName, name, parsed) => operationsToImpl(importName, name, parsed.operations)
  })
}

/**
 * Layer that provides the schema-backed OpenApiTransformer service.
 *
 * **When to use**
 *
 * Use when you use this layer when generated HttpClient code should perform runtime response
 * decoding with generated Effect Schema values.
 *
 * @category code generation
 * @since 4.0.0
 */
export const layerTransformerSchema = Layer.sync(
  OpenApiTransformer,
  makeTransformerSchema
)

/**
 * Create the transformer used for type-only HttpClient output.
 *
 * **Details**
 *
 * Generated clients reference emitted TypeScript types directly and do not
 * import schema decoders for JSON response bodies. Responses are typed as the
 * declared operation result while preserving generated error and stream method
 * shapes.
 *
 * @category code generation
 * @since 4.0.0
 */
export const makeTransformerTs = () => {
  const operationsToInterface = (
    _importName: string,
    name: string,
    operations: ReadonlyArray<ParsedOperation>
  ) => {
    const methods: Array<string> = []
    for (const op of operations) {
      methods.push(operationToMethod(name, op))
      if (op.sseSchema) {
        methods.push(operationToSseMethod(op))
      }
      if (op.binaryResponse) {
        methods.push(operationToBinaryMethod(op))
      }
    }
    return `export interface ${name} {
  readonly httpClient: HttpClient.HttpClient
  ${methods.join("\n  ")}
}

${clientErrorSource(name)}`
  }

  const operationToMethod = (name: string, operation: ParsedOperation) => {
    const args: Array<string> = []
    if (operation.pathIds.length > 0) {
      Utils.spreadElementsInto(operation.pathIds.map((id) => `${id}: string`), args)
    }

    const options: Array<string> = []
    if (operation.params) {
      const key = `readonly params${operation.paramsOptional ? "?" : ""}`
      const type = `${operation.params}${operation.paramsOptional ? " | undefined" : ""}`
      options.push(`${key}: ${type}`)
    }
    if (operation.payload) {
      options.push(`readonly payload: ${operation.payload}`)
    }
    options.push("readonly config?: Config | undefined")

    // If all options are optional, the argument itself should be optional
    const hasOptions = (operation.params && !operation.paramsOptional) || operation.payload
    if (hasOptions) {
      args.push(`options: { ${options.join("; ")} }`)
    } else {
      args.push(`options: { ${options.join("; ")} } | undefined`)
    }

    let success = "void"
    if (operation.successSchemas.size > 0) {
      success = Array.from(operation.successSchemas.values()).join(" | ")
    }

    const errors = ["HttpClientError.HttpClientError"]
    if (operation.errorSchemas.size > 0) {
      for (const schema of operation.errorSchemas.values()) {
        errors.push(`${name}Error<"${schema}", ${schema}>`)
      }
    }

    const jsdoc = Utils.toComment(operation.description)
    const methodKey = `readonly "${operation.id}"`
    const generic = `<Config extends OperationConfig>`
    const parameters = args.join(", ")
    const returnType = `Effect.Effect<WithOptionalResponse<${success}, Config>, ${errors.join(" | ")}>`
    return `${jsdoc}${methodKey}: ${generic}(${parameters}) => ${returnType}`
  }

  const operationToSseMethod = (operation: ParsedOperation) => {
    const args: Array<string> = []
    if (operation.pathIds.length > 0) {
      Utils.spreadElementsInto(operation.pathIds.map((id) => `${id}: string`), args)
    }

    const options: Array<string> = []
    if (operation.params) {
      const key = `readonly params${operation.paramsOptional ? "?" : ""}`
      const type = `${operation.params}${operation.paramsOptional ? " | undefined" : ""}`
      options.push(`${key}: ${type}`)
    }
    if (operation.payload) {
      options.push(`readonly payload: ${operation.payload}`)
    }

    const hasOptions = (operation.params && !operation.paramsOptional) || operation.payload
    if (hasOptions) {
      args.push(`options: { ${options.join("; ")} }`)
    } else if (options.length > 0) {
      args.push(`options: { ${options.join("; ")} } | undefined`)
    }

    const jsdoc = Utils.toComment(operation.description)
    const methodKey = `readonly "${operation.id}Sse"`
    const parameters = args.join(", ")
    const returnType = `Stream.Stream<${operation.sseSchema}, HttpClientError.HttpClientError>`
    return `${jsdoc}${methodKey}: (${parameters}) => ${returnType}`
  }

  const operationToBinaryMethod = (operation: ParsedOperation) => {
    const args: Array<string> = []
    if (operation.pathIds.length > 0) {
      Utils.spreadElementsInto(operation.pathIds.map((id) => `${id}: string`), args)
    }

    const options: Array<string> = []
    if (operation.params) {
      const key = `readonly params${operation.paramsOptional ? "?" : ""}`
      const type = `${operation.params}${operation.paramsOptional ? " | undefined" : ""}`
      options.push(`${key}: ${type}`)
    }
    if (operation.payload) {
      options.push(`readonly payload: ${operation.payload}`)
    }

    const hasOptions = (operation.params && !operation.paramsOptional) || operation.payload
    if (hasOptions) {
      args.push(`options: { ${options.join("; ")} }`)
    } else if (options.length > 0) {
      args.push(`options: { ${options.join("; ")} } | undefined`)
    }

    const jsdoc = Utils.toComment(operation.description)
    const methodKey = `readonly "${operation.id}Stream"`
    const parameters = args.join(", ")
    const returnType = `Stream.Stream<Uint8Array, HttpClientError.HttpClientError>`
    return `${jsdoc}${methodKey}: (${parameters}) => ${returnType}`
  }

  const operationsToImpl = (
    _importName: string,
    name: string,
    operations: ReadonlyArray<ParsedOperation>
  ) => {
    const requirements = computeImportRequirements(operations)
    const implMethods: Array<string> = []
    for (const op of operations) {
      implMethods.push(operationToImpl(op))
      if (op.sseSchema) {
        implMethods.push(operationToSseImpl(op))
      }
      if (op.binaryResponse) {
        implMethods.push(operationToBinaryImpl(op))
      }
    }

    const helpers: Array<string> = [commonSource]
    if (requirements.eventStream) {
      helpers.push(sseRequestSourceTs)
    }
    if (requirements.octetStream) {
      helpers.push(binaryRequestSourceTs)
    }

    return `export interface OperationConfig {
  /**
   * Whether or not the response should be included in the value returned from
   * an operation.
   *
   * If set to \`true\`, a tuple of \`[A, HttpClientResponse]\` will be returned,
   * where \`A\` is the success type of the operation.
   *
   * If set to \`false\`, only the success type of the operation will be returned.
   */
  readonly includeResponse?: boolean | undefined
}

/**
 * A utility type which optionally includes the response in the return result
 * of an operation based upon the value of the \`includeResponse\` configuration
 * option.
 */
export type WithOptionalResponse<A, Config extends OperationConfig> = Config extends {
  readonly includeResponse: true
} ? [A, HttpClientResponse.HttpClientResponse] : A

export const make = (
  httpClient: HttpClient.HttpClient,
  options: {
    readonly transformClient?: ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>) | undefined
  } = {}
): ${name} => {
  ${helpers.join("\n  ")}
  const decodeSuccess = <A>(response: HttpClientResponse.HttpClientResponse) =>
    response.json as Effect.Effect<A, HttpClientError.HttpClientError>
  const decodeVoid = (_response: HttpClientResponse.HttpClientResponse) =>
    Effect.void
  const decodeError =
    <Tag extends string, E>(tag: Tag) =>
    (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<
      never,
      ${name}Error<Tag, E> | HttpClientError.HttpClientError
    > =>
      Effect.flatMap(
        response.json as Effect.Effect<E, HttpClientError.HttpClientError>,
        (cause) => Effect.fail(${name}Error(tag, cause, response)),
      )
  const onRequest = <Config extends OperationConfig>(config: Config | undefined) => (
    successCodes: ReadonlyArray<string>,
    errorCodes?: Record<string, string>,
  ) => {
    const cases: any = { orElse: unexpectedStatus }
    for (const code of successCodes) {
      cases[code] = decodeSuccess
    }
    if (errorCodes) {
      for (const [code, tag] of Object.entries(errorCodes)) {
        cases[code] = decodeError(tag)
      }
    }
    if (successCodes.length === 0) {
      cases["2xx"] = decodeVoid
    }
    return withResponse(config)(HttpClientResponse.matchStatus(cases) as any)
  }
  return {
    httpClient,
    ${implMethods.join(",\n    ")}
  }
}`
  }

  const operationToImpl = (operation: ParsedOperation) => {
    const args: Array<string> = [...operation.pathIds, "options"]
    const params = `${args.join(", ")}`

    const pipeline: Array<string> = []

    if (operation.params) {
      const paramsAccessor = resolveParamsAccessor(operation, "options", "params")

      if (operation.urlParams.length > 0) {
        const props = operation.urlParams.map(
          (param) => `"${param}": ${paramsAccessor}["${param}"] as any`
        )
        pipeline.push(`HttpClientRequest.setUrlParams({ ${props.join(", ")} })`)
      }
      if (operation.headers.length > 0) {
        const props = operation.headers.map(
          (param) => `"${param}": ${paramsAccessor}["${param}"] ?? undefined`
        )
        pipeline.push(`HttpClientRequest.setHeaders({ ${props.join(", ")} })`)
      }
    }

    const payloadAccessor = "options.payload"
    if (operation.payloadFormData) {
      pipeline.push(`HttpClientRequest.bodyFormDataRecord(${payloadAccessor} as any)`)
    } else if (operation.payload) {
      pipeline.push(`HttpClientRequest.bodyJsonUnsafe(${payloadAccessor})`)
    }

    const successCodesRaw = Array.from(operation.successSchemas.keys())
    const successCodes = successCodesRaw
      .map((_) => JSON.stringify(_))
      .join(", ")
    const singleSuccessCode = successCodesRaw.length === 1 && successCodesRaw[0].startsWith("2")
    const errorCodes = operation.errorSchemas.size > 0 &&
      Object.fromEntries(operation.errorSchemas.entries())
    const configAccessor = resolveConfigAccessor(operation, "options", "config")
    pipeline.push(
      `onRequest(${configAccessor})([${singleSuccessCode ? `"2xx"` : successCodes}]${
        errorCodes ? `, ${JSON.stringify(errorCodes)}` : ""
      })`
    )

    return (
      `"${operation.id}": (${params}) => ` +
      `HttpClientRequest.${operation.method}(${operation.pathTemplate})` +
      `.pipe(\n    ${pipeline.join(",\n    ")}\n  )`
    )
  }

  const operationToSseImpl = (operation: ParsedOperation) => {
    const args: Array<string> = [...operation.pathIds]
    const hasOptions = (operation.params && !operation.paramsOptional) || operation.payload
    if (hasOptions || operation.params || operation.payload) {
      args.push("options")
    }
    const params = args.join(", ")

    const pipeline: Array<string> = []

    if (operation.params) {
      const paramsAccessor = resolveParamsAccessor(operation, "options", "params")
      if (operation.urlParams.length > 0) {
        const props = operation.urlParams.map(
          (param) => `"${param}": ${paramsAccessor}["${param}"] as any`
        )
        pipeline.push(`HttpClientRequest.setUrlParams({ ${props.join(", ")} })`)
      }
      if (operation.headers.length > 0) {
        const props = operation.headers.map(
          (param) => `"${param}": ${paramsAccessor}["${param}"] ?? undefined`
        )
        pipeline.push(`HttpClientRequest.setHeaders({ ${props.join(", ")} })`)
      }
    }

    if (operation.payloadFormData) {
      pipeline.push(`HttpClientRequest.bodyFormDataRecord(options.payload as any)`)
    } else if (operation.payload) {
      pipeline.push(`HttpClientRequest.bodyJsonUnsafe(options.payload)`)
    }

    pipeline.push(`sseRequest`)

    return (
      `"${operation.id}Sse": (${params}) => ` +
      `HttpClientRequest.${operation.method}(${operation.pathTemplate})` +
      `.pipe(\n      ${pipeline.join(",\n      ")}\n    )`
    )
  }

  const operationToBinaryImpl = (operation: ParsedOperation) => {
    const args: Array<string> = [...operation.pathIds]
    const hasOptions = (operation.params && !operation.paramsOptional) || operation.payload
    if (hasOptions || operation.params || operation.payload) {
      args.push("options")
    }
    const params = args.join(", ")

    const pipeline: Array<string> = []

    if (operation.params) {
      const paramsAccessor = resolveParamsAccessor(operation, "options", "params")
      if (operation.urlParams.length > 0) {
        const props = operation.urlParams.map(
          (param) => `"${param}": ${paramsAccessor}["${param}"] as any`
        )
        pipeline.push(`HttpClientRequest.setUrlParams({ ${props.join(", ")} })`)
      }
      if (operation.headers.length > 0) {
        const props = operation.headers.map(
          (param) => `"${param}": ${paramsAccessor}["${param}"] ?? undefined`
        )
        pipeline.push(`HttpClientRequest.setHeaders({ ${props.join(", ")} })`)
      }
    }

    if (operation.payloadFormData) {
      pipeline.push(`HttpClientRequest.bodyFormDataRecord(options.payload as any)`)
    } else if (operation.payload) {
      pipeline.push(`HttpClientRequest.bodyJsonUnsafe(options.payload)`)
    }

    pipeline.push(`binaryRequest`)

    return (
      `"${operation.id}Stream": (${params}) => ` +
      `HttpClientRequest.${operation.method}(${operation.pathTemplate})` +
      `.pipe(\n      ${pipeline.join(",\n      ")}\n    )`
    )
  }

  return OpenApiTransformer.of({
    imports: (_importName, parsed) => {
      const operations = parsed.operations
      const requirements = computeImportRequirements(operations)
      const imports = [
        `import * as Data from "effect/Data"`,
        `import * as Effect from "effect/Effect"`
      ]
      if (requiresStreaming(requirements)) {
        imports.push(`import * as Stream from "effect/Stream"`)
      }
      imports.push(
        `import type * as HttpClient from "effect/unstable/http/HttpClient"`,
        `import * as HttpClientError from "effect/unstable/http/HttpClientError"`,
        `import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"`,
        `import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"`
      )
      return imports.join("\n")
    },
    toTypes: (importName, name, parsed) => operationsToInterface(importName, name, parsed.operations),
    toImplementation: (importName, name, parsed) => operationsToImpl(importName, name, parsed.operations)
  })
}

/**
 * Layer that provides the type-only OpenApiTransformer service.
 *
 * **When to use**
 *
 * Use when you use this layer for the `httpclient-type-only` generator format, where the
 * generated client relies on TypeScript types instead of runtime Schema
 * decoding.
 *
 * @category code generation
 * @since 4.0.0
 */
export const layerTransformerTs = Layer.sync(
  OpenApiTransformer,
  makeTransformerTs
)

const commonSource = `const unexpectedStatus = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.flatMap(
      Effect.orElseSucceed(response.json, () => "Unexpected status code"),
      (description) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.StatusCodeError({
              request: response.request,
              response,
              description: typeof description === "string" ? description : JSON.stringify(description),
            }),
          }),
        ),
    )
  const withResponse = <Config extends OperationConfig>(config: Config | undefined) => (
    f: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<any, any>,
  ): (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<any, any> => {
    const withOptionalResponse = (
      config?.includeResponse
        ? (response: HttpClientResponse.HttpClientResponse) => Effect.map(f(response), (a) => [a, response])
        : (response: HttpClientResponse.HttpClientResponse) => f(response)
    ) as any
    return options?.transformClient
      ? (request) =>
          Effect.flatMap(
            Effect.flatMap(options.transformClient!(httpClient), (client) => client.execute(request)),
            withOptionalResponse
          )
      : (request) => Effect.flatMap(httpClient.execute(request), withOptionalResponse)
  }`

const sseRequestSource = (_importName: string) =>
  `const sseRequest = <
     Type,
     DecodingServices
    >(
      schema: Schema.Decoder<Type, DecodingServices>
    ) =>
    (
      request: HttpClientRequest.HttpClientRequest
    ): Stream.Stream<
      { readonly event: string; readonly id: string | undefined; readonly data: Type },
      HttpClientError.HttpClientError | SchemaError | Sse.Retry,
      DecodingServices
    > =>
      HttpClient.filterStatusOk(httpClient).execute(request).pipe(
        Effect.map((response) => response.stream),
        Stream.unwrap,
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.decodeDataSchema(schema))
      )`

const binaryRequestSource =
  `const binaryRequest = (request: HttpClientRequest.HttpClientRequest): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> =>
    HttpClient.filterStatusOk(httpClient).execute(request).pipe(
      Effect.map((response) => response.stream),
      Stream.unwrap
    )`

// Type-only mode helpers (no schema decoding)
const sseRequestSourceTs =
  `const sseRequest = (request: HttpClientRequest.HttpClientRequest): Stream.Stream<unknown, HttpClientError.HttpClientError> =>
    HttpClient.filterStatusOk(httpClient).execute(request).pipe(
      Effect.map((response) => response.stream),
      Stream.unwrap,
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.startsWith("data: ")),
      Stream.map((line) => JSON.parse(line.slice(6)))
    )`

const binaryRequestSourceTs =
  `const binaryRequest = (request: HttpClientRequest.HttpClientRequest): Stream.Stream<Uint8Array, HttpClientError.HttpClientError> =>
    HttpClient.filterStatusOk(httpClient).execute(request).pipe(
      Effect.map((response) => response.stream),
      Stream.unwrap
    )`

const clientErrorSource = (
  name: string
) =>
  `export interface ${name}Error<Tag extends string, E> {
  readonly _tag: Tag
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly cause: E
}

class ${name}ErrorImpl extends Data.Error<{
  _tag: string
  cause: any
  request: HttpClientRequest.HttpClientRequest
  response: HttpClientResponse.HttpClientResponse
}> {}

export const ${name}Error = <Tag extends string, E>(
  tag: Tag,
  cause: E,
  response: HttpClientResponse.HttpClientResponse,
): ${name}Error<Tag, E> =>
  new ${name}ErrorImpl({
    _tag: tag,
    cause,
    response,
    request: response.request,
  }) as any`

const resolveConfigAccessor = (operation: ParsedOperation, rootKey: string, configKey: string): string => {
  // If an operation payload is defined, then the root object must exist
  if (Predicate.isNotUndefined(operation.payload)) {
    return `${rootKey}.${configKey}`
  }

  // If operation parameters are defined and non-optional, then the root object must exist
  if (Predicate.isNotUndefined(operation.params) && !operation.paramsOptional) {
    return `${rootKey}.${configKey}`
  }

  // User-specified arguments are allowed but are not required, so the root object is optional
  return `${rootKey}?.${configKey}`
}

const resolveParamsAccessor = (operation: ParsedOperation, rootKey: string, paramsKey: string): string => {
  // If an operation payload is not defined and parameters are optional, then the
  // root object may or may not exist and parameters must be marked as optional
  if (Predicate.isUndefined(operation.payload) && operation.paramsOptional) {
    return `${rootKey}?.${paramsKey}?.`
  }

  // If parameters are optional, they must be marked as optional
  if (operation.paramsOptional) {
    return `${rootKey}.${paramsKey}?.`
  }

  return `${rootKey}.${paramsKey}`
}
