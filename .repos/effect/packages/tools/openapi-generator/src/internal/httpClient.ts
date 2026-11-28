/** @internal */
import * as Codegen from "effect/Codegen"
import * as Predicate from "effect/Predicate"
import * as String from "effect/String"
import type { ParsedOpenApi, ParsedOperation, ParsedOperationHttpClientResponses } from "../ParsedOperation.ts"
import * as Utils from "../Utils.ts"
import { namedImport, namespaceImport } from "./module.ts"

interface ImportRequirements {
  readonly eventStream: boolean
  readonly eventStreamData: boolean
  readonly eventStreamSchema: boolean
  readonly octetStream: boolean
}

const computeImportRequirements = (operations: ReadonlyArray<ParsedOperation>): ImportRequirements => {
  let eventStream = false
  let eventStreamData = false
  let eventStreamSchema = false
  let octetStream = false
  for (const op of operations) {
    const responses = op.httpClientResponses
    if (responses.sseSchema) {
      eventStream = true
      if (responses.sseSchemaMode === "event") {
        eventStreamSchema = true
      } else {
        eventStreamData = true
      }
    }
    if (responses.binarySuccessStatuses.size > 0) {
      octetStream = true
    }
  }
  return { eventStream, eventStreamData, eventStreamSchema, octetStream }
}

const registerImports = (module: Codegen.Module, importName: string, parsed: ParsedOpenApi) => ({
  Data: module.addImport(namespaceImport("effect/Data", "Data")),
  Effect: module.addImport(namespaceImport("effect/Effect", "Effect")),
  SchemaError: module.addImport(namedImport("effect/Schema", "SchemaError", true)),
  Schema: module.addImport(namespaceImport("effect/Schema", importName)),
  Stream: module.addImport(namespaceImport("effect/Stream", "Stream")),
  Sse: module.addImport(namespaceImport("effect/encoding/Sse", "Sse")),
  HttpClient: module.addImport(
    namespaceImport(
      "effect/http/HttpClient",
      "HttpClient",
      !requiresStreaming(computeImportRequirements(parsed.operations))
    )
  ),
  HttpClientError: module.addImport(namespaceImport("effect/http/HttpClientError", "HttpClientError")),
  HttpClientRequest: module.addImport(namespaceImport("effect/http/HttpClientRequest", "HttpClientRequest")),
  HttpClientResponse: module.addImport(namespaceImport("effect/http/HttpClientResponse", "HttpClientResponse"))
})

export const registerModule = (
  module: Codegen.Module,
  importName: string,
  name: string,
  parsed: ParsedOpenApi,
  typeOnly: boolean
): (parsed: ParsedOpenApi) => Codegen.Fragment => {
  const imports = registerImports(module, importName, parsed)
  const locals = module.scope()
  for (const name of ["E", "R"]) module.declare(name, { scope: locals, exact: true })
  for (const name of ["make", "OperationConfig", "WithOptionalResponse"]) module.declare(name, { exact: true })
  const client = module.declare(name)
  module.declare(`${client.name}Error`, { exact: true })
  module.declare(`${client.name}ErrorImpl`, { exact: true })
  for (const operation of parsed.operations) {
    const parameters = module.scope(locals)
    for (const name of operation.pathIds) module.declare(name, { scope: parameters })
  }
  return (parsed) => Codegen.deferred((render) => renderClient(render, imports, client.name, parsed, typeOnly))
}

const requiresStreaming = (requirements: ImportRequirements): boolean =>
  requirements.eventStream || requirements.octetStream

const hasResponseVariants = (responses: ParsedOperationHttpClientResponses): boolean =>
  responses.binarySuccessStatuses.size > 0 ||
  responses.voidSuccessStatuses.size > 0 ||
  responses.voidErrorStatuses.size > 0

const normalizeSuccessStatus = (
  responses: ParsedOperationHttpClientResponses,
  status: string
): string => {
  const successCount = responses.successSchemas.size +
    responses.binarySuccessStatuses.size +
    responses.voidSuccessStatuses.size
  return successCount === 1 && status.startsWith("2") ? "2xx" : status
}

const renderClient = (
  render: Codegen.Render,
  imports: ReturnType<typeof registerImports>,
  name: string,
  parsed: ParsedOpenApi,
  typeOnly: boolean
): string => {
  const pathArguments = (operation: ParsedOperation): Array<string> => {
    const names = Array.from(operation.path.matchAll(/{([^}]+)}/g), (match) => match[1])
    return operation.pathIds.map((id, index) => {
      const type = operation.pathSchema === undefined
        ? "string"
        : `${typeOnly ? operation.pathSchema : `(typeof ${operation.pathSchema}.Encoded)`}[${
          JSON.stringify(names[index])
        }]`
      return `${id}: ${type}`
    })
  }

  const paramsToPipeline = (operation: ParsedOperation): Array<string> => {
    const pipeline: Array<string> = []
    if (!operation.params) {
      return pipeline
    }
    const paramsAccessor = resolveParamsAccessor(operation, "options", "params")
    if (operation.urlParams.length > 0) {
      const props = operation.urlParams.map((param) => {
        const key = JSON.stringify(param)
        const value = `${paramsAccessor}[${key}]`
        return `${key}: ${operation.commaUrlParams.includes(param) ? `__joinComma(${value})` : value} as any`
      })
      pipeline.push(`${render(imports.HttpClientRequest)}.setUrlParams({ ${props.join(", ")} })`)
    }
    if (operation.headers.length > 0) {
      const props = operation.headers.map(
        (param) => `${JSON.stringify(param)}: ${paramsAccessor}[${JSON.stringify(param)}] ?? undefined`
      )
      pipeline.push(`${render(imports.HttpClientRequest)}.setHeaders({ ${props.join(", ")} })`)
    }
    if (operation.cookies.length > 0) {
      const props = operation.cookies.map(
        (param) => `${JSON.stringify(param)}: ${paramsAccessor}[${JSON.stringify(param)}]`
      )
      pipeline.push(
        `${render(imports.HttpClientRequest)}.setHeaders({ "cookie": __cookieHeader({ ${props.join(", ")} }) })`
      )
    }
    return pipeline
  }

  const requestToImpl = (operation: ParsedOperation, pipeline: Array<string>, streaming = false): string => {
    const request = `${render(imports.HttpClientRequest)}.${operation.method}`
    const pipe = `.pipe(\n      ${pipeline.join(",\n      ")}\n    )`
    if (operation.pathIds.length === 0) {
      return `${request}(${operation.pathTemplate})${pipe}`
    }
    const effect = `__makePathRequest(${request}, [${
      operation.pathIds.join(", ")
    }], () => ${operation.pathTemplate}).pipe(
    ${render(imports.Effect)}.${streaming ? "map" : "flatMap"}((request) => request${pipe})
  )`
    return streaming ? `${render(imports.Stream)}.unwrap(${effect})` : effect
  }

  const renderSchema = (importName: string, name: string, parsed: ParsedOpenApi): string => {
    const operationsToInterface = (
      _importName: string,
      name: string,
      operations: ReadonlyArray<ParsedOperation>
    ) => {
      const methods: Array<string> = []
      for (const op of operations) {
        methods.push(operationToMethod(name, op))
        if (op.httpClientResponses.sseSchema) {
          methods.push(operationToSseMethod(name, op))
        }
        if (op.httpClientResponses.binarySuccessStatuses.size > 0) {
          methods.push(operationToBinaryMethod(name, op))
        }
      }
      return `export interface ${name}<E = ${render(imports.HttpClientError)}.HttpClientError, R = never> {
  readonly httpClient: ${render(imports.HttpClient)}.HttpClient.With<E, R>
  ${methods.join("\n  ")}
}

${clientErrorSource(name)}`
    }

    const operationToMethod = (name: string, operation: ParsedOperation) => {
      const responses = operation.httpClientResponses
      const args = pathArguments(operation)

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
      const hasOptions = (operation.params && !operation.paramsOptional) || operation.payload

      const successTypes = new Set(responses.successSchemas.values())
      if (responses.binarySuccessStatuses.size > 0) {
        successTypes.add("Uint8Array")
      }
      if (responses.voidSuccessStatuses.size > 0) {
        successTypes.add("void")
      }
      const success = successTypes.size > 0 ? Array.from(successTypes).join(" | ") : "void"
      const errors = ["E", `${render(imports.HttpClientError)}.HttpClientError`, `${render(imports.SchemaError)}`]
      if (responses.errorSchemas.size > 0) {
        Utils.spreadElementsInto(
          Array.from(responses.errorSchemas.values()).map(
            (schema) => `${name}Error<"${schema}", ${schema}>`
          ),
          errors
        )
      }
      for (const status of responses.voidErrorStatuses) {
        errors.push(`${name}Error<"${status}", undefined>`)
      }

      const jsdoc = Utils.toComment(operation.description)
      const methodKey = `readonly ${JSON.stringify(operation.id)}`
      return `${jsdoc}${methodKey}: ${operationSignatures(args, options, Boolean(hasOptions), success, errors)}`
    }

    const operationToSseMethod = (_name: string, operation: ParsedOperation) => {
      const responses = operation.httpClientResponses
      const args = pathArguments(operation)

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
      const methodKey = `readonly ${JSON.stringify(`${operation.id}Sse`)}`
      const parameters = args.join(", ")
      const value = responses.sseSchemaMode === "event"
        ? responses.sseSchema
        : `{ readonly event: string; readonly id: string | undefined; readonly data: ${responses.sseSchema} }`
      const returnType = `${render(imports.Stream)}.Stream<${value}, E | ${
        render(imports.HttpClientError)
      }.HttpClientError | ${render(imports.SchemaError)} | ${render(imports.Sse)}.Retry | ${
        render(imports.Sse)
      }.SseError, R | typeof ${responses.sseSchema}.DecodingServices>`
      return `${jsdoc}${methodKey}: (${parameters}) => ${returnType}`
    }

    const operationToBinaryMethod = (_name: string, operation: ParsedOperation) => {
      const args = pathArguments(operation)

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
      const methodKey = `readonly ${JSON.stringify(`${operation.id}Stream`)}`
      const parameters = args.join(", ")
      const returnType = `${render(imports.Stream)}.Stream<Uint8Array, E | ${
        render(imports.HttpClientError)
      }.HttpClientError, R>`
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
        implMethods.push(operationToImpl(name, op))
        if (op.httpClientResponses.sseSchema) {
          implMethods.push(operationToSseImpl(importName, op))
        }
        if (op.httpClientResponses.binarySuccessStatuses.size > 0) {
          implMethods.push(operationToBinaryImpl(op))
        }
      }

      const helpers: Array<string> = [commonSource()]
      if (operations.some((operation) => operation.commaUrlParams.length > 0)) {
        helpers.push(commaUrlParamsSource())
      }
      if (operations.some((operation) => operation.pathIds.length > 0)) {
        helpers.push(pathRequestSource())
      }
      if (operations.some((operation) => operation.cookies.length > 0)) {
        helpers.push(cookieHeaderSource())
      }
      if (requiresStreaming(requirements)) {
        helpers.push(executeStreamRequestSource())
      }
      if (requirements.eventStreamData) {
        helpers.push(sseRequestSource(importName))
      }
      if (requirements.eventStreamSchema) {
        helpers.push(sseEventRequestSource())
      }
      if (requirements.octetStream) {
        helpers.push(decodeBinarySource())
        helpers.push(binaryRequestSource())
      }
      if (operations.some((operation) => operation.httpClientResponses.voidErrorStatuses.size > 0)) {
        helpers.push(decodeVoidErrorSource(name))
      }
      helpers.push(decodeSuccessSource(importName))
      if (operations.some((operation) => operation.httpClientResponses.errorSchemas.size > 0)) {
        helpers.push(decodeErrorSource(importName, name))
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
export type WithOptionalResponse<A, Config extends OperationConfig | undefined> = Config extends {
  readonly includeResponse: true
} ? [A, ${render(imports.HttpClientResponse)}.HttpClientResponse]
  : Config extends { readonly includeResponse?: false | undefined } | undefined ? A
  : A | [A, ${render(imports.HttpClientResponse)}.HttpClientResponse]

export const make = <E, R>(
  httpClient: ${render(imports.HttpClient)}.HttpClient.With<E, R>,
  options: {
    readonly transformClient?: ((client: ${render(imports.HttpClient)}.HttpClient.With<E, R>) => ${
        render(imports.Effect)
      }.Effect<${render(imports.HttpClient)}.HttpClient.With<E, R>>) | undefined
  } = {}
): ${name}<E, R> => {
  ${helpers.join("\n  ")}
  return {
    httpClient,
    ${implMethods.join(",\n    ")}
  }
}`
    }

    const operationToImpl = (name: string, operation: ParsedOperation) => {
      const responses = operation.httpClientResponses
      const params = [
        ...operation.pathIds,
        `options: Parameters<${name}[${JSON.stringify(operation.id)}]>[${operation.pathIds.length}]`
      ].join(", ")

      const pipeline: Array<string> = []

      pipeline.push(...paramsToPipeline(operation))

      const payloadVarName = "options.payload"
      if (operation.payloadFormData) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyFormDataRecord(${payloadVarName} as any)`)
      } else if (operation.payloadFormUrlEncoded) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyUrlParams(${payloadVarName} as any)`)
      } else if (operation.payload) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyJsonUnsafe(${payloadVarName})`)
      }

      const decodes: Array<string> = []
      responses.successSchemas.forEach((schema, status) => {
        decodes.push(`"${normalizeSuccessStatus(responses, status)}": decodeSuccess(${schema})`)
      })
      responses.binarySuccessStatuses.forEach((status) => {
        decodes.push(`"${normalizeSuccessStatus(responses, status)}": decodeBinary`)
      })
      responses.errorSchemas.forEach((schema, status) => {
        decodes.push(`"${status}": decodeError("${schema}", ${schema})`)
      })
      responses.voidSuccessStatuses.forEach((status) => {
        decodes.push(`"${status}": () => ${render(imports.Effect)}.void`)
      })
      responses.voidErrorStatuses.forEach((status) => {
        decodes.push(`"${status}": decodeVoidError("${status}")`)
      })
      decodes.push(`orElse: unexpectedStatus`)

      const configAccessor = resolveConfigAccessor(operation, "options", "config")
      pipeline.push(`withResponse(${configAccessor})(${render(imports.HttpClientResponse)}.matchStatus({
      ${decodes.join(",\n      ")}
    }))`)

      return (
        `${JSON.stringify(operation.id)}: (${params}) => ` +
        requestToImpl(operation, pipeline)
      )
    }

    const operationToSseImpl = (_importName: string, operation: ParsedOperation) => {
      const responses = operation.httpClientResponses
      const args: Array<string> = [...operation.pathIds]
      const hasOptions = (operation.params && !operation.paramsOptional) || operation.payload
      if (hasOptions || operation.params || operation.payload) {
        args.push("options")
      }
      const params = args.join(", ")

      const pipeline: Array<string> = []

      pipeline.push(...paramsToPipeline(operation))

      if (operation.payloadFormData) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyFormDataRecord(options.payload as any)`)
      } else if (operation.payloadFormUrlEncoded) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyUrlParams(options.payload as any)`)
      } else if (operation.payload) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyJsonUnsafe(options.payload)`)
      }

      pipeline.push(`${responses.sseSchemaMode === "event" ? "sseEventRequest" : "sseRequest"}(${responses.sseSchema})`)

      return (
        `${JSON.stringify(`${operation.id}Sse`)}: (${params}) => ` +
        requestToImpl(operation, pipeline, true)
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

      pipeline.push(...paramsToPipeline(operation))

      if (operation.payloadFormData) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyFormDataRecord(options.payload as any)`)
      } else if (operation.payloadFormUrlEncoded) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyUrlParams(options.payload as any)`)
      } else if (operation.payload) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyJsonUnsafe(options.payload)`)
      }

      pipeline.push(`binaryRequest`)

      return (
        `${JSON.stringify(`${operation.id}Stream`)}: (${params}) => ` +
        requestToImpl(operation, pipeline, true)
      )
    }

    return String.stripMargin(
      `|${operationsToImpl(importName, name, parsed.operations)}
     |
     |${operationsToInterface(importName, name, parsed.operations)}`
    )
  }

  const renderTypeOnly = (importName: string, name: string, parsed: ParsedOpenApi): string => {
    const operationsToInterface = (
      _importName: string,
      name: string,
      operations: ReadonlyArray<ParsedOperation>
    ) => {
      const methods: Array<string> = []
      for (const op of operations) {
        methods.push(operationToMethod(name, op))
        if (op.httpClientResponses.sseSchema) {
          methods.push(operationToSseMethod(op))
        }
        if (op.httpClientResponses.binarySuccessStatuses.size > 0) {
          methods.push(operationToBinaryMethod(op))
        }
      }
      return `export interface ${name}<E = ${render(imports.HttpClientError)}.HttpClientError, R = never> {
  readonly httpClient: ${render(imports.HttpClient)}.HttpClient.With<E, R>
  ${methods.join("\n  ")}
}

${clientErrorSource(name)}`
    }

    const operationToMethod = (name: string, operation: ParsedOperation) => {
      const responses = operation.httpClientResponses
      const args = pathArguments(operation)

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

      const successTypes = new Set(responses.successSchemas.values())
      if (responses.binarySuccessStatuses.size > 0) {
        successTypes.add("Uint8Array")
      }
      if (responses.voidSuccessStatuses.size > 0) {
        successTypes.add("void")
      }
      const success = successTypes.size > 0 ? Array.from(successTypes).join(" | ") : "void"

      const errors = ["E", `${render(imports.HttpClientError)}.HttpClientError`]
      if (responses.errorSchemas.size > 0) {
        for (const schema of responses.errorSchemas.values()) {
          errors.push(`${name}Error<"${schema}", ${schema}>`)
        }
      }
      for (const status of responses.voidErrorStatuses) {
        errors.push(`${name}Error<"${status}", undefined>`)
      }

      const jsdoc = Utils.toComment(operation.description)
      const methodKey = `readonly ${JSON.stringify(operation.id)}`
      return `${jsdoc}${methodKey}: ${operationSignatures(args, options, Boolean(hasOptions), success, errors)}`
    }

    const operationToSseMethod = (operation: ParsedOperation) => {
      const responses = operation.httpClientResponses
      const args = pathArguments(operation)

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
      const methodKey = `readonly ${JSON.stringify(`${operation.id}Sse`)}`
      const parameters = args.join(", ")
      const returnType = `${render(imports.Stream)}.Stream<${responses.sseSchema}, E | ${
        render(imports.HttpClientError)
      }.HttpClientError, R>`
      return `${jsdoc}${methodKey}: (${parameters}) => ${returnType}`
    }

    const operationToBinaryMethod = (operation: ParsedOperation) => {
      const args = pathArguments(operation)

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
      const methodKey = `readonly ${JSON.stringify(`${operation.id}Stream`)}`
      const parameters = args.join(", ")
      const returnType = `${render(imports.Stream)}.Stream<Uint8Array, E | ${
        render(imports.HttpClientError)
      }.HttpClientError, R>`
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
        implMethods.push(operationToImpl(name, op))
        if (op.httpClientResponses.sseSchema) {
          implMethods.push(operationToSseImpl(op))
        }
        if (op.httpClientResponses.binarySuccessStatuses.size > 0) {
          implMethods.push(operationToBinaryImpl(op))
        }
      }

      const helpers: Array<string> = [commonSource()]
      if (operations.some((operation) => operation.commaUrlParams.length > 0)) {
        helpers.push(commaUrlParamsSource())
      }
      if (operations.some((operation) => operation.pathIds.length > 0)) {
        helpers.push(pathRequestSource())
      }
      if (operations.some((operation) => operation.cookies.length > 0)) {
        helpers.push(cookieHeaderSource())
      }
      if (requiresStreaming(requirements)) {
        helpers.push(executeStreamRequestSource())
      }
      if (requirements.eventStream) {
        helpers.push(sseRequestSourceTs())
      }
      const withResponseVariants = operations.some((op) => hasResponseVariants(op.httpClientResponses))
      if (withResponseVariants) {
        helpers.push(decodeBinarySource())
        helpers.push(decodeVoidErrorSource(name))
      }
      if (requirements.octetStream) {
        helpers.push(binaryRequestSourceTs())
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
export type WithOptionalResponse<A, Config extends OperationConfig | undefined> = Config extends {
  readonly includeResponse: true
} ? [A, ${render(imports.HttpClientResponse)}.HttpClientResponse]
  : Config extends { readonly includeResponse?: false | undefined } | undefined ? A
  : A | [A, ${render(imports.HttpClientResponse)}.HttpClientResponse]

export const make = <E, R>(
  httpClient: ${render(imports.HttpClient)}.HttpClient.With<E, R>,
  options: {
    readonly transformClient?: ((client: ${render(imports.HttpClient)}.HttpClient.With<E, R>) => ${
        render(imports.Effect)
      }.Effect<${render(imports.HttpClient)}.HttpClient.With<E, R>>) | undefined
  } = {}
): ${name}<E, R> => {
  ${helpers.join("\n  ")}
  const decodeSuccess = <A>(response: ${render(imports.HttpClientResponse)}.HttpClientResponse) =>
    response.json as ${render(imports.Effect)}.Effect<A, ${render(imports.HttpClientError)}.HttpClientError>
  const decodeVoid = (_response: ${render(imports.HttpClientResponse)}.HttpClientResponse) =>
    ${render(imports.Effect)}.void
  const decodeError =
    <Tag extends string, E>(tag: Tag) =>
    (
      response: ${render(imports.HttpClientResponse)}.HttpClientResponse,
    ): ${render(imports.Effect)}.Effect<
      never,
      ${name}Error<Tag, E> | ${render(imports.HttpClientError)}.HttpClientError
    > =>
      ${render(imports.Effect)}.flatMap(
        response.json as ${render(imports.Effect)}.Effect<E, ${render(imports.HttpClientError)}.HttpClientError>,
        (cause) => ${render(imports.Effect)}.fail(${name}Error(tag, cause, response)),
      )
  ${onRequestSource(withResponseVariants)}
  return {
    httpClient,
    ${implMethods.join(",\n    ")}
  }
}`
    }

    const operationToImpl = (name: string, operation: ParsedOperation) => {
      const responses = operation.httpClientResponses
      const params = [
        ...operation.pathIds,
        `options: Parameters<${name}[${JSON.stringify(operation.id)}]>[${operation.pathIds.length}]`
      ].join(", ")

      const pipeline: Array<string> = []

      pipeline.push(...paramsToPipeline(operation))

      const payloadAccessor = "options.payload"
      if (operation.payloadFormData) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyFormDataRecord(${payloadAccessor} as any)`)
      } else if (operation.payloadFormUrlEncoded) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyUrlParams(${payloadAccessor} as any)`)
      } else if (operation.payload) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyJsonUnsafe(${payloadAccessor})`)
      }

      const successCodes = Array.from(
        responses.successSchemas.keys(),
        (status) => JSON.stringify(normalizeSuccessStatus(responses, status))
      ).join(", ")
      const errorCodes = responses.errorSchemas.size > 0 &&
        Object.fromEntries(responses.errorSchemas.entries())
      const configAccessor = resolveConfigAccessor(operation, "options", "config")
      const requestArgs = [`[${successCodes}]`]
      if (hasResponseVariants(responses)) {
        const responseCodes = {
          binary: Array.from(
            responses.binarySuccessStatuses,
            (status) => normalizeSuccessStatus(responses, status)
          ),
          voidSuccess: Array.from(responses.voidSuccessStatuses),
          voidError: Array.from(responses.voidErrorStatuses)
        }
        requestArgs.push(errorCodes ? JSON.stringify(errorCodes) : "undefined", JSON.stringify(responseCodes))
      } else if (errorCodes) {
        requestArgs.push(JSON.stringify(errorCodes))
      }
      pipeline.push(`onRequest(${configAccessor})(${requestArgs.join(", ")})`)

      return (
        `${JSON.stringify(operation.id)}: (${params}) => ` +
        requestToImpl(operation, pipeline)
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

      pipeline.push(...paramsToPipeline(operation))

      if (operation.payloadFormData) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyFormDataRecord(options.payload as any)`)
      } else if (operation.payloadFormUrlEncoded) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyUrlParams(options.payload as any)`)
      } else if (operation.payload) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyJsonUnsafe(options.payload)`)
      }

      pipeline.push(`sseRequest<${operation.httpClientResponses.sseSchema}>`)

      return (
        `${JSON.stringify(`${operation.id}Sse`)}: (${params}) => ` +
        requestToImpl(operation, pipeline, true)
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

      pipeline.push(...paramsToPipeline(operation))

      if (operation.payloadFormData) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyFormDataRecord(options.payload as any)`)
      } else if (operation.payloadFormUrlEncoded) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyUrlParams(options.payload as any)`)
      } else if (operation.payload) {
        pipeline.push(`${render(imports.HttpClientRequest)}.bodyJsonUnsafe(options.payload)`)
      }

      pipeline.push(`binaryRequest`)

      return (
        `${JSON.stringify(`${operation.id}Stream`)}: (${params}) => ` +
        requestToImpl(operation, pipeline, true)
      )
    }

    return String.stripMargin(
      `|${operationsToImpl(importName, name, parsed.operations)}
     |
     |${operationsToInterface(importName, name, parsed.operations)}`
    )
  }

  const pathRequestSource = () =>
    `const __encodePathParam = (
    name: string,
    value: unknown,
    style: "simple" | "label" | "matrix",
    explode: boolean,
  ): string => {
    const encode = (value: unknown): string => {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new TypeError("Path parameters must be scalars or arrays of scalars")
      }
      return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase())
    }
    const values = Array.isArray(value) ? value.map(encode) : [encode(value)]
    if (values.length === 0) throw new TypeError("Path parameter arrays must be non-empty")
    switch (style) {
      case "simple": {
        const result = values.join(",")
        if (result === "") throw new TypeError("Path parameters must be non-empty")
        return result
      }
      case "label": return "." + values.join(explode ? "." : ",")
      case "matrix": {
        const prefix = ";" + encode(name)
        return explode
          ? values.map((value) => prefix + (value === "" ? "" : "=" + value)).join("")
          : prefix + "=" + values.join(",")
      }
    }
  }
  const __makePathRequest = (
    method: (url: string) => ${render(imports.HttpClientRequest)}.HttpClientRequest,
    parameters: ReadonlyArray<unknown>,
    getPath: () => string,
  ) => ${render(imports.Effect)}.suspend(() => {
    const fail = (description: string, cause?: unknown) => ${render(imports.Effect)}.fail(
      new ${render(imports.HttpClientError)}.HttpClientError({
        reason: new ${render(imports.HttpClientError)}.InvalidUrlError({
          request: method(""),
          cause,
          description,
        }),
      }),
    )
    if (parameters.some((value) => typeof value === "string" && (value === "" || /^(?:\\.|%2e){1,2}$/i.test(value)))) {
      return fail("Path parameters must be non-empty and cannot be dot segments")
    }
    let path: string
    try {
      path = getPath()
    } catch (cause) {
      return fail("Failed to encode path parameter", cause)
    }
    if (path.split("/").some((segment) => /^(?:\\.|%2e){1,2}$/i.test(segment))) {
      return fail("Request paths cannot contain dot segments")
    }
    return ${render(imports.Effect)}.succeed(method(path))
  })`

  const commaUrlParamsSource = () =>
    `const __joinComma = (value: unknown) => Array.isArray(value) && value.length > 0 ? value.join(",") : value`

  const cookieHeaderSource = () =>
    `const __cookieHeader = (cookies: Record<string, unknown>) => {
    const header = Object.entries(cookies)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]) => \`\${name}=\${encodeURIComponent(String(value))}\`)
      .join("; ")
    return header === "" ? undefined : header
  }`

  const commonSource = () =>
    `const unexpectedStatus = (response: ${render(imports.HttpClientResponse)}.HttpClientResponse) =>
    ${render(imports.Effect)}.flatMap(
      ${render(imports.Effect)}.orElseSucceed(response.json, () => "Unexpected status code"),
      (description) =>
        ${render(imports.Effect)}.fail(
          new ${render(imports.HttpClientError)}.HttpClientError({
            reason: new ${render(imports.HttpClientError)}.StatusCodeError({
              request: response.request,
              response,
              description: typeof description === "string" ? description : JSON.stringify(description),
            }),
          }),
        ),
    )
  const withResponse = <Config extends OperationConfig>(config: Config | undefined) => (
    f: (response: ${render(imports.HttpClientResponse)}.HttpClientResponse) => ${
      render(imports.Effect)
    }.Effect<any, any>,
  ): (request: ${render(imports.HttpClientRequest)}.HttpClientRequest) => ${
      render(imports.Effect)
    }.Effect<any, any, R> => {
    const withOptionalResponse = (
      config?.includeResponse
        ? (response: ${render(imports.HttpClientResponse)}.HttpClientResponse) => ${
      render(imports.Effect)
    }.map(f(response), (a) => [a, response])
        : (response: ${render(imports.HttpClientResponse)}.HttpClientResponse) => f(response)
    ) as any
    return options?.transformClient
      ? (request) =>
          ${render(imports.Effect)}.flatMap(
            ${
      render(imports.Effect)
    }.flatMap(options.transformClient!(httpClient), (client) => client.execute(request)),
            withOptionalResponse
          )
      : (request) => ${render(imports.Effect)}.flatMap(httpClient.execute(request), withOptionalResponse)
  }`

  const decodeBinarySource = () =>
    `const decodeBinary = (response: ${render(imports.HttpClientResponse)}.HttpClientResponse) =>
    ${render(imports.Effect)}.map(response.arrayBuffer, (buffer) => new Uint8Array(buffer))`

  const decodeSuccessSource = (importName: string) =>
    `const decodeSuccess =
    <Schema extends ${importName}.Constraint>(schema: Schema) =>
    (response: ${render(imports.HttpClientResponse)}.HttpClientResponse) =>
      ${render(imports.HttpClientResponse)}.schemaBodyJson(schema)(response)`

  const decodeErrorSource = (importName: string, name: string) =>
    `const decodeError =
    <const Tag extends string, Schema extends ${importName}.Constraint>(tag: Tag, schema: Schema) =>
    (response: ${render(imports.HttpClientResponse)}.HttpClientResponse) =>
      ${render(imports.Effect)}.flatMap(
        ${render(imports.HttpClientResponse)}.schemaBodyJson(schema)(response),
        (cause) => ${render(imports.Effect)}.fail(${name}Error(tag, cause, response)),
      )`

  const decodeVoidErrorSource = (name: string) =>
    `const decodeVoidError = <const Tag extends string>(tag: Tag) =>
    (response: ${render(imports.HttpClientResponse)}.HttpClientResponse) =>
      ${render(imports.Effect)}.fail(${name}Error(tag, undefined, response))`

  const onRequestSource = (withResponseVariants: boolean) => {
    const responseCodesParam = withResponseVariants
      ? `
    responseCodes: {
      readonly binary: ReadonlyArray<string>
      readonly voidSuccess: ReadonlyArray<string>
      readonly voidError: ReadonlyArray<string>
    } = { binary: [], voidSuccess: [], voidError: [] },`
      : ""
    const responseCodesCases = withResponseVariants
      ? `
    for (const code of responseCodes.binary) {
      cases[code] = decodeBinary
    }
    for (const code of responseCodes.voidSuccess) {
      cases[code] = decodeVoid
    }
    for (const code of responseCodes.voidError) {
      cases[code] = decodeVoidError(code)
    }`
      : ""
    const voidFallbackCondition = withResponseVariants
      ? "successCodes.length === 0 && responseCodes.binary.length === 0 && responseCodes.voidSuccess.length === 0"
      : "successCodes.length === 0"
    return `const onRequest = <Config extends OperationConfig>(config: Config | undefined) => (
    successCodes: ReadonlyArray<string>,
    errorCodes?: Record<string, string>,${responseCodesParam}
  ) => {
    const cases: any = { orElse: unexpectedStatus }
    for (const code of successCodes) {
      cases[code] = decodeSuccess
    }
    if (errorCodes) {
      for (const [code, tag] of Object.entries(errorCodes)) {
        cases[code] = decodeError(tag)
      }
    }${responseCodesCases}
    if (${voidFallbackCondition}) {
      cases["2xx"] = decodeVoid
    }
    return withResponse(config)(${render(imports.HttpClientResponse)}.matchStatus(cases) as any)
  }`
  }

  const executeStreamRequestSource = () =>
    `const executeStreamRequest = (request: ${render(imports.HttpClientRequest)}.HttpClientRequest) =>
    ${render(imports.Effect)}.suspend(() =>
      options.transformClient
        ? ${render(imports.Effect)}.flatMap(options.transformClient(httpClient), (client) => ${
      render(imports.HttpClient)
    }.filterStatusOk(client).execute(request))
        : ${render(imports.HttpClient)}.filterStatusOk(httpClient).execute(request)
    )`

  const sseRequestSource = (importName: string) =>
    `const sseRequest = <
     Type,
     DecodingServices
    >(
      schema: ${importName}.ConstraintDecoder<Type, DecodingServices>
    ) =>
    (
      request: ${render(imports.HttpClientRequest)}.HttpClientRequest
    ): ${render(imports.Stream)}.Stream<
      { readonly event: string; readonly id: string | undefined; readonly data: Type },
      E | ${render(imports.HttpClientError)}.HttpClientError | ${render(imports.SchemaError)} | ${
      render(imports.Sse)
    }.Retry | ${render(imports.Sse)}.SseError,
      R | DecodingServices
    > =>
      executeStreamRequest(request).pipe(
        ${render(imports.Effect)}.map((response) => response.stream),
        ${render(imports.Stream)}.unwrap,
        ${render(imports.Stream)}.decodeText(),
        ${render(imports.Stream)}.pipeThroughChannel(${render(imports.Sse)}.decodeDataSchema(schema))
      )`

  const sseEventRequestSource = () =>
    `const sseEventRequest = <S extends ${render(imports.Sse)}.EventCodec>(schema: S) =>
    (
      request: ${render(imports.HttpClientRequest)}.HttpClientRequest
    ): ${render(imports.Stream)}.Stream<
      S["Type"],
      E | ${render(imports.HttpClientError)}.HttpClientError | ${render(imports.SchemaError)} | ${
      render(imports.Sse)
    }.Retry | ${render(imports.Sse)}.SseError,
      R | S["DecodingServices"]
    > =>
      executeStreamRequest(request).pipe(
        ${render(imports.Effect)}.map((response) => response.stream),
        ${render(imports.Stream)}.unwrap,
        ${render(imports.Stream)}.decodeText(),
        ${render(imports.Stream)}.pipeThroughChannel(${render(imports.Sse)}.decodeSchema(schema))
      )`

  const binaryRequestSource = () =>
    `const binaryRequest = (request: ${render(imports.HttpClientRequest)}.HttpClientRequest): ${
      render(imports.Stream)
    }.Stream<Uint8Array, E | ${render(imports.HttpClientError)}.HttpClientError, R> =>
    executeStreamRequest(request).pipe(
      ${render(imports.Effect)}.map((response) => response.stream),
      ${render(imports.Stream)}.unwrap
    )`

  // Type-only mode helpers (no schema decoding)
  const sseRequestSourceTs = () =>
    `const sseRequest = <A>(request: ${render(imports.HttpClientRequest)}.HttpClientRequest): ${
      render(imports.Stream)
    }.Stream<A, E | ${render(imports.HttpClientError)}.HttpClientError, R> =>
    executeStreamRequest(request).pipe(
      ${render(imports.Effect)}.map((response) => response.stream),
      ${render(imports.Stream)}.unwrap,
      ${render(imports.Stream)}.decodeText(),
      ${render(imports.Stream)}.splitLines,
      ${render(imports.Stream)}.filter((line) => line.startsWith("data: ")),
      ${render(imports.Stream)}.map((line) => JSON.parse(line.slice(6)) as A)
    )`

  const binaryRequestSourceTs = () =>
    `const binaryRequest = (request: ${render(imports.HttpClientRequest)}.HttpClientRequest): ${
      render(imports.Stream)
    }.Stream<Uint8Array, E | ${render(imports.HttpClientError)}.HttpClientError, R> =>
    executeStreamRequest(request).pipe(
      ${render(imports.Effect)}.map((response) => response.stream),
      ${render(imports.Stream)}.unwrap
    )`

  const clientErrorSource = (
    name: string
  ) =>
    `export interface ${name}Error<Tag extends string, E> {
  readonly _tag: Tag
  readonly request: ${render(imports.HttpClientRequest)}.HttpClientRequest
  readonly response: ${render(imports.HttpClientResponse)}.HttpClientResponse
  readonly cause: E
}

class ${name}ErrorImpl extends ${render(imports.Data)}.Error<{
  _tag: string
  cause: any
  request: ${render(imports.HttpClientRequest)}.HttpClientRequest
  response: ${render(imports.HttpClientResponse)}.HttpClientResponse
}> {}

export const ${name}Error = <Tag extends string, E>(
  tag: Tag,
  cause: E,
  response: ${render(imports.HttpClientResponse)}.HttpClientResponse,
): ${name}Error<Tag, E> =>
  new ${name}ErrorImpl({
    _tag: tag,
    cause,
    response,
    request: response.request,
  }) as any`

  const operationSignatures = (
    args: ReadonlyArray<string>,
    options: ReadonlyArray<string>,
    optionsRequired: boolean,
    success: string,
    errors: ReadonlyArray<string>
  ): string => {
    const signature = (configOptional: boolean) => {
      const config = configOptional ? "Config | undefined" : "Config"
      const fields = [...options, `readonly config${configOptional ? "?" : ""}: ${config}`].join("; ")
      const parameters = [...args, `options: { ${fields} }${configOptional && !optionsRequired ? " | undefined" : ""}`]
      return `    <Config extends OperationConfig | undefined = undefined>(${parameters.join(", ")}): ${
        render(imports.Effect)
      }.Effect<WithOptionalResponse<${success}, ${config}>, ${errors.join(" | ")}, R>;`
    }
    // Infer the whole config from a required property before allowing omitted config.
    // An optional property would otherwise discard undefined during inference.
    return `{
${signature(false)}
${signature(true)}
  }`
  }

  return typeOnly ? renderTypeOnly("", name, parsed) : renderSchema(render(imports.Schema), name, parsed)
}

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
