/**
 * Type-safe HTTP clients derived from `HttpApi` declarations.
 *
 * This module turns the groups and endpoints described by an `HttpApi` into
 * callable client methods backed by an `HttpClient`. Use {@link make} or
 * {@link makeWith} to call a remote API with the same schema-driven contract as
 * the server, and use {@link group}, {@link endpoint}, or {@link urlBuilder}
 * when only part of an API or only the encoded URL is needed.
 *
 * **Mental model**
 *
 * A generated client mirrors the API structure: top-level endpoints become
 * methods on the client, and named groups become nested objects. Each call
 * encodes path parameters, query values, headers, and payloads from endpoint
 * schemas, runs client middleware, executes the request, and decodes successful
 * or declared error responses from the returned `HttpClientResponse`.
 *
 * **Common tasks**
 *
 * Use {@link make} when the `HttpClient` service should come from the Effect
 * environment. Use {@link makeWith} when a concrete or transformed client is
 * already available. Use {@link urlBuilder} to reuse endpoint path and query
 * encoding without executing a request. Select `responseMode` per call when
 * code needs the decoded value, the raw response, or both.
 *
 * **Gotchas**
 *
 * Payloads for HTTP methods without request bodies are encoded into URL
 * parameters, and multipart payloads must be supplied as `FormData`.
 * `response-only` skips success and error decoding for custom response
 * handling. Declared error responses decode into the endpoint error type;
 * unknown statuses fail as `HttpClientError.DecodeError`, and response decoding
 * can fail with `SchemaError`.
 *
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import type * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import { identity } from "../../Function.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import * as AST from "../../SchemaAST.ts"
import * as Issue from "../../SchemaIssue.ts"
import * as Transformation from "../../SchemaTransformation.ts"
import type { Simplify } from "../../Types.ts"
import * as UndefinedOr from "../../UndefinedOr.ts"
import * as HttpBody from "../http/HttpBody.ts"
import * as HttpClient from "../http/HttpClient.ts"
import * as HttpClientError from "../http/HttpClientError.ts"
import * as HttpClientRequest from "../http/HttpClientRequest.ts"
import * as HttpClientResponse from "../http/HttpClientResponse.ts"
import * as HttpMethod from "../http/HttpMethod.ts"
import * as UrlParams from "../http/UrlParams.ts"
import * as HttpApi from "./HttpApi.ts"
import * as HttpApiEndpoint from "./HttpApiEndpoint.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"
import type * as HttpApiMiddleware from "./HttpApiMiddleware.ts"
import * as HttpApiSchema from "./HttpApiSchema.ts"

/**
 * The type-safe client shape generated from HTTP API groups, with non-top-level
 * groups exposed as nested objects and top-level endpoints exposed as methods.
 *
 * @category models
 * @since 4.0.0
 */
export type Client<Groups extends HttpApiGroup.Any, E = never, R = never> = Simplify<
  & {
    readonly [Group in Extract<Groups, { readonly topLevel: false }> as HttpApiGroup.Name<Group>]: Client.Group<
      Group,
      Group["identifier"],
      E,
      R
    >
  }
  & {
    readonly [Method in Client.TopLevelMethods<Groups, E, R> as Method[0]]: Method[1]
  }
>

/**
 * Derives the typed client interface for an `HttpApi`, preserving any additional
 * client error and service requirements supplied by the caller.
 *
 * @category models
 * @since 4.0.0
 */
export type ForApi<Api extends HttpApi.Any, E = never, R = never> = Api extends
  HttpApi.HttpApi<infer _Id, infer Groups> ? Client<Groups, E, R> :
  never

/**
 * Helper types used to describe generated HTTP API clients, including endpoint
 * methods, response modes, and grouped client shapes.
 *
 * @since 4.0.0
 */
export declare namespace Client {
  /**
   * The response mode accepted by generated client methods, controlling whether a
   * call returns the decoded success value, the raw response, or both.
   *
   * @category models
   * @since 4.0.0
   */
  export type ResponseMode = HttpApiEndpoint.ClientResponseMode

  /**
   * Computes the value returned by a client method for a success type and response
   * mode.
   *
   * @category models
   * @since 4.0.0
   */
  export type Response<Success, Mode extends ResponseMode> = [Mode] extends ["decoded-and-response"]
    ? [Success, HttpClientResponse.HttpClientResponse]
    : [Mode] extends ["response-only"] ? HttpClientResponse.HttpClientResponse
    : Success

  /**
   * The client object for one API group, mapping each endpoint name in that group to
   * its typed client method.
   *
   * @category models
   * @since 4.0.0
   */
  export type Group<Groups extends HttpApiGroup.Any, GroupName extends Groups["identifier"], E, R> =
    [HttpApiGroup.WithName<Groups, GroupName>] extends [HttpApiGroup.HttpApiGroup<infer _GroupName, infer _Endpoints>] ?
      {
        readonly [Endpoint in _Endpoints as HttpApiEndpoint.Name<Endpoint>]: Method<Endpoint, E, R>
      } :
      never

  /**
   * The typed function generated for an endpoint, accepting the endpoint request
   * shape and returning an effect whose success, error, and service channels reflect
   * the endpoint schemas, middleware, and selected response mode.
   *
   * @category models
   * @since 4.0.0
   */
  export type Method<Endpoint, E, R> = [Endpoint] extends [
    HttpApiEndpoint.HttpApiEndpoint<
      infer _Name,
      infer _Method,
      infer _Path,
      infer _Params,
      infer _Query,
      infer _Payload,
      infer _Headers,
      infer _Success,
      infer _Error,
      infer _Middleware,
      infer _MR
    >
  ] ? <Mode extends ResponseMode = ResponseMode>(
      request: Simplify<HttpApiEndpoint.ClientRequest<_Params, _Query, _Payload, _Headers, Mode>>
    ) => Effect.Effect<
      Response<_Success["Type"], Mode>,
      | HttpApiMiddleware.Error<_Middleware>
      | HttpApiMiddleware.ClientError<_Middleware>
      | E
      | HttpClientError.HttpClientError
      | ([Mode] extends ["response-only"] ? never : _Error["Type"] | Schema.SchemaError),
      | R
      | _Params["EncodingServices"]
      | _Query["EncodingServices"]
      | _Payload["EncodingServices"]
      | _Headers["EncodingServices"]
      | ([Mode] extends ["response-only"] ? never : _Success["DecodingServices"] | _Error["DecodingServices"])
    > :
    never

  /**
   * Extracts client methods for endpoints in top-level groups so they can be exposed
   * directly on the generated client object.
   *
   * @category models
   * @since 4.0.0
   */
  export type TopLevelMethods<Groups extends HttpApiGroup.Any, E, R> =
    Extract<Groups, { readonly topLevel: true }> extends
      HttpApiGroup.HttpApiGroup<infer _Id, infer _Endpoints, infer _TopLevel> ?
      _Endpoints extends infer Endpoint ? [HttpApiEndpoint.Name<Endpoint>, Method<Endpoint, E, R>]
      : never :
      never
}

type UrlBuilderRequest<Endpoint extends HttpApiEndpoint.Any> = (
  & ([HttpApiEndpoint.Params<Endpoint>["Type"]] extends [never] ? {}
    : { readonly params: HttpApiEndpoint.Params<Endpoint>["Type"] })
  & ([HttpApiEndpoint.Query<Endpoint>["Type"]] extends [never] ? {}
    : { readonly query: HttpApiEndpoint.Query<Endpoint>["Type"] })
) extends infer Request ? keyof Request extends never ? void | undefined : Request
  : never

type UrlBuilderArgs<Endpoint extends HttpApiEndpoint.Any> = [UrlBuilderRequest<Endpoint>] extends [void | undefined] ?
  [request?: UrlBuilderRequest<Endpoint>]
  : [request: UrlBuilderRequest<Endpoint>]

/**
 * The type-safe URL builder shape for an HTTP API, mirroring the generated client
 * layout while returning URL strings instead of executing requests.
 *
 * @category models
 * @since 4.0.0
 */
export type UrlBuilder<Api extends HttpApi.Any> = Api extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Simplify<
    & {
      readonly [Group in Extract<Groups, { readonly topLevel: false }> as HttpApiGroup.Name<Group>]: UrlBuilderGroup<
        HttpApiGroup.Endpoints<Group>
      >
    }
    & {
      readonly [Method in UrlBuilderTopLevelMethods<Groups> as Method[0]]: Method[1]
    }
  >
  : never

type UrlBuilderGroup<Endpoints extends HttpApiEndpoint.Any> = {
  readonly [Endpoint in Endpoints as HttpApiEndpoint.Name<Endpoint>]: UrlBuilderMethod<Endpoint>
}

type UrlBuilderMethod<Endpoint extends HttpApiEndpoint.Any> = (
  ...args: UrlBuilderArgs<Endpoint>
) => string

type UrlBuilderTopLevelMethods<Groups extends HttpApiGroup.Any> = Extract<Groups, { readonly topLevel: true }> extends
  HttpApiGroup.HttpApiGroup<infer _Id, infer _Endpoints, infer _TopLevel> ?
  _Endpoints extends infer Endpoint extends HttpApiEndpoint.Any ?
    [HttpApiEndpoint.Name<Endpoint>, UrlBuilderMethod<Endpoint>]
  : never :
  never

/** @internal */
export const makeClient = <ApiId extends string, Groups extends HttpApiGroup.Any, E, R>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  options: {
    readonly httpClient: HttpClient.HttpClient.With<E, R>
    readonly predicate?: Predicate.Predicate<{
      readonly endpoint: HttpApiEndpoint.AnyWithProps
      readonly group: HttpApiGroup.AnyWithProps
    }>
    readonly onGroup?: (options: {
      readonly group: HttpApiGroup.AnyWithProps
      readonly mergedAnnotations: Context.Context<never>
    }) => void
    readonly onEndpoint: (options: {
      readonly group: HttpApiGroup.AnyWithProps
      readonly endpoint: HttpApiEndpoint.AnyWithProps
      readonly mergedAnnotations: Context.Context<never>
      readonly middleware: ReadonlySet<HttpApiMiddleware.AnyService>
      readonly successes: ReadonlyMap<number, readonly [Schema.Top, ...Array<Schema.Top>]>
      readonly errors: ReadonlyMap<number, readonly [Schema.Top, ...Array<Schema.Top>]>
      readonly endpointFn: Function
    }) => void
    readonly transformResponse?:
      | ((effect: Effect.Effect<unknown, unknown, unknown>) => Effect.Effect<unknown, unknown, unknown>)
      | undefined
    readonly baseUrl?: URL | string | undefined
  }
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const services = yield* Effect.context()

    const httpClient = options.httpClient.pipe(
      options?.baseUrl === undefined
        ? identity
        : HttpClient.mapRequest(
          HttpClientRequest.prependUrl(options.baseUrl.toString())
        )
    )

    function executeMiddleware(
      group: HttpApiGroup.AnyWithProps,
      endpoint: HttpApiEndpoint.AnyWithProps,
      request: HttpClientRequest.HttpClientRequest,
      middlewareKeys: ReadonlyArray<string>,
      index: number
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> {
      if (index === -1) {
        return httpClient.execute(request) as unknown as Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          HttpClientError.HttpClientError
        >
      }
      const middleware = services.mapUnsafe.get(middlewareKeys[index]) as
        | HttpApiMiddleware.HttpApiMiddlewareClient<any, any, any>
        | undefined
      if (middleware === undefined) {
        return executeMiddleware(group, endpoint, request, middlewareKeys, index - 1)
      }
      return middleware({
        endpoint,
        group,
        request,
        next(request) {
          return executeMiddleware(group, endpoint, request, middlewareKeys, index - 1)
        }
      }) as Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
    }

    HttpApi.reflect(api, {
      predicate: options?.predicate,
      onGroup(onGroupOptions) {
        options.onGroup?.(onGroupOptions)
      },
      onEndpoint(onEndpointOptions) {
        const { group, endpoint, errors, successes } = onEndpointOptions
        const makeUrl = compilePath(endpoint.path)
        const decodeMap: Record<
          number | "orElse",
          (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<unknown, unknown, unknown>
        > = { orElse: statusOrElse }
        const decodeResponse = HttpClientResponse.matchStatus(decodeMap)
        errors.forEach((schemas, status) => {
          // decoders
          const decode = schemasToResponse(schemas)
          decodeMap[status] = (response) =>
            Effect.flatMap(
              Effect.catchCause(decode(response), (cause) =>
                Effect.failCause(Cause.combine(
                  Cause.fail(
                    new HttpClientError.HttpClientError({
                      reason: new HttpClientError.StatusCodeError({
                        request: response.request,
                        response
                      })
                    })
                  ),
                  cause
                ))),
              Effect.fail
            )
        })
        successes.forEach((schemas, status) => {
          decodeMap[status] = schemasToResponse(schemas)
        })

        // encoders
        const encodeParams = UndefinedOr.map(endpoint.params, Schema.encodeUnknownEffect)

        const payloadSchemas = HttpApiEndpoint.getPayloadSchemas(endpoint)
        const encodePayload = Arr.isArrayNonEmpty(payloadSchemas) ?
          HttpMethod.hasBody(endpoint.method)
            ? Schema.encodeUnknownEffect(getEncodePayloadSchema(payloadSchemas, endpoint.method))
            : Schema.encodeUnknownEffect(Schema.Union(payloadSchemas)) :
          undefined

        const encodeHeaders = UndefinedOr.map(endpoint.headers, Schema.encodeUnknownEffect)
        const encodeQuery = UndefinedOr.map(endpoint.query, Schema.encodeUnknownEffect)

        const middlewareKeys = Array.from(onEndpointOptions.middleware, (tag) => `${tag.key}/Client`)

        const endpointFn = Effect.fnUntraced(function*(
          request: {
            readonly params: Record<string, string> | undefined
            readonly query: unknown
            readonly payload: unknown
            readonly headers: Record<string, string> | undefined
            readonly responseMode?: HttpApiEndpoint.ClientResponseMode
          } | undefined
        ) {
          let httpRequest = HttpClientRequest.make(endpoint.method)(endpoint.path)

          if (request !== undefined) {
            // params
            if (encodeParams !== undefined) {
              const params = (yield* encodeParams(request.params)) as Record<string, string>
              httpRequest = HttpClientRequest.setUrl(httpRequest, makeUrl(params))
            }

            // payload
            if (encodePayload !== undefined) {
              if (HttpMethod.hasBody(endpoint.method)) {
                if (request.payload instanceof FormData) {
                  httpRequest = HttpClientRequest.bodyFormData(httpRequest, request.payload)
                } else {
                  const body = (yield* encodePayload(request.payload)) as HttpBody.HttpBody
                  httpRequest = HttpClientRequest.setBody(httpRequest, body)
                }
              } else {
                const urlParams = (yield* encodePayload(request.payload)) as Record<string, string>
                httpRequest = HttpClientRequest.appendUrlParams(httpRequest, urlParams)
              }
            }

            // headers
            if (encodeHeaders !== undefined) {
              const headers = (yield* encodeHeaders(request.headers)) as Record<string, string>
              httpRequest = HttpClientRequest.setHeaders(httpRequest, headers)
            }

            // query
            if (encodeQuery !== undefined) {
              const query = (yield* encodeQuery(request.query)) as Record<string, string>
              httpRequest = HttpClientRequest.appendUrlParams(httpRequest, query)
            }
          }

          const response = yield* executeMiddleware(
            group,
            endpoint,
            httpRequest,
            middlewareKeys,
            middlewareKeys.length - 1
          )

          if (request?.responseMode === "response-only") {
            return response
          }

          const value = yield* (options.transformResponse === undefined
            ? decodeResponse(response)
            : options.transformResponse(decodeResponse(response)))

          return request?.responseMode === "decoded-and-response" ? [value, response] : value
        })

        options.onEndpoint({
          ...onEndpointOptions,
          endpointFn
        })
      }
    })
  })

/**
 * Constructs a type-safe client for an HTTP API using the `HttpClient` service,
 * endpoint schemas, middleware, and optional client or response transformations.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <ApiId extends string, Groups extends HttpApiGroup.Any>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  options?: {
    readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
    readonly transformResponse?:
      | ((effect: Effect.Effect<unknown, unknown, unknown>) => Effect.Effect<unknown, unknown, unknown>)
      | undefined
    readonly baseUrl?: URL | string | undefined
  }
): Effect.Effect<
  Client<Groups>,
  never,
  HttpClient.HttpClient | HttpApiGroup.MiddlewareClient<Groups>
> =>
  Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
    makeWith(api, {
      ...options,
      httpClient: options?.transformClient ? options.transformClient(httpClient) : httpClient
    }))

/**
 * Constructs a type-safe client for an HTTP API from the supplied `HttpClient`,
 * using the API metadata to encode requests, execute middleware, and decode
 * responses.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeWith = <ApiId extends string, Groups extends HttpApiGroup.Any, E, R>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  options: {
    readonly httpClient: HttpClient.HttpClient.With<E, R>
    readonly transformResponse?:
      | ((effect: Effect.Effect<unknown, unknown, unknown>) => Effect.Effect<unknown, unknown, unknown>)
      | undefined
    readonly baseUrl?: URL | string | undefined
  }
): Effect.Effect<Client<Groups, E, R>, never, HttpApiGroup.MiddlewareClient<Groups>> => {
  const client: Record<string, Record<string, any>> = {}
  return makeClient(api, {
    ...options,
    onGroup({ group }) {
      if (group.topLevel) return
      client[group.identifier] = {}
    },
    onEndpoint({ endpoint, endpointFn, group }) {
      ;(group.topLevel ? client : client[group.identifier])[endpoint.name] = endpointFn
    }
  }).pipe(Effect.as(client)) as any
}

/**
 * Builds a typed client object for a single API group from the supplied
 * `HttpClient`, filtering the API to that group.
 *
 * @category constructors
 * @since 4.0.0
 */
export const group = <
  ApiId extends string,
  Groups extends HttpApiGroup.Any,
  const GroupName extends HttpApiGroup.Name<Groups>,
  E,
  R
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  options: {
    readonly group: GroupName
    readonly httpClient: HttpClient.HttpClient.With<E, R>
    readonly transformResponse?:
      | ((effect: Effect.Effect<unknown, unknown, unknown>) => Effect.Effect<unknown, unknown, unknown>)
      | undefined
    readonly baseUrl?: URL | string | undefined
  }
): Effect.Effect<
  Client.Group<Groups, GroupName, E, R>,
  never,
  HttpApiGroup.MiddlewareClient<HttpApiGroup.WithName<Groups, GroupName>>
> => {
  const client: Record<string, any> = {}
  return makeClient(api, {
    ...options,
    predicate: ({ group }) => group.identifier === options.group,
    onEndpoint({ endpoint, endpointFn }) {
      client[endpoint.name] = endpointFn
    }
  }).pipe(Effect.map(() => client)) as any
}

/**
 * Builds the typed client method for one endpoint in one API group, using the
 * supplied `HttpClient` and endpoint metadata.
 *
 * @category constructors
 * @since 4.0.0
 */
export const endpoint = <
  ApiId extends string,
  Groups extends HttpApiGroup.Any,
  const GroupName extends HttpApiGroup.Name<Groups>,
  const EndpointName extends HttpApiEndpoint.Name<HttpApiGroup.EndpointsWithName<Groups, GroupName>>,
  E,
  R
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  options: {
    readonly group: GroupName
    readonly endpoint: EndpointName
    readonly httpClient: HttpClient.HttpClient.With<E, R>
    readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
    readonly transformResponse?:
      | ((effect: Effect.Effect<unknown, unknown, unknown>) => Effect.Effect<unknown, unknown, unknown>)
      | undefined
    readonly baseUrl?: URL | string | undefined
  }
): Effect.Effect<
  Client.Method<
    HttpApiEndpoint.WithName<HttpApiGroup.Endpoints<HttpApiGroup.WithName<Groups, GroupName>>, EndpointName>,
    E,
    R
  >,
  never,
  HttpApiEndpoint.MiddlewareClient<
    HttpApiEndpoint.WithName<HttpApiGroup.Endpoints<HttpApiGroup.WithName<Groups, GroupName>>, EndpointName>
  >
> => {
  let client: any = undefined
  return makeClient(api, {
    ...options,
    predicate: ({ endpoint, group }) => group.identifier === options.group && endpoint.name === options.endpoint,
    onEndpoint({ endpointFn }) {
      client = endpointFn
    }
  }).pipe(Effect.map(() => client)) as any
}

/**
 * Creates a type-safe URL builder that mirrors `HttpApiClient.make`.
 *
 * **Example** (Building typed URLs)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApi, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
 *
 * const Api = HttpApi.make("Api").add(
 *   HttpApiGroup.make("users").add(
 *     HttpApiEndpoint.get("getUser", "/users/:id", {
 *       params: { id: Schema.String }
 *     })
 *   )
 * )
 *
 * const buildUrl = HttpApiClient.urlBuilder(Api, {
 *   baseUrl: "https://api.example.com"
 * })
 *
 * buildUrl.users.getUser({
 *   params: { id: "123" }
 * })
 * //=> "https://api.example.com/users/123"
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const urlBuilder = <Api extends HttpApi.Any>(api: Api, options?: {
  readonly baseUrl?: URL | string | undefined
}): UrlBuilder<Api> => {
  const builder: Record<string, any> = {}

  HttpApi.reflect(api as unknown as HttpApi.AnyWithProps, {
    onGroup({ group }) {
      if (group.topLevel) return
      builder[group.identifier] = {}
    },
    onEndpoint({ group, endpoint }) {
      const makeUrl = compilePath(endpoint.path)
      const encodeParams = endpoint.params === undefined
        ? undefined
        : Schema.encodeSync(endpoint.params as Schema.Encoder<unknown>)
      const encodeQuery = endpoint.query === undefined
        ? undefined
        : Schema.encodeSync(endpoint.query as Schema.Encoder<unknown>)

      const endpointBuilder = (request?: {
        readonly params?: unknown
        readonly query?: unknown
      }) => {
        const params = request?.params
        const path = params === undefined
          ? endpoint.path
          : makeUrl((encodeParams === undefined ? params : encodeParams(params)) as Record<string, string | undefined>)
        const queryInput = request?.query === undefined
          ? undefined
          : (encodeQuery === undefined ? request.query : encodeQuery(request.query)) as UrlParams.Input
        const query = queryInput === undefined ? "" : UrlParams.toString(UrlParams.fromInput(queryInput))
        const url = query === "" ? path : `${path}?${query}`
        return options?.baseUrl === undefined ? url : new URL(url, options.baseUrl.toString()).toString()
      }
      ;(group.topLevel ? builder : builder[group.identifier])[endpoint.name] = endpointBuilder
    }
  })

  return builder as UrlBuilder<Api>
}

// ----------------------------------------------------------------------------

const paramsRegExp = /:(\w+)\??/g

const compilePath = (path: string) => {
  const segments = path.split(paramsRegExp)
  const len = segments.length
  if (len === 1) {
    return (_: any) => path
  }
  return (params: Record<string, string | undefined>) => {
    let url = segments[0]
    for (let i = 1; i < len; i++) {
      if (i % 2 === 0) {
        url += segments[i]
      } else {
        url += params[segments[i]]
      }
    }
    return url
  }
}

function schemasToResponse(schemas: readonly [Schema.Top, ...Array<Schema.Top>]) {
  const codec = toCodecArrayBuffer(schemas)
  const decode = Schema.decodeEffect(codec)
  return (response: HttpClientResponse.HttpClientResponse) => Effect.flatMap(response.arrayBuffer, decode)
}

const ArrayBuffer = Schema.instanceOf(globalThis.ArrayBuffer, {
  expected: "ArrayBuffer"
})

// _tag: Uint8Array
const Uint8ArrayFromArrayBuffer = ArrayBuffer.pipe(
  Schema.decodeTo(
    Schema.Uint8Array as Schema.instanceOf<Uint8Array<ArrayBuffer>>,
    Transformation.transform({
      decode(fromA) {
        return new Uint8Array(fromA)
      },
      encode(arr) {
        return arr.byteLength === arr.buffer.byteLength ?
          arr.buffer :
          arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength)
      }
    })
  )
)

// _tag: Text
const StringFromArrayBuffer = ArrayBuffer.pipe(
  Schema.decodeTo(
    Schema.String,
    Transformation.transform({
      decode(fromA) {
        return new TextDecoder().decode(fromA)
      },
      encode(toI) {
        const arr = new TextEncoder().encode(toI) as Uint8Array<ArrayBuffer>
        return arr.byteLength === arr.buffer.byteLength ?
          arr.buffer :
          arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength)
      }
    })
  )
)

// _tag: Json
const UnknownFromArrayBuffer = StringFromArrayBuffer.pipe(Schema.decodeTo(
  Schema.Union([
    // Handle No Content
    Schema.Literal("").pipe(Schema.decodeTo(
      Schema.Undefined,
      Transformation.transform({
        decode: () => undefined,
        encode: () => ""
      })
    )),
    Schema.UnknownFromJsonString
  ])
))

function toCodecArrayBuffer(schemas: readonly [Schema.Top, ...Array<Schema.Top>]): Schema.Top {
  return Schema.Union(schemas.map(onSchema))

  function onSchema(schema: Schema.Top) {
    const encoding = HttpApiSchema.getResponseEncoding(schema.ast)
    switch (encoding._tag) {
      case "Json": {
        // handle json codecs that transform void schemas to null
        const encodedIsNull = AST.isNull(AST.toEncoded(schema.ast))
        return UnknownFromArrayBuffer.pipe(Schema.decodeTo(
          schema,
          encodedIsNull ?
            Transformation.transform({
              decode: (a) => a === undefined ? null : a,
              encode: (a) => a === null ? undefined : a
            }) as any :
            undefined
        ))
      }
      case "FormUrlEncoded":
        return StringFromArrayBuffer.pipe(
          Schema.decodeTo(UrlParams.schemaRecord),
          Schema.decodeTo(schema)
        )
      case "Uint8Array":
        return Uint8ArrayFromArrayBuffer.pipe(Schema.decodeTo(schema))
      case "Text":
        return StringFromArrayBuffer.pipe(Schema.decodeTo(schema))
    }
  }
}

const statusOrElse = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.DecodeError({
        request: response.request,
        response
      })
    })
  )

const $HttpBody = Schema.declare(HttpBody.isHttpBody)

function getEncodePayloadSchema(
  schemas: readonly [Schema.Top, ...Array<Schema.Top>],
  method: HttpMethod.HttpMethod
): Schema.Top {
  return Schema.Union(schemas.map((s) => getEncodePayloadSchemaFromBody(s, method)))
}

const bodyFromPayloadCache = new WeakMap<AST.AST, Schema.Top>()

function getEncodePayloadSchemaFromBody(
  schema: Schema.Top,
  method: HttpMethod.HttpMethod
): Schema.Top {
  const ast = schema.ast
  const cached = bodyFromPayloadCache.get(ast)
  if (cached !== undefined) {
    return cached
  }
  const encoding = HttpApiSchema.getPayloadEncoding(ast, method)
  const out = $HttpBody.pipe(Schema.decodeTo(
    schema,
    Transformation.transformOrFail<unknown, HttpBody.HttpBody>({
      decode(httpBody) {
        return Effect.fail(new Issue.Forbidden(Option.some(httpBody), { message: "Encode only schema" }))
      },
      encode(t) {
        switch (encoding._tag) {
          case "Multipart":
            return Effect.fail(new Issue.Forbidden(Option.some(t), { message: "Payload must be a FormData" }))
          case "Json": {
            try {
              const body = JSON.stringify(t)
              return Effect.succeed(HttpBody.text(body, encoding.contentType))
            } catch (error) {
              return Effect.fail(new Issue.InvalidValue(Option.some(t), { message: globalThis.String(error) }))
            }
          }
          case "Text": {
            if (typeof t !== "string") {
              return Effect.fail(
                new Issue.InvalidValue(Option.some(t), { message: "Expected a string" })
              )
            }
            return Effect.succeed(HttpBody.text(t, encoding.contentType))
          }
          case "FormUrlEncoded": {
            if (!Predicate.isObject(t)) {
              return Effect.fail(new Issue.InvalidValue(Option.some(t), { message: "Expected a record" }))
            }
            return Effect.succeed(HttpBody.urlParams(UrlParams.fromInput(t as any)))
          }
          case "Uint8Array": {
            if (!(t instanceof Uint8Array)) {
              return Effect.fail(
                new Issue.InvalidValue(Option.some(t), { message: "Expected a Uint8Array" })
              )
            }
            return Effect.succeed(HttpBody.uint8Array(t, encoding.contentType))
          }
        }
      }
    })
  ))
  bodyFromPayloadCache.set(ast, out)
  return out
}
