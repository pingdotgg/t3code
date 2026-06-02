import * as OpenApiGenerator from "@effect/openapi-generator/OpenApiGenerator"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type { OpenAPISpec } from "effect/unstable/httpapi/OpenApi"

function assertRuntime(spec: OpenAPISpec, expected: string) {
  return Effect.gen(function*() {
    const generator = yield* OpenApiGenerator.OpenApiGenerator

    const result = yield* generator.generate(spec, {
      name: "TestClient",
      format: "httpclient"
    })

    // console.log(result)
    assert.strictEqual(result, expected)
  }).pipe(
    Effect.provide(OpenApiGenerator.layerTransformerSchema)
  )
}

function assertTypeOnly(spec: OpenAPISpec, expected: string) {
  return Effect.gen(function*() {
    const generator = yield* OpenApiGenerator.OpenApiGenerator

    const result = yield* generator.generate(spec, {
      name: "TestClient",
      format: "httpclient-type-only"
    })

    // console.log(result)
    assert.strictEqual(result, expected)
  }).pipe(
    Effect.provide(OpenApiGenerator.layerTransformerTs)
  )
}

function assertRuntimeIncludes(spec: OpenAPISpec, includes: ReadonlyArray<string>) {
  return Effect.gen(function*() {
    const generator = yield* OpenApiGenerator.OpenApiGenerator

    const result = yield* generator.generate(spec, {
      name: "TestClient",
      format: "httpclient"
    })

    for (const expected of includes) {
      assert.include(result, expected)
    }
  }).pipe(
    Effect.provide(OpenApiGenerator.layerTransformerSchema)
  )
}

function assertHttpApiIncludes(
  spec: OpenAPISpec,
  includes: ReadonlyArray<string>,
  excludes: ReadonlyArray<string> = []
) {
  return Effect.gen(function*() {
    const generator = yield* OpenApiGenerator.OpenApiGenerator

    const result = yield* generator.generate(spec, {
      name: "TestClient",
      format: "httpapi"
    })

    for (const expected of includes) {
      assert.include(result, expected)
    }
    for (const excluded of excludes) {
      assert.notInclude(result, excluded)
    }
  }).pipe(
    Effect.provide(OpenApiGenerator.layerTransformerSchema)
  )
}

function assertHttpApiWithWarnings(
  spec: OpenAPISpec,
  options: {
    readonly includes?: ReadonlyArray<string> | undefined
    readonly excludes?: ReadonlyArray<string> | undefined
    readonly occurrences?:
      | ReadonlyArray<{
        readonly substring: string
        readonly count: number
      }>
      | undefined
    readonly warnings: ReadonlyArray<
      Pick<OpenApiGenerator.OpenApiGeneratorWarning, "code" | "path" | "method" | "operationId">
    >
  }
) {
  return Effect.gen(function*() {
    const generator = yield* OpenApiGenerator.OpenApiGenerator
    const warnings: Array<OpenApiGenerator.OpenApiGeneratorWarning> = []

    const result = yield* generator.generate(spec, {
      name: "TestClient",
      format: "httpapi",
      onWarning: (warning) => {
        warnings.push(warning)
      }
    })

    for (const expected of options.includes ?? []) {
      assert.include(result, expected)
    }
    for (const excluded of options.excludes ?? []) {
      assert.notInclude(result, excluded)
    }
    for (const { substring, count } of options.occurrences ?? []) {
      assert.strictEqual(result.split(substring).length - 1, count)
    }

    assert.deepStrictEqual(
      warnings.map((warning) => ({
        code: warning.code,
        path: warning.path,
        method: warning.method,
        operationId: warning.operationId
      })),
      options.warnings
    )
  }).pipe(
    Effect.provide(OpenApiGenerator.layerTransformerSchema)
  )
}

function assertRuntimeStableWithWarnings(
  spec: OpenAPISpec,
  expectedWarnings: ReadonlyArray<
    Pick<OpenApiGenerator.OpenApiGeneratorWarning, "code" | "path" | "method" | "operationId">
  >
) {
  return Effect.gen(function*() {
    const generator = yield* OpenApiGenerator.OpenApiGenerator
    const warnings: Array<OpenApiGenerator.OpenApiGeneratorWarning> = []

    const baseline = yield* generator.generate(spec, {
      name: "TestClient",
      format: "httpclient"
    })
    const withWarnings = yield* generator.generate(spec, {
      name: "TestClient",
      format: "httpclient",
      onWarning: (warning) => {
        warnings.push(warning)
      }
    })

    assert.strictEqual(withWarnings, baseline)
    assert.deepStrictEqual(
      warnings.map((warning) => ({
        code: warning.code,
        path: warning.path,
        method: warning.method,
        operationId: warning.operationId
      })),
      expectedWarnings
    )
  }).pipe(
    Effect.provide(OpenApiGenerator.layerTransformerSchema)
  )
}

function assertTypeOnlyStableWithWarnings(
  spec: OpenAPISpec,
  expectedWarnings: ReadonlyArray<
    Pick<OpenApiGenerator.OpenApiGeneratorWarning, "code" | "path" | "method" | "operationId">
  >
) {
  return Effect.gen(function*() {
    const generator = yield* OpenApiGenerator.OpenApiGenerator
    const warnings: Array<OpenApiGenerator.OpenApiGeneratorWarning> = []

    const baseline = yield* generator.generate(spec, {
      name: "TestClient",
      format: "httpclient-type-only"
    })
    const withWarnings = yield* generator.generate(spec, {
      name: "TestClient",
      format: "httpclient-type-only",
      onWarning: (warning) => {
        warnings.push(warning)
      }
    })

    assert.strictEqual(withWarnings, baseline)
    assert.deepStrictEqual(
      warnings.map((warning) => ({
        code: warning.code,
        path: warning.path,
        method: warning.method,
        operationId: warning.operationId
      })),
      expectedWarnings
    )
  }).pipe(
    Effect.provide(OpenApiGenerator.layerTransformerTs)
  )
}

const regressionSpec: OpenAPISpec = {
  openapi: "3.1.0",
  info: {
    title: "Regression API",
    version: "1.0.0"
  },
  paths: {
    "/users/{id}": {
      get: {
        operationId: "getUser",
        summary: "Get user",
        description: "Read a user",
        parameters: [
          {
            name: "id",
            in: "path",
            schema: {
              type: "string"
            },
            required: true
          },
          {
            name: "filter",
            in: "query",
            schema: {
              type: "string"
            },
            required: false
          },
          {
            name: "trace-id",
            in: "header",
            schema: {
              type: "string"
            },
            required: false
          },
          {
            name: "session",
            in: "cookie",
            schema: {
              type: "string"
            },
            required: false
          }
        ],
        responses: {
          default: {
            description: "Default user response",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string"
                    }
                  },
                  required: ["id"],
                  additionalProperties: false
                }
              }
            }
          }
        } as any,
        tags: ["Users"],
        security: [{ apiKey: [] }]
      }
    }
  },
  components: {
    schemas: {},
    securitySchemes: {
      apiKey: {
        type: "apiKey",
        name: "x-api-key",
        in: "header"
      }
    }
  },
  security: [],
  tags: [{ name: "Users" }]
}

describe("OpenApiGenerator", () => {
  describe("schema", () => {
    it.effect("get operation", () =>
      assertRuntime(
        {
          openapi: "3.1.0",
          info: {
            title: "Test API",
            version: "1.0.0"
          },
          paths: {
            "/users/{id}": {
              get: {
                operationId: "getUser",
                parameters: [
                  {
                    name: "id",
                    in: "path",
                    schema: {
                      type: "string"
                    },
                    required: true
                  }
                ],
                responses: {
                  200: {
                    description: "User retrieved successfully",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            id: {
                              type: "string"
                            },
                            name: {
                              type: "string"
                            }
                          },
                          required: ["id", "name"],
                          additionalProperties: false,
                          description: "User object"
                        }
                      }
                    }
                  }
                },
                tags: ["Users"],
                security: []
              }
            }
          },
          components: {
            schemas: {},
            securitySchemes: {}
          },
          security: [],
          tags: []
        },
        `import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type { SchemaError } from "effect/Schema"
import * as Schema from "effect/Schema"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
// schemas
export type GetUser200 = { readonly "id": string, readonly "name": string }
export const GetUser200 = Schema.Struct({ "id": Schema.String, "name": Schema.String }).annotate({ "description": "User object" })

export interface OperationConfig {
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
): TestClient => {
  const unexpectedStatus = (response: HttpClientResponse.HttpClientResponse) =>
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
  }
  const decodeSuccess =
    <Schema extends Schema.Top>(schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response)
  const decodeError =
    <const Tag extends string, Schema extends Schema.Top>(tag: Tag, schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(schema)(response),
        (cause) => Effect.fail(TestClientError(tag, cause, response)),
      )
  return {
    httpClient,
    "getUser": (id, options) => HttpClientRequest.get(\`/users/\${id}\`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetUser200),
      orElse: unexpectedStatus
    }))
  )
  }
}

export interface TestClient {
  readonly httpClient: HttpClient.HttpClient
  readonly "getUser": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
}

export interface TestClientError<Tag extends string, E> {
  readonly _tag: Tag
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly cause: E
}

class TestClientErrorImpl extends Data.Error<{
  _tag: string
  cause: any
  request: HttpClientRequest.HttpClientRequest
  response: HttpClientResponse.HttpClientResponse
}> {}

export const TestClientError = <Tag extends string, E>(
  tag: Tag,
  cause: E,
  response: HttpClientResponse.HttpClientResponse,
): TestClientError<Tag, E> =>
  new TestClientErrorImpl({
    _tag: tag,
    cause,
    response,
    request: response.request,
  }) as any`
      ))

    it.effect("sse operation decodes event payload from json string", () =>
      assertRuntimeIncludes(
        {
          openapi: "3.1.0",
          info: {
            title: "Test API",
            version: "1.0.0"
          },
          paths: {
            "/events": {
              get: {
                operationId: "streamEvents",
                parameters: [],
                responses: {
                  200: {
                    description: "Events streamed successfully",
                    content: {
                      "text/event-stream": {
                        schema: {
                          type: "object",
                          properties: {
                            type: {
                              type: "string"
                            },
                            value: {
                              type: "string"
                            }
                          },
                          required: ["type", "value"],
                          additionalProperties: false
                        }
                      }
                    }
                  }
                },
                tags: ["Events"],
                security: []
              }
            }
          },
          components: {
            schemas: {},
            securitySchemes: {}
          },
          security: [],
          tags: []
        },
        [
          `import * as Sse from "effect/unstable/encoding/Sse"`,
          `readonly "streamEventsSse": () => Stream.Stream<{ readonly event: string; readonly id: string | undefined; readonly data: typeof StreamEvents200Sse.Type }, HttpClientError.HttpClientError | SchemaError | Sse.Retry, typeof StreamEvents200Sse.DecodingServices>`,
          `"streamEventsSse": () => HttpClientRequest.get(\`/events\`).pipe(`,
          `sseRequest(StreamEvents200Sse)`
        ]
      ))

    it.effect("form-urlencoded request body generates bodyUrlParams", () =>
      assertRuntimeIncludes(
        {
          openapi: "3.1.0",
          info: {
            title: "Test API",
            version: "1.0.0"
          },
          paths: {
            "/auth/token": {
              post: {
                operationId: "issueToken",
                parameters: [],
                requestBody: {
                  required: true,
                  content: {
                    "application/x-www-form-urlencoded": {
                      schema: {
                        type: "object",
                        properties: {
                          grant_type: { type: "string" },
                          client_id: { type: "string" }
                        },
                        required: ["grant_type", "client_id"],
                        additionalProperties: false
                      }
                    }
                  }
                } as any,
                responses: {
                  200: {
                    description: "Token response",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            access_token: { type: "string" }
                          },
                          required: ["access_token"],
                          additionalProperties: false
                        }
                      }
                    }
                  }
                },
                tags: ["Auth"],
                security: []
              }
            }
          },
          components: {
            schemas: {},
            securitySchemes: {}
          },
          security: [],
          tags: []
        },
        [
          `HttpClientRequest.bodyUrlParams(options.payload as any)`,
          `readonly payload: typeof IssueTokenRequestFormUrlEncoded.Encoded`
        ]
      ))
  })

  describe("type-only", () => {
    it.effect("get operation", () =>
      assertTypeOnly(
        {
          openapi: "3.1.0",
          info: {
            title: "Test API",
            version: "1.0.0"
          },
          paths: {
            "/users/{id}": {
              get: {
                operationId: "getUser",
                parameters: [
                  {
                    name: "id",
                    in: "path",
                    schema: {
                      type: "string"
                    },
                    required: true
                  }
                ],
                responses: {
                  200: {
                    description: "User retrieved successfully",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            id: {
                              type: "string"
                            },
                            name: {
                              type: "string"
                            }
                          },
                          required: ["id", "name"],
                          additionalProperties: false
                        }
                      }
                    }
                  }
                },
                tags: ["Users"],
                security: []
              }
            }
          },
          components: {
            schemas: {},
            securitySchemes: {}
          },
          security: [],
          tags: []
        },
        `import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
// schemas
export type GetUser200 = { readonly "id": string, readonly "name": string }

export interface OperationConfig {
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
): TestClient => {
  const unexpectedStatus = (response: HttpClientResponse.HttpClientResponse) =>
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
  }
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
      TestClientError<Tag, E> | HttpClientError.HttpClientError
    > =>
      Effect.flatMap(
        response.json as Effect.Effect<E, HttpClientError.HttpClientError>,
        (cause) => Effect.fail(TestClientError(tag, cause, response)),
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
    "getUser": (id, options) => HttpClientRequest.get(\`/users/\${id}\`).pipe(
    onRequest(options?.config)(["2xx"])
  )
  }
}

export interface TestClient {
  readonly httpClient: HttpClient.HttpClient
  readonly "getUser": <Config extends OperationConfig>(id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<GetUser200, Config>, HttpClientError.HttpClientError>
}

export interface TestClientError<Tag extends string, E> {
  readonly _tag: Tag
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly cause: E
}

class TestClientErrorImpl extends Data.Error<{
  _tag: string
  cause: any
  request: HttpClientRequest.HttpClientRequest
  response: HttpClientResponse.HttpClientResponse
}> {}

export const TestClientError = <Tag extends string, E>(
  tag: Tag,
  cause: E,
  response: HttpClientResponse.HttpClientResponse,
): TestClientError<Tag, E> =>
  new TestClientErrorImpl({
    _tag: tag,
    cause,
    response,
    request: response.request,
  }) as any`
      ))
  })

  describe("httpapi", () => {
    it.effect("generates tagged groups with endpoint annotations and representable parameters", () =>
      assertHttpApiIncludes(
        {
          openapi: "3.1.0",
          info: {
            title: "Test API",
            version: "1.0.0",
            summary: "Summary",
            description: "Description"
          },
          paths: {
            "/users/{id}": {
              get: {
                operationId: "getUser",
                summary: "Get user",
                description: "Read a user",
                deprecated: true,
                externalDocs: {
                  url: "https://example.com/get-user"
                },
                parameters: [
                  {
                    name: "id",
                    in: "path",
                    schema: { type: "string" },
                    required: true
                  },
                  {
                    name: "filter",
                    in: "query",
                    schema: { type: "string" },
                    required: false
                  },
                  {
                    name: "trace-id",
                    in: "header",
                    schema: { type: "string" },
                    required: false
                  }
                ],
                responses: {
                  200: {
                    description: "User",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            id: { type: "string" }
                          },
                          required: ["id"],
                          additionalProperties: false
                        }
                      }
                    }
                  },
                  404: {
                    description: "Not found"
                  }
                },
                tags: ["Users"],
                security: []
              }
            }
          },
          components: {
            schemas: {},
            securitySchemes: {}
          },
          security: [],
          tags: [
            {
              name: "Users",
              description: "User operations",
              externalDocs: {
                url: "https://example.com/users"
              }
            }
          ]
        },
        [
          `import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity, OpenApi } from "effect/unstable/httpapi"`,
          `export type GetUserPathParams = { readonly "id": string }`,
          `export const GetUserPathParams = Schema.Struct({ "id": Schema.String })`,
          `class UsersGroup extends HttpApiGroup.make("Users")`,
          `.annotate(OpenApi.Description, "User operations")`,
          `.annotate(OpenApi.ExternalDocs, {"url":"https://example.com/users"})`,
          `HttpApiEndpoint.get("getUser", "/users/:id", { params: GetUserPathParams, query: GetUserQuery, headers: GetUserHeaders, success: GetUser200, error: HttpApiSchema.Empty(404) })`,
          `.annotate(OpenApi.Identifier, "getUser")`,
          `.annotate(OpenApi.Summary, "Get user")`,
          `.annotate(OpenApi.Description, "Read a user")`,
          `.annotate(OpenApi.Deprecated, true)`,
          `.annotate(OpenApi.ExternalDocs, {"url":"https://example.com/get-user"})`,
          `export class TestClient extends HttpApi.make("TestClient")`,
          `.annotate(OpenApi.Title, "Test API")`,
          `.annotate(OpenApi.Version, "1.0.0")`,
          `.annotate(OpenApi.Summary, "Summary")`,
          `.annotate(OpenApi.Description, "Description")`,
          `.add(UsersGroup)`
        ],
        [
          `export class GetUserPathParams extends Schema.Class<GetUserPathParams>("GetUserPathParams")({ "id": Schema.String }) {}`
        ]
      ))

    it.effect("includes path-level parameters in generated httpapi endpoints", () =>
      assertHttpApiIncludes(
        {
          openapi: "3.1.0",
          info: {
            title: "Discord-style API",
            version: "1.0.0"
          },
          paths: {
            "/applications/{application_id}": {
              parameters: [
                {
                  name: "application_id",
                  in: "path",
                  schema: { type: "string" },
                  required: true
                }
              ],
              get: {
                operationId: "getApplication",
                parameters: [],
                responses: {
                  200: {
                    description: "Application"
                  }
                },
                tags: ["Applications"],
                security: []
              }
            } as any
          },
          components: {
            schemas: {},
            securitySchemes: {}
          },
          security: [],
          tags: [{ name: "Applications" }]
        },
        [
          `export type GetApplicationPathParams = { readonly "application_id": string }`,
          `export const GetApplicationPathParams = Schema.Struct({ "application_id": Schema.String })`,
          `HttpApiEndpoint.get("getApplication", "/applications/:application_id", { params: GetApplicationPathParams, success: HttpApiSchema.Empty(200) })`
        ],
        [
          `export class GetApplicationPathParams extends Schema.Class<GetApplicationPathParams>("GetApplicationPathParams")({ "application_id": Schema.String }) {}`
        ]
      ))

    it.effect("creates top-level fallback group for untagged operations", () =>
      assertHttpApiIncludes(
        {
          openapi: "3.1.0",
          info: {
            title: "Test API",
            version: "1.0.0"
          },
          paths: {
            "/health": {
              get: {
                operationId: "getHealth",
                parameters: [],
                responses: {
                  204: {
                    description: "No content"
                  }
                },
                tags: [] as any,
                security: []
              }
            }
          },
          components: {
            schemas: {},
            securitySchemes: {}
          },
          security: [],
          tags: []
        },
        [
          `class DefaultGroup extends HttpApiGroup.make("default", { topLevel: true })`,
          `HttpApiEndpoint.get("getHealth", "/health", { success: HttpApiSchema.Empty(204) })`,
          `.add(DefaultGroup)`
        ]
      ))

    it.effect("keeps the fallback group top-level when tagged default operations are present", () =>
      assertHttpApiIncludes(
        {
          openapi: "3.1.0",
          info: {
            title: "Test API",
            version: "1.0.0"
          },
          paths: {
            "/tagged": {
              get: {
                operationId: "getTagged",
                parameters: [],
                responses: {
                  200: {
                    description: "Tagged"
                  }
                },
                tags: ["default"],
                security: []
              }
            },
            "/untagged": {
              get: {
                operationId: "getUntagged",
                parameters: [],
                responses: {
                  204: {
                    description: "Untagged"
                  }
                },
                tags: [] as any,
                security: []
              }
            }
          },
          components: {
            schemas: {},
            securitySchemes: {}
          },
          security: [],
          tags: []
        },
        [
          `class DefaultGroup extends HttpApiGroup.make("default", { topLevel: true })`,
          `HttpApiEndpoint.get("getTagged", "/tagged", { success: HttpApiSchema.Empty(200) })`,
          `HttpApiEndpoint.get("getUntagged", "/untagged", { success: HttpApiSchema.Empty(204) })`,
          `.add(DefaultGroup)`
        ]
      ))

    it.effect("maps request and response encodings including optional request body approximation", () =>
      assertHttpApiIncludes(
        {
          openapi: "3.1.0",
          info: {
            title: "Test API",
            version: "1.0.0"
          },
          paths: {
            "/payload": {
              post: {
                operationId: "createPayload",
                parameters: [],
                requestBody: {
                  required: false,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          a: { type: "string" }
                        },
                        required: ["a"],
                        additionalProperties: false
                      }
                    },
                    "multipart/form-data": {
                      schema: {
                        type: "object",
                        properties: {
                          file: { type: "string", format: "binary" },
                          files: {
                            type: "array",
                            items: { type: "string", format: "binary" }
                          }
                        },
                        required: ["file", "files"],
                        additionalProperties: false
                      }
                    },
                    "application/x-www-form-urlencoded": {
                      schema: {
                        type: "object",
                        properties: {
                          form: { type: "string" }
                        },
                        required: ["form"],
                        additionalProperties: false
                      }
                    },
                    "text/plain": {
                      schema: {
                        type: "string"
                      }
                    },
                    "application/octet-stream": {
                      schema: {
                        type: "string",
                        format: "binary"
                      }
                    }
                  }
                } as any,
                responses: {
                  200: {
                    description: "Payload",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            ok: { type: "boolean" }
                          },
                          required: ["ok"],
                          additionalProperties: false
                        }
                      },
                      "text/plain": {
                        schema: {
                          type: "string"
                        }
                      },
                      "application/octet-stream": {
                        schema: {
                          type: "string",
                          format: "binary"
                        }
                      }
                    }
                  },
                  201: {
                    description: "Created"
                  }
                },
                tags: ["Payload"],
                security: []
              }
            }
          },
          components: {
            schemas: {},
            securitySchemes: {}
          },
          security: [],
          tags: [{ name: "Payload" }]
        },
        [
          `import { Multipart } from "effect/unstable/http"`,
          `export type __HttpApiMultipartSingleFile = Multipart.PersistedFile
export const __HttpApiMultipartSingleFile = Multipart.SingleFileSchema`,
          `export type __HttpApiMultipartFiles = ReadonlyArray<Multipart.PersistedFile>
export const __HttpApiMultipartFiles = Multipart.FilesSchema`,
          `export type CreatePayloadRequestFormData = { readonly "file": __HttpApiMultipartSingleFile, readonly "files": __HttpApiMultipartFiles }`,
          `export const CreatePayloadRequestFormData = Schema.Struct({ "file": __HttpApiMultipartSingleFile, "files": __HttpApiMultipartFiles })`,
          `export type CreatePayloadRequestJson = { readonly "a": string }`,
          `export type CreatePayloadRequestText = string
export const CreatePayloadRequestText = Schema.String`,
          `payload: [HttpApiSchema.NoContent, CreatePayloadRequestJson, CreatePayloadRequestFormData.pipe(HttpApiSchema.asMultipart()), CreatePayloadRequestFormUrlEncoded.pipe(HttpApiSchema.asFormUrlEncoded()), CreatePayloadRequestText.pipe(HttpApiSchema.asText()), CreatePayloadRequestBinary.pipe(HttpApiSchema.asUint8Array())]`,
          `success: [CreatePayload200, CreatePayload200Text.pipe(HttpApiSchema.asText()), CreatePayload200Binary.pipe(HttpApiSchema.asUint8Array()), HttpApiSchema.Empty(201)]`
        ],
        [
          "Schema.Opaque",
          `extends Schema.Class<CreatePayloadRequestJson>("CreatePayloadRequestJson")`
        ]
      ))

    it.effect("maps multipart schemas referenced through components to Multipart file schemas", () =>
      assertHttpApiIncludes(
        {
          openapi: "3.1.0",
          info: {
            title: "Test API",
            version: "1.0.0"
          },
          paths: {
            "/upload": {
              post: {
                operationId: "upload",
                parameters: [],
                requestBody: {
                  required: true,
                  content: {
                    "multipart/form-data": {
                      schema: {
                        $ref: "#/components/schemas/UploadBody"
                      }
                    }
                  }
                } as any,
                responses: {
                  200: {
                    description: "Uploaded"
                  }
                },
                tags: ["Payload"],
                security: []
              }
            }
          },
          components: {
            schemas: {
              UploadBody: {
                type: "object",
                properties: {
                  file: { type: "string", format: "binary" },
                  files: {
                    type: "array",
                    items: { type: "string", format: "binary" }
                  }
                },
                required: ["file", "files"],
                additionalProperties: false
              }
            },
            securitySchemes: {}
          },
          security: [],
          tags: [{ name: "Payload" }]
        },
        [
          `import { Multipart } from "effect/unstable/http"`,
          `export type __HttpApiMultipartSingleFile = Multipart.PersistedFile
export const __HttpApiMultipartSingleFile = Multipart.SingleFileSchema`,
          `export type __HttpApiMultipartFiles = ReadonlyArray<Multipart.PersistedFile>
export const __HttpApiMultipartFiles = Multipart.FilesSchema`,
          `export type UploadRequestFormData = { readonly "file": __HttpApiMultipartSingleFile, readonly "files": __HttpApiMultipartFiles }`,
          `export const UploadRequestFormData = Schema.Struct({ "file": __HttpApiMultipartSingleFile, "files": __HttpApiMultipartFiles })`,
          `HttpApiEndpoint.post("upload", "/upload", { payload: UploadRequestFormData.pipe(HttpApiSchema.asMultipart()), success: HttpApiSchema.Empty(200) })`
        ],
        [
          `Schema.String.annotate({ "format": "binary" })`,
          `export type UploadBody =`
        ]
      ))

    it.effect("maps multipart contentEncoding binary schemas (case-insensitive) to Multipart file schemas", () =>
      assertHttpApiIncludes(
        {
          openapi: "3.1.0",
          info: {
            title: "Test API",
            version: "1.0.0"
          },
          paths: {
            "/upload-content-encoding": {
              post: {
                operationId: "uploadWithContentEncoding",
                parameters: [],
                requestBody: {
                  required: true,
                  content: {
                    "multipart/form-data": {
                      schema: {
                        $ref: "#/components/schemas/UploadBodyContentEncoding"
                      }
                    }
                  }
                } as any,
                responses: {
                  200: {
                    description: "Uploaded"
                  }
                },
                tags: ["Payload"],
                security: []
              }
            }
          },
          components: {
            schemas: {
              UploadBodyContentEncoding: {
                type: "object",
                properties: {
                  file: { type: "string", contentEncoding: "BINARY" },
                  files: {
                    type: "array",
                    items: { type: "string", contentEncoding: "BINARY" }
                  }
                },
                required: ["file", "files"],
                additionalProperties: false
              }
            },
            securitySchemes: {}
          },
          security: [],
          tags: [{ name: "Payload" }]
        },
        [
          `import { Multipart } from "effect/unstable/http"`,
          `export type UploadWithContentEncodingRequestFormData = { readonly "file": __HttpApiMultipartSingleFile, readonly "files": __HttpApiMultipartFiles }`,
          `export const UploadWithContentEncodingRequestFormData = Schema.Struct({ "file": __HttpApiMultipartSingleFile, "files": __HttpApiMultipartFiles })`,
          `HttpApiEndpoint.post("uploadWithContentEncoding", "/upload-content-encoding", { payload: UploadWithContentEncodingRequestFormData.pipe(HttpApiSchema.asMultipart()), success: HttpApiSchema.Empty(200) })`
        ],
        [
          `contentEncoding`,
          `export type UploadBodyContentEncoding =`
        ]
      ))

    it.effect("generates security declarations and middleware placeholders", () =>
      assertHttpApiWithWarnings(
        {
          openapi: "3.1.0",
          info: {
            title: "Security API",
            version: "1.0.0"
          },
          paths: {
            "/secure": {
              get: {
                operationId: "getSecure",
                parameters: [],
                responses: {
                  200: {
                    description: "Secure"
                  }
                },
                tags: ["Security"],
                security: [
                  { apiKeyAuth: [] },
                  { bearerAuth: [] },
                  { apiKeyAuth: [], basicAuth: [] }
                ]
              }
            },
            "/public": {
              get: {
                operationId: "getPublic",
                parameters: [],
                responses: {
                  200: {
                    description: "Public"
                  }
                },
                tags: ["Security"],
                security: []
              }
            }
          },
          components: {
            schemas: {},
            securitySchemes: {
              apiKeyAuth: {
                type: "apiKey",
                name: "x-api-key",
                in: "header",
                description: "API key"
              },
              bearerAuth: {
                type: "http",
                scheme: "bearer",
                bearerFormat: "JWT",
                description: "Bearer token"
              },
              basicAuth: {
                type: "http",
                scheme: "basic"
              }
            }
          },
          security: [],
          tags: [{ name: "Security" }]
        },
        {
          includes: [
            `const ApiKeyAuthSecurity = HttpApiSecurity.apiKey({ key: "x-api-key", in: "header" }).pipe(HttpApiSecurity.annotate(OpenApi.Description, "API key"))`,
            `const BearerAuthSecurity = HttpApiSecurity.bearer.pipe(HttpApiSecurity.annotate(OpenApi.Description, "Bearer token")).pipe(HttpApiSecurity.annotate(OpenApi.Format, "JWT"))`,
            `const BasicAuthSecurity = HttpApiSecurity.basic`,
            `class ApiKeyAuthOrBearerAuthSecurityMiddleware extends HttpApiMiddleware.Service<ApiKeyAuthOrBearerAuthSecurityMiddleware>()("apiKeyAuth | bearerAuth security", { security: { "apiKeyAuth": ApiKeyAuthSecurity, "bearerAuth": BearerAuthSecurity } }) {}`,
            `class ApiKeyAuthAndBasicAuthSecurityMiddleware extends HttpApiMiddleware.Service<ApiKeyAuthAndBasicAuthSecurityMiddleware>()("apiKeyAuth & basicAuth security") {}`,
            `HttpApiEndpoint.get("getSecure", "/secure", { success: HttpApiSchema.Empty(200) })\n      .middleware(ApiKeyAuthOrBearerAuthSecurityMiddleware)\n      .middleware(ApiKeyAuthAndBasicAuthSecurityMiddleware)`,
            `HttpApiEndpoint.get("getPublic", "/public", { success: HttpApiSchema.Empty(200) })`
          ],
          excludes: [
            `HttpApiEndpoint.get("getPublic", "/public", { success: HttpApiSchema.Empty(200) })\n      .middleware(`
          ],
          warnings: [
            {
              code: "security-and-downgraded",
              path: "/secure",
              method: "get",
              operationId: "getSecure"
            }
          ]
        }
      ))

    it.effect("generates custom http security schemes", () =>
      assertHttpApiWithWarnings(
        {
          openapi: "3.1.0",
          info: {
            title: "Custom Security API",
            version: "1.0.0"
          },
          paths: {
            "/secure": {
              get: {
                operationId: "getSecure",
                parameters: [],
                responses: {
                  200: {
                    description: "Secure"
                  }
                },
                tags: ["Security"],
                security: [{ digestAuth: [] }]
              }
            }
          },
          components: {
            schemas: {},
            securitySchemes: {
              digestAuth: {
                type: "http",
                scheme: "Digest",
                bearerFormat: "DigestToken",
                description: "Digest token"
              }
            }
          },
          security: [],
          tags: [{ name: "Security" }]
        },
        {
          includes: [
            `const DigestAuthSecurity = HttpApiSecurity.http({ scheme: "Digest" }).pipe(HttpApiSecurity.annotate(OpenApi.Description, "Digest token")).pipe(HttpApiSecurity.annotate(OpenApi.Format, "DigestToken"))`,
            `class DigestAuthSecurityMiddleware extends HttpApiMiddleware.Service<DigestAuthSecurityMiddleware>()("digestAuth security", { security: { "digestAuth": DigestAuthSecurity } }) {}`
          ],
          warnings: []
        }
      ))

    it.effect("inherits global security and respects operation-level clearing", () =>
      assertHttpApiWithWarnings(
        {
          openapi: "3.1.0",
          info: {
            title: "Security inheritance API",
            version: "1.0.0"
          },
          paths: {
            "/inherited": {
              get: {
                operationId: "getInherited",
                parameters: [],
                responses: {
                  200: {
                    description: "Inherited"
                  }
                },
                tags: ["Security"]
              } as any
            },
            "/inherited-two": {
              get: {
                operationId: "getInheritedTwo",
                parameters: [],
                responses: {
                  200: {
                    description: "Inherited two"
                  }
                },
                tags: ["Security"]
              } as any
            },
            "/cleared": {
              get: {
                operationId: "getCleared",
                parameters: [],
                responses: {
                  200: {
                    description: "Cleared"
                  }
                },
                tags: ["Security"],
                security: []
              }
            },
            "/anonymous": {
              get: {
                operationId: "getAnonymous",
                parameters: [],
                responses: {
                  200: {
                    description: "Anonymous"
                  }
                },
                tags: ["Security"],
                security: [{}]
              }
            },
            "/override": {
              get: {
                operationId: "getOverride",
                parameters: [],
                responses: {
                  200: {
                    description: "Override"
                  }
                },
                tags: ["Security"],
                security: [{ bearerAuth: [] }]
              }
            }
          },
          components: {
            schemas: {},
            securitySchemes: {
              apiKeyAuth: {
                type: "apiKey",
                name: "x-api-key",
                in: "header"
              },
              bearerAuth: {
                type: "http",
                scheme: "bearer"
              }
            }
          },
          security: [{ apiKeyAuth: [] }],
          tags: [{ name: "Security" }]
        },
        {
          includes: [
            `class ApiKeyAuthSecurityMiddleware extends HttpApiMiddleware.Service<ApiKeyAuthSecurityMiddleware>()("apiKeyAuth security", { security: { "apiKeyAuth": ApiKeyAuthSecurity } }) {}`,
            `class BearerAuthSecurityMiddleware extends HttpApiMiddleware.Service<BearerAuthSecurityMiddleware>()("bearerAuth security", { security: { "bearerAuth": BearerAuthSecurity } }) {}`,
            `HttpApiEndpoint.get("getInherited", "/inherited", { success: HttpApiSchema.Empty(200) })\n      .middleware(ApiKeyAuthSecurityMiddleware)`,
            `HttpApiEndpoint.get("getInheritedTwo", "/inherited-two", { success: HttpApiSchema.Empty(200) })\n      .middleware(ApiKeyAuthSecurityMiddleware)`,
            `HttpApiEndpoint.get("getCleared", "/cleared", { success: HttpApiSchema.Empty(200) })`,
            `HttpApiEndpoint.get("getAnonymous", "/anonymous", { success: HttpApiSchema.Empty(200) })`,
            `HttpApiEndpoint.get("getOverride", "/override", { success: HttpApiSchema.Empty(200) })\n      .middleware(BearerAuthSecurityMiddleware)`
          ],
          excludes: [
            `HttpApiEndpoint.get("getCleared", "/cleared", { success: HttpApiSchema.Empty(200) })\n      .middleware(`,
            `HttpApiEndpoint.get("getAnonymous", "/anonymous", { success: HttpApiSchema.Empty(200) })\n      .middleware(`
          ],
          occurrences: [
            {
              substring:
                `class ApiKeyAuthSecurityMiddleware extends HttpApiMiddleware.Service<ApiKeyAuthSecurityMiddleware>()("apiKeyAuth security", { security: { "apiKeyAuth": ApiKeyAuthSecurity } }) {}`,
              count: 1
            }
          ],
          warnings: []
        }
      ))

    it.effect("emits lossy warnings and skips unsupported httpapi operations", () =>
      assertHttpApiWithWarnings(
        {
          openapi: "3.1.0",
          info: {
            title: "Warnings API",
            version: "1.0.0"
          },
          paths: {
            "/cookies": {
              get: {
                operationId: "getCookie",
                parameters: [
                  {
                    name: "session",
                    in: "cookie",
                    schema: { type: "string" },
                    required: false
                  }
                ],
                responses: {
                  200: {
                    description: "Cookie"
                  }
                },
                tags: ["Warnings"],
                security: []
              }
            },
            "/tags": {
              get: {
                operationId: "getTagged",
                parameters: [],
                responses: {
                  200: {
                    description: "Tagged"
                  }
                },
                tags: ["Warnings", "ExtraTag"],
                security: []
              }
            },
            "/sse": {
              get: {
                operationId: "streamEvents",
                parameters: [],
                responses: {
                  200: {
                    description: "Events",
                    content: {
                      "text/event-stream": {
                        schema: {
                          type: "string"
                        }
                      }
                    }
                  }
                },
                tags: ["Warnings"],
                security: []
              }
            },
            "/headers": {
              get: {
                operationId: "getHeaders",
                parameters: [],
                responses: {
                  200: {
                    description: "Headers",
                    headers: {
                      "x-rate-limit": {
                        schema: {
                          type: "integer"
                        }
                      }
                    }
                  }
                } as any,
                tags: ["Warnings"],
                security: []
              }
            },
            "/default-success": {
              get: {
                operationId: "getDefaultSuccess",
                parameters: [],
                responses: {
                  200: {
                    description: "OK"
                  },
                  default: {
                    description: "Fallback"
                  }
                } as any,
                tags: ["Warnings"],
                security: []
              }
            },
            "/default-only": {
              get: {
                operationId: "getDefaultOnly",
                parameters: [],
                responses: {
                  default: {
                    description: "Fallback"
                  }
                } as any,
                tags: ["Warnings"],
                security: []
              }
            },
            "/nobody": {
              get: {
                operationId: "getNoBody",
                parameters: [],
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          a: { type: "string" }
                        },
                        required: ["a"],
                        additionalProperties: false
                      }
                    }
                  }
                },
                responses: {
                  200: {
                    description: "No body"
                  }
                },
                tags: ["Warnings"],
                security: []
              }
            }
          },
          components: {
            schemas: {},
            securitySchemes: {}
          },
          security: [],
          tags: [{ name: "Warnings" }]
        },
        {
          includes: [
            `HttpApiEndpoint.get("getCookie", "/cookies", { success: HttpApiSchema.Empty(200) })`,
            `HttpApiEndpoint.get("getHeaders", "/headers", { success: HttpApiSchema.Empty(200) })`,
            `HttpApiEndpoint.get("getDefaultSuccess", "/default-success", { success: HttpApiSchema.Empty(200), error: HttpApiSchema.Empty(500) })`,
            `HttpApiEndpoint.get("getDefaultOnly", "/default-only", { success: HttpApiSchema.Empty(200) })`
          ],
          excludes: [
            `HttpApiEndpoint.get("streamEvents", "/sse"`,
            `HttpApiEndpoint.get("getNoBody", "/nobody"`
          ],
          warnings: [
            {
              code: "cookie-parameter-dropped",
              path: "/cookies",
              method: "get",
              operationId: "getCookie"
            },
            {
              code: "additional-tags-dropped",
              path: "/tags",
              method: "get",
              operationId: "getTagged"
            },
            {
              code: "sse-operation-skipped",
              path: "/sse",
              method: "get",
              operationId: "streamEvents"
            },
            {
              code: "response-headers-ignored",
              path: "/headers",
              method: "get",
              operationId: "getHeaders"
            },
            {
              code: "default-response-remapped",
              path: "/default-success",
              method: "get",
              operationId: "getDefaultSuccess"
            },
            {
              code: "default-response-remapped",
              path: "/default-only",
              method: "get",
              operationId: "getDefaultOnly"
            },
            {
              code: "no-body-method-request-body-skipped",
              path: "/nobody",
              method: "get",
              operationId: "getNoBody"
            }
          ]
        }
      ))
  })

  describe("regression", () => {
    it.effect("runtime warnings do not report additional-tags-dropped outside httpapi", () =>
      assertRuntimeStableWithWarnings(
        {
          openapi: "3.1.0",
          info: {
            title: "Warnings regression API",
            version: "1.0.0"
          },
          paths: {
            "/multi-tag": {
              get: {
                operationId: "getMultiTag",
                parameters: [],
                responses: {
                  200: {
                    description: "OK"
                  }
                },
                tags: ["One", "Two"],
                security: []
              }
            }
          },
          components: {
            schemas: {},
            securitySchemes: {}
          },
          security: [],
          tags: [{ name: "One" }, { name: "Two" }]
        },
        []
      ))

    it.effect("runtime output remains stable when using onWarning", () =>
      assertRuntimeStableWithWarnings(regressionSpec, [
        {
          code: "cookie-parameter-dropped",
          path: "/users/{id}",
          method: "get",
          operationId: "getUser"
        },
        {
          code: "default-response-remapped",
          path: "/users/{id}",
          method: "get",
          operationId: "getUser"
        }
      ]))

    it.effect("type-only output remains stable when using onWarning", () =>
      assertTypeOnlyStableWithWarnings(regressionSpec, [
        {
          code: "cookie-parameter-dropped",
          path: "/users/{id}",
          method: "get",
          operationId: "getUser"
        },
        {
          code: "default-response-remapped",
          path: "/users/{id}",
          method: "get",
          operationId: "getUser"
        }
      ]))
  })
})
