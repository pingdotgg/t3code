/**
 * Server builders for declarative `HttpApi` contracts.
 *
 * This module is the server-side bridge between an `HttpApi` description and an
 * `HttpRouter`. It turns endpoint metadata into routes, decodes incoming
 * request parts with `Schema`, runs HTTP API middleware, invokes the registered
 * handlers, and encodes successes or declared errors back into
 * `HttpServerResponse` values.
 *
 * **Mental model**
 *
 * `HttpApi` values describe what can be served; this module supplies how it is
 * served. Implement each group with {@link group}, then register the completed
 * API with {@link layer}. The layer reads the group implementations from the
 * Effect context, adds their routes to the active `HttpRouter`, and can also
 * expose the generated OpenAPI document.
 *
 * **Common tasks**
 *
 * Use {@link group} with `handlers.handle` to implement every endpoint in one
 * API group. Use `handlers.handleRaw` when the handler needs direct access to
 * the `HttpServerRequest` or must decode the payload manually. Use
 * {@link endpoint} when composing one endpoint route by hand, and use
 * {@link securityDecode} or {@link securitySetCookie} inside security-aware
 * middleware.
 *
 * **Gotchas**
 *
 * Every group in the API must have a matching {@link group} layer before
 * {@link layer} is evaluated; otherwise registration fails with a defect naming
 * the missing group service. Payload decoding is selected from the request
 * media type, so unsupported content types return `415` before the handler
 * runs. Request decoding failures are wrapped in `HttpApiSchemaError`; handler
 * failures are encoded only when they match the endpoint or middleware error
 * schemas.
 *
 * **See also**
 *
 * `HttpApi` for the top-level contract, `HttpApiGroup` and `HttpApiEndpoint`
 * for declaration, `HttpApiMiddleware` for server and client middleware, and
 * `OpenApi` for generated specifications.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Encoding from "../../Encoding.ts"
import * as Fiber from "../../Fiber.ts"
import type { FileSystem } from "../../FileSystem.ts"
import { identity } from "../../Function.ts"
import { stringOrRedacted } from "../../internal/redacted.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import type { Path } from "../../Path.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import * as Redacted from "../../Redacted.ts"
import * as Result from "../../Result.ts"
import * as Schema from "../../Schema.ts"
import * as AST from "../../SchemaAST.ts"
import * as Issue from "../../SchemaIssue.ts"
import * as Transformation from "../../SchemaTransformation.ts"
import * as Scope from "../../Scope.ts"
import * as Stream from "../../Stream.ts"
import type { Covariant, NoInfer } from "../../Types.ts"
import * as UndefinedOr from "../../UndefinedOr.ts"
import type { Cookie } from "../http/Cookies.ts"
import type * as Etag from "../http/Etag.ts"
import * as HttpEffect from "../http/HttpEffect.ts"
import * as HttpMethod from "../http/HttpMethod.ts"
import type { HttpPlatform } from "../http/HttpPlatform.ts"
import * as HttpRouter from "../http/HttpRouter.ts"
import * as Request from "../http/HttpServerRequest.ts"
import { HttpServerRequest } from "../http/HttpServerRequest.ts"
import * as Response from "../http/HttpServerResponse.ts"
import type { HttpServerResponse } from "../http/HttpServerResponse.ts"
import * as Multipart from "../http/Multipart.ts"
import * as UrlParams from "../http/UrlParams.ts"
import type * as HttpApi from "./HttpApi.ts"
import * as HttpApiEndpoint from "./HttpApiEndpoint.ts"
import { HttpApiSchemaError } from "./HttpApiError.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"
import * as HttpApiMiddleware from "./HttpApiMiddleware.ts"
import * as HttpApiSchema from "./HttpApiSchema.ts"
import type * as HttpApiSecurity from "./HttpApiSecurity.ts"
import * as OpenApi from "./OpenApi.ts"

/**
 * Registers an `HttpApi` with a `HttpRouter`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const layer = <Id extends string, Groups extends HttpApiGroup.Any>(
  api: HttpApi.HttpApi<Id, Groups>,
  options?: {
    readonly openapiPath?: `/${string}` | undefined
  }
): Layer.Layer<
  never,
  never,
  | Etag.Generator
  | HttpRouter.HttpRouter
  | FileSystem
  | HttpPlatform
  | Path
  | HttpApiGroup.ToService<Id, Groups>
> =>
  HttpRouter.use(Effect.fnUntraced(function*(router) {
    const services = yield* Effect.context<
      | Etag.Generator
      | HttpRouter.HttpRouter
      | FileSystem
      | HttpPlatform
      | Path
    >()
    const routes: Array<HttpRouter.Route<any, any>> = []
    const availableGroups = Array.from(services.mapUnsafe.keys()).filter((key) =>
      key.startsWith("effect/httpapi/HttpApiGroup/")
    )
    for (const group of Object.values(api.groups)) {
      const groupRoutes = services.mapUnsafe.get(group.key)?.routes as Array<HttpRouter.Route<any, any>>
      if (groupRoutes === undefined) {
        const available = availableGroups.length === 0 ? "none" : availableGroups.join(", ")
        return yield* Effect.die(
          `HttpApiGroup "${group.identifier}" not found (key: "${group.key}"). Did you forget to provide HttpApiBuilder.group(api, "${group.identifier}", ...)? Available groups: ${available}`
        )
      }
      routes.push(...groupRoutes)
    }
    yield* (router.addAll(routes) as Effect.Effect<void>)
    if (options?.openapiPath) {
      const spec = OpenApi.fromApi(api)
      yield* router.add("GET", options.openapiPath, Effect.succeed(Response.jsonUnsafe(spec)))
    }
  }))

/**
 * Create a `Layer` that implements all endpoints in an `HttpApi` group.
 *
 * **Details**
 *
 * The `build` function receives an unimplemented `Handlers` instance that can
 * be used to add handlers to the group. Implement endpoints with
 * `handlers.handle`.
 *
 * @category handlers
 * @since 4.0.0
 */
export const group = <
  ApiId extends string,
  Groups extends HttpApiGroup.Any,
  const Name extends HttpApiGroup.Name<Groups>,
  Return
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  groupName: Name,
  build: (
    handlers: Handlers.FromGroup<HttpApiGroup.WithName<Groups, Name>>
  ) => Handlers.ValidateReturn<Return>
): Layer.Layer<
  HttpApiGroup.ApiGroup<ApiId, Name>,
  Handlers.Error<Return>,
  Exclude<Handlers.Context<Return>, Scope.Scope>
> =>
  Layer.effectContext(Effect.gen(function*() {
    const services = (yield* Effect.context<any>()).pipe(
      Context.omit(Scope.Scope)
    )
    const group = api.groups[groupName]!
    const result = build(makeHandlers(group))
    const handlers: Handlers<any, any> = Effect.isEffect(result)
      ? (yield* result as Effect.Effect<any, any, any>)
      : result
    const routes: Array<HttpRouter.Route<any, any>> = []
    for (const item of handlers.handlers.values()) {
      routes.push(handlerToRoute(group as any, item, services))
    }
    return Context.makeUnsafe(
      new Map([[group.key, {
        routes,
        handlers: handlers.handlers
      }]])
    )
  })) as any

/**
 * Type identifier symbol used to brand `Handlers` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const HandlersTypeId: unique symbol = Symbol.for("@effect/platform/HttpApiBuilder/Handlers")

/**
 * Type of the `Handlers` type identifier symbol.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type HandlersTypeId = typeof HandlersTypeId

/**
 * Mutable handler collection for one `HttpApi` group.
 *
 * **Details**
 *
 * Each call to `handle` or `handleRaw` registers an endpoint implementation and
 * removes that endpoint from the type-level set of endpoints still requiring
 * handlers.
 *
 * @category handlers
 * @since 4.0.0
 */
export interface Handlers<
  R,
  Endpoints extends HttpApiEndpoint.Any = never
> extends Pipeable {
  readonly [HandlersTypeId]: {
    _Endpoints: Covariant<Endpoints>
  }
  readonly group: HttpApiGroup.AnyWithProps
  readonly handlers: Map<string, Handlers.Item<R>>

  /**
   * Add the implementation for an `HttpApiEndpoint` to a `Handlers` group.
   */
  handle<Name extends HttpApiEndpoint.Name<Endpoints>, R1>(
    name: Name,
    handler: HttpApiEndpoint.HandlerWithName<Endpoints, Name, HttpApiEndpoint.ErrorsWithName<Endpoints, Name>, R1>,
    options?: { readonly uninterruptible?: boolean | undefined } | undefined
  ): Handlers<
    | R
    | HttpApiEndpoint.MiddlewareWithName<Endpoints, Name>
    | HttpApiEndpoint.MiddlewareServicesWithName<Endpoints, Name>
    | (HttpApiEndpoint.ExcludeProvidedWithName<
      Endpoints,
      Name,
      R1 | HttpApiEndpoint.ServerServicesWithName<Endpoints, Name>
    > extends infer _R ? _R extends never ? never : HttpRouter.Request<"Requires", _R> : never),
    HttpApiEndpoint.ExcludeName<Endpoints, Name>
  >

  /**
   * Add the implementation for an `HttpApiEndpoint` to a `Handlers` group.
   * This version opts out of automatic payload decoding and provides the raw request.
   */
  handleRaw<Name extends HttpApiEndpoint.Name<Endpoints>, R1>(
    name: Name,
    handler: HttpApiEndpoint.HandlerRawWithName<Endpoints, Name, HttpApiEndpoint.ErrorsWithName<Endpoints, Name>, R1>,
    options?: { readonly uninterruptible?: boolean | undefined } | undefined
  ): Handlers<
    | R
    | HttpApiEndpoint.MiddlewareWithName<Endpoints, Name>
    | HttpApiEndpoint.MiddlewareServicesWithName<Endpoints, Name>
    | (HttpApiEndpoint.ExcludeProvidedWithName<
      Endpoints,
      Name,
      R1 | HttpApiEndpoint.ServerServicesWithName<Endpoints, Name>
    > extends infer _R ? _R extends never ? never : HttpRouter.Request<"Requires", _R> : never),
    HttpApiEndpoint.ExcludeName<Endpoints, Name>
  >
}

/**
 * Namespace containing helper types for `HttpApiBuilder` handler collections.
 *
 * @since 4.0.0
 */
export declare namespace Handlers {
  /**
   * A `Handlers` value with its context and endpoint types erased.
   *
   * @category handlers
   * @since 4.0.0
   */
  export interface Any {
    readonly [HandlersTypeId]: any
  }

  /**
   * Record stored for a registered endpoint handler.
   *
   * **Details**
   *
   * It keeps the endpoint metadata, handler function, whether raw request handling
   * is used, and whether the handler should run uninterruptibly.
   *
   * @category handlers
   * @since 4.0.0
   */
  export type Item<R> = {
    readonly endpoint: HttpApiEndpoint.AnyWithProps
    readonly handler: HttpApiEndpoint.Handler<any, any, R>
    readonly isRaw: boolean
    readonly uninterruptible: boolean
  }

  /**
   * Creates a handler collection for a group where every endpoint in the group is
   * still awaiting an implementation.
   *
   * @category handlers
   * @since 4.0.0
   */
  export type FromGroup<Group extends HttpApiGroup.Any> = Handlers<
    never,
    HttpApiGroup.Endpoints<Group>
  >

  /**
   * Validates the return value of a group handler builder, preserving successful
   * handler collections and producing a descriptive type error when endpoints remain
   * unhandled.
   *
   * @category handlers
   * @since 4.0.0
   */
  export type ValidateReturn<A> = A extends (
    | Handlers<
      infer _R,
      infer _Endpoints
    >
    | Effect.Effect<
      Handlers<
        infer _R,
        infer _Endpoints
      >,
      infer _EX,
      infer _RX
    >
  ) ? [_Endpoints] extends [never] ? A
    : `Endpoint not handled: ${HttpApiEndpoint.Name<_Endpoints>}` :
    `Must return the implemented handlers`

  /**
   * Extracts the error channel from an effect that produces a `Handlers`
   * collection, returning `never` for non-effectful handler collections.
   *
   * @category handlers
   * @since 4.0.0
   */
  export type Error<A> = A extends Effect.Effect<
    Handlers<
      infer _R,
      infer _Endpoints
    >,
    infer _EX,
    infer _RX
  > ? _EX :
    never

  /**
   * Extracts the services required by a handler collection, including both handler
   * requirements and the environment required to construct the handlers.
   *
   * @category handlers
   * @since 4.0.0
   */
  export type Context<A> = A extends Handlers<
    infer _R,
    infer _Endpoints
  > ? _R :
    A extends Effect.Effect<
      Handlers<
        infer _R,
        infer _Endpoints
      >,
      infer _EX,
      infer _RX
    > ? _R | _RX :
    never
}

/**
 * Builds the server-side HTTP effect for a single endpoint in an API group using
 * the endpoint metadata, middleware, codecs, and supplied handler.
 *
 * @category handlers
 * @since 4.0.0
 */
export const endpoint = <
  ApiId extends string,
  Groups extends HttpApiGroup.Any,
  const GroupName extends HttpApiGroup.Name<Groups>,
  const EndpointName extends HttpApiEndpoint.Name<HttpApiGroup.Endpoints<HttpApiGroup.WithName<Groups, GroupName>>>,
  R,
  Group extends HttpApiGroup.Any = HttpApiGroup.WithName<Groups, GroupName>,
  Endpoint extends HttpApiEndpoint.Any = HttpApiEndpoint.WithName<HttpApiGroup.Endpoints<Group>, EndpointName>
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  groupName: GroupName,
  endpointName: EndpointName,
  handler: NoInfer<
    HttpApiEndpoint.HandlerWithName<
      HttpApiGroup.Endpoints<HttpApiGroup.WithName<Groups, GroupName>>,
      EndpointName,
      never,
      R
    >
  >
): Effect.Effect<
  Effect.Effect<
    HttpServerResponse,
    never,
    | HttpServerRequest
    | HttpRouter.RouteContext
    | Request.ParsedSearchParams
    | Exclude<R, HttpApiEndpoint.MiddlewareProvides<Endpoint>>
  >,
  never,
  | HttpApiEndpoint.ServerServices<Endpoint>
  | HttpApiEndpoint.Middleware<Endpoint>
  | HttpApiEndpoint.MiddlewareServices<Endpoint>
  | Etag.Generator
  | FileSystem
  | HttpPlatform
  | Path
> =>
  Effect.contextWith((context: Context.Context<any>) => {
    const group = api.groups[groupName] as unknown as HttpApiGroup.AnyWithProps
    const endpoint = group.endpoints[endpointName] as unknown as HttpApiEndpoint.AnyWithProps
    return Effect.succeed(handlerToHttpEffect(
      group,
      endpoint,
      Context.omit(Scope.Scope)(context),
      handler as any,
      false
    ))
  })

/**
 * Decodes credentials for an HTTP API security scheme from the current request,
 * supporting bearer, API key, and basic authentication inputs.
 *
 * @category security
 * @since 4.0.0
 */
export const securityDecode = <Security extends HttpApiSecurity.HttpApiSecurity>(
  self: Security
): Effect.Effect<
  HttpApiSecurity.HttpApiSecurity.Type<Security>,
  never,
  HttpServerRequest | Request.ParsedSearchParams
> => {
  switch (self._tag) {
    case "Http": {
      return Effect.map(
        HttpServerRequest,
        (request) => Redacted.make((request.headers.authorization ?? "").slice(self.schemeLength)) as any
      )
    }
    case "ApiKey": {
      const key = self.in === "header" ? self.key.toLowerCase() : self.key
      const schema = Schema.Struct({
        [key]: Schema.String
      })
      const decode: Effect.Effect<
        { readonly [x: string]: string; readonly [x: number]: string },
        Schema.SchemaError,
        Request.ParsedSearchParams | HttpServerRequest
      > = self.in === "query"
        ? Request.schemaSearchParams(schema)
        : self.in === "cookie"
        ? Request.schemaCookies(schema)
        : Request.schemaHeaders(schema)
      return Effect.match(decode, {
        onFailure: () => Redacted.make("") as any,
        onSuccess: (match) => Redacted.make(match[key])
      })
    }
    case "Basic": {
      const empty: HttpApiSecurity.HttpApiSecurity.Type<Security> = {
        username: "",
        password: Redacted.make("")
      } as any
      return HttpServerRequest.pipe(
        Effect.flatMap((request) =>
          Effect.fromResult(Encoding.decodeBase64String((request.headers.authorization ?? "").slice(basicLen)))
        ),
        Effect.match({
          onFailure: () => empty,
          onSuccess: (header) => {
            const parts = header.split(":")
            if (parts.length !== 2) {
              return empty
            }
            return {
              username: parts[0],
              password: Redacted.make(parts[1])
            } as any
          }
        })
      )
    }
  }
}

/**
 * Registers a pre-response handler that sets an API-key cookie on the outgoing
 * response, defaulting the cookie to `secure` and `httpOnly` unless overridden.
 *
 * @category security
 * @since 4.0.0
 */
export const securitySetCookie = (
  self: HttpApiSecurity.ApiKey,
  value: string | Redacted.Redacted,
  options?: Cookie["options"]
): Effect.Effect<void, never, HttpServerRequest> =>
  HttpEffect.appendPreResponseHandler((_req, response) =>
    Effect.orDie(
      Response.setCookie(response, self.key, stringOrRedacted(value), {
        secure: true,
        httpOnly: true,
        ...options
      })
    )
  )

// -----------------------------------------------------------------------------
// Internal
// -----------------------------------------------------------------------------

const basicLen = `Basic `.length

const HandlersProto = {
  [HandlersTypeId]: {
    _Endpoints: identity
  },
  pipe() {
    return pipeArguments(this, arguments)
  },
  handle(
    this: Handlers<any, HttpApiEndpoint.Any>,
    name: string,
    handler: HttpApiEndpoint.Handler<any, any, any>,
    options?: { readonly uninterruptible?: boolean | undefined } | undefined
  ) {
    const endpoint = this.group.endpoints[name]
    this.handlers.set(name, {
      endpoint,
      handler,
      isRaw: false,
      uninterruptible: options?.uninterruptible ?? false
    })
    return this
  },
  handleRaw(
    this: Handlers<any, HttpApiEndpoint.Any>,
    name: string,
    handler: HttpApiEndpoint.Handler<any, any, any>,
    options?: { readonly uninterruptible?: boolean | undefined } | undefined
  ) {
    const endpoint = this.group.endpoints[name]
    this.handlers.set(name, {
      endpoint,
      handler,
      isRaw: true,
      uninterruptible: options?.uninterruptible ?? false
    })
    return this
  }
}

const makeHandlers = <R, Endpoints extends HttpApiEndpoint.Any>(
  group: HttpApiGroup.Any
): Handlers<R, Endpoints> => {
  const self = Object.create(HandlersProto)
  self.group = group
  self.handlers = new Map<string, Handlers.Item<R>>()
  return self
}

type PayloadDecoder =
  | {
    readonly _tag: "Multipart"
    readonly mode: "buffered" | "stream"
    readonly limits: Multipart.withLimits.Options | undefined
    readonly decode: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError, unknown>
  }
  | {
    readonly _tag: "Json" | "FormUrlEncoded" | "Uint8Array" | "Text"
    readonly nullOnEmpty: boolean
    readonly decode: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError, unknown>
  }

function buildPayloadDecoders(
  payloadMap: HttpApiEndpoint.PayloadMap
): Map<string, PayloadDecoder> {
  const result = new Map<string, PayloadDecoder>()
  payloadMap.forEach(({ encoding, schemas }, contentType) => {
    const decode = Schema.decodeUnknownEffect(Schema.Union(schemas))
    if (encoding._tag === "Multipart") {
      result.set(contentType, { _tag: "Multipart", mode: encoding.mode, limits: encoding.limits, decode })
    } else {
      result.set(contentType, {
        _tag: encoding._tag,
        decode,
        nullOnEmpty: schemas.some((s) => AST.isNull(AST.toEncoded(s.ast)))
      })
    }
  })
  return result
}

function decodePayload(
  payloadBy: Map<string, PayloadDecoder>,
  httpRequest: HttpServerRequest,
  query: Record<string, string | Array<string>>
): Effect.Effect<unknown, Schema.SchemaError, unknown> | HttpServerResponse | undefined {
  const hasBody = HttpMethod.hasBody(httpRequest.method)
  const contentType = hasBody
    ? getRequestMediaType(httpRequest)
    : "application/x-www-form-urlencoded"
  const existing = payloadBy.get(contentType)
  if (!existing) {
    return Response.text(`Unsupported content-type: ${contentType}`, { status: 415 })
  }
  const { _tag, decode } = existing
  switch (_tag) {
    case "Multipart": {
      if (existing.mode === "buffered") {
        let eff = Effect.orDie(httpRequest.multipart)
        if (existing.limits) {
          eff = Effect.provideContext(eff, Multipart.limitsServices(existing.limits))
        }
        return Effect.flatMap(eff, decode)
      }
      return Effect.succeed(
        existing.limits
          ? Stream.provideContext(httpRequest.multipartStream, Multipart.limitsServices(existing.limits))
          : httpRequest.multipartStream
      )
    }
    case "Json":
      const json = Effect.orDie(Effect.flatMap(httpRequest.text, (text) => {
        if (text === "") {
          return existing.nullOnEmpty ? Effect.succeed(null) : Effect.undefined
        }
        return Effect.succeed(JSON.parse(text))
      }))
      return Effect.flatMap(json, decode)
    case "Text":
      return Effect.flatMap(Effect.orDie(httpRequest.text), decode)
    case "FormUrlEncoded": {
      const source = hasBody
        ? Effect.map(Effect.orDie(httpRequest.urlParamsBody), UrlParams.toRecord)
        : Effect.succeed(query)
      return Effect.flatMap(source, decode)
    }
    case "Uint8Array":
      return Effect.flatMap(
        Effect.map(Effect.orDie(httpRequest.arrayBuffer), (buffer) => new Uint8Array(buffer)),
        decode
      )
  }
}

function handlerToHttpEffect(
  group: HttpApiGroup.AnyWithProps,
  endpoint: HttpApiEndpoint.AnyWithProps,
  context: Context.Context<any>,
  handler: HttpApiEndpoint.Handler<any, any, any>,
  isRaw: boolean
) {
  const encodeSuccess = Schema.encodeUnknownEffect(makeSuccessSchema(endpoint))
  const encodeError = Schema.encodeUnknownEffect(makeErrorSchema(endpoint))
  const decodeParams = UndefinedOr.map(endpoint.params, Schema.decodeUnknownEffect)
  const decodeHeaders = UndefinedOr.map(endpoint.headers, Schema.decodeUnknownEffect)
  const decodeQuery = UndefinedOr.map(endpoint.query, Schema.decodeUnknownEffect)

  const shouldParsePayload = endpoint.payload.size > 0 && !isRaw
  const payloadBy = shouldParsePayload ? buildPayloadDecoders(endpoint.payload) : undefined

  return applyMiddleware(
    group,
    endpoint,
    context,
    Effect.gen(function*() {
      const fiber = Fiber.getCurrent()!
      const context = fiber.context
      const httpRequest = Context.getUnsafe(context, HttpServerRequest)
      const routeContext = Context.getUnsafe(context, HttpRouter.RouteContext)
      const query = Context.getUnsafe(context, Request.ParsedSearchParams)
      const request: any = {
        request: httpRequest,
        endpoint,
        group
      }
      if (decodeParams) {
        request.params = yield* HttpApiSchemaError.wrap("Params", decodeParams(routeContext.params))
      }
      if (decodeHeaders) {
        request.headers = yield* HttpApiSchemaError.wrap("Headers", decodeHeaders(httpRequest.headers))
      }
      if (decodeQuery) {
        request.query = yield* HttpApiSchemaError.wrap("Query", decodeQuery(query))
      }
      if (payloadBy) {
        const result = decodePayload(payloadBy, httpRequest, query)
        if (Response.isHttpServerResponse(result)) {
          return result
        }
        if (result !== undefined) {
          request.payload = yield* HttpApiSchemaError.wrap("Payload", result)
        }
      }
      const response = yield* handler(request)
      return Response.isHttpServerResponse(response)
        ? response
        : yield* HttpApiSchemaError.wrap("Body", encodeSuccess(response))
    })
  ).pipe(
    Effect.withErrorReporting,
    Effect.catch((error) => {
      if (HttpApiSchemaError.is(error)) return Effect.die(error)
      return Effect.orDie(encodeError(error))
    }),
    Effect.provideContext(context)
  )
}

/** @internal */
export function handlerToRoute(
  group: HttpApiGroup.AnyWithProps,
  handler: Handlers.Item<any>,
  context: Context.Context<any>
): HttpRouter.Route<any, any> {
  const endpoint = handler.endpoint
  return HttpRouter.route(
    endpoint.method,
    endpoint.path as HttpRouter.PathInput,
    handlerToHttpEffect(group, endpoint, context, handler.handler, handler.isRaw),
    { uninterruptible: handler.uninterruptible }
  )
}

const getRequestContentType = (request: HttpServerRequest): string =>
  request.headers["content-type"]
    ? request.headers["content-type"].toLowerCase().trim()
    : "application/json"

const getRequestMediaType = (request: HttpServerRequest): string => {
  const contentType = getRequestContentType(request)
  const index = contentType.indexOf(";")
  return index === -1 ? contentType : contentType.slice(0, index).trim()
}

const applyMiddleware = <A extends Effect.Effect<any, any, any>>(
  group: HttpApiGroup.AnyWithProps,
  endpoint: HttpApiEndpoint.AnyWithProps,
  context: Context.Context<any>,
  handler: A
) => {
  const options = { group, endpoint }
  for (const key_ of endpoint.middlewares) {
    const key = key_ as any as HttpApiMiddleware.AnyService
    const service = Context.getUnsafe(context, key as any) as HttpApiMiddleware.HttpApiMiddleware<any, any, any>
    const apply = HttpApiMiddleware.isSecurity(key)
      ? makeSecurityMiddleware(key, service as any)
      : service
    handler = apply(handler, options) as A
  }
  return handler
}

const securityMiddlewareCache = new WeakMap<
  object,
  (effect: Effect.Effect<any, any, any>, options: any) => Effect.Effect<any, any, any>
>()

const makeSecurityMiddleware = (
  key: HttpApiMiddleware.AnyServiceSecurity,
  service: HttpApiMiddleware.HttpApiMiddlewareSecurity<any, any, any, any>
): (effect: Effect.Effect<any, any, any>, options: any) => Effect.Effect<any, any, any> => {
  const cached = securityMiddlewareCache.get(service)
  if (cached !== undefined) {
    return cached
  }

  const entries = Object.entries(key.security).map(([securityKey, security]) => ({
    decode: securityDecode(security),
    middleware: service[securityKey]
  }))
  if (entries.length === 0) {
    return identity
  }

  const middleware = Effect.fnUntraced(function*(handler: Effect.Effect<any, any, any>, options: {
    readonly group: HttpApiGroup.AnyWithProps
    readonly endpoint: HttpApiEndpoint.AnyWithProps
  }) {
    let lastResult: Result.Result<any, any> | undefined
    for (let i = 0; i < entries.length; i++) {
      const { decode, middleware } = entries[i]
      const result = yield* Effect.result(Effect.flatMap(decode, (credential) =>
        middleware(handler, {
          credential,
          endpoint: options.endpoint,
          group: options.group
        })))
      if (Result.isFailure(result)) {
        lastResult = result
        continue
      }
      return result.success
    }
    return yield* Effect.fromResult(lastResult!)
  })

  securityMiddlewareCache.set(service, middleware)
  return middleware
}

const $HttpServerResponse = Schema.declare(Response.isHttpServerResponse)

const toResponseSuccessSchema = toResponseSchema(HttpApiSchema.getStatusSuccess)
const toResponseErrorSchema = toResponseSchema(HttpApiSchema.getStatusError)

function makeSuccessSchema(endpoint: HttpApiEndpoint.AnyWithProps): Schema.Encoder<HttpServerResponse, unknown> {
  const schemas = HttpApiEndpoint.getSuccessSchemas(endpoint).map(toResponseSuccessSchema)
  return schemas.length === 1 ? schemas[0] : Schema.Union(schemas)
}

function makeErrorSchema(endpoint: HttpApiEndpoint.AnyWithProps): Schema.Encoder<HttpServerResponse, unknown> {
  const schemas = HttpApiEndpoint.getErrorSchemas(endpoint).map(toResponseErrorSchema)
  if (schemas.length === 0) return Schema.Never
  return schemas.length === 1 ? schemas[0] : Schema.Union(schemas)
}

function toResponseSchema(getStatus: (ast: AST.AST) => number) {
  const cache = new WeakMap<AST.AST, Schema.Top>()

  return (schema: Schema.Top): Schema.Encoder<HttpServerResponse, unknown> => {
    const cached = cache.get(schema.ast)
    if (cached !== undefined) {
      return cached as any
    }
    const responseSchema = $HttpServerResponse.pipe(
      Schema.decodeTo(schema, getResponseTransformation(getStatus, schema))
    )
    cache.set(responseSchema.ast, responseSchema)
    return responseSchema
  }
}

function getResponseTransformation(
  getStatus: (ast: AST.AST) => number,
  schema: Schema.Top
): Transformation.Transformation<unknown, Response.HttpServerResponse> {
  const ast = schema.ast
  const encode = getResponseEncode(
    getStatus(ast),
    HttpApiSchema.getResponseEncoding(ast),
    HttpApiSchema.isNoContent(ast)
  )

  return Transformation.transformOrFail({
    decode: (res) => Effect.fail(new Issue.Forbidden(Option.some(res), { message: "Encode only schema" })),
    encode
  })
}

function getResponseEncode<E>(
  status: number,
  encoding: HttpApiSchema.ResponseEncoding,
  isNoContent: boolean
): (e: E) => Effect.Effect<Response.HttpServerResponse, Issue.InvalidValue, never> {
  switch (encoding._tag) {
    case "Json": {
      return ((e) => {
        if (e === undefined || isNoContent) {
          return Effect.succeed(Response.empty({ status }))
        }
        try {
          const s = JSON.stringify(e)
          return Effect.succeed(Response.text(s, { status, contentType: encoding.contentType }))
        } catch (error) {
          return Effect.fail(new Issue.InvalidValue(Option.some(e), { message: globalThis.String(error) }))
        }
      })
    }
    case "Text":
      return (e) =>
        Effect.succeed(Response.text(e as string, {
          status,
          contentType: encoding.contentType
        }))
    case "Uint8Array":
      return (e) =>
        Effect.succeed(Response.uint8Array(e as Uint8Array, {
          status,
          contentType: encoding.contentType
        }))
    case "FormUrlEncoded":
      return (e) =>
        Effect.succeed(
          Response.urlParams(e as URLSearchParams, { status }).pipe(
            Response.setHeader("content-type", encoding.contentType)
          )
        )
  }
}
