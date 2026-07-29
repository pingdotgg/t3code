/**
 * Builds server routes from declarative `HttpApi` contracts.
 *
 * This module turns an `HttpApi` description plus group handlers into
 * `HttpRouter` routes. At runtime it decodes request parts with schemas, runs
 * middleware and security handlers, invokes the registered endpoint handler, and
 * encodes successes or declared errors into `HttpServerResponse` values.
 *
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import type * as Cause from "../../Cause.ts"
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
import { hasProperty } from "../../Predicate.ts"
import * as Redacted from "../../Redacted.ts"
import * as Result from "../../Result.ts"
import * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import * as SchemaIssue from "../../SchemaIssue.ts"
import * as SchemaTransformation from "../../SchemaTransformation.ts"
import * as Scope from "../../Scope.ts"
import * as Stream from "../../Stream.ts"
import type { NoInfer } from "../../Types.ts"
import * as UndefinedOr from "../../UndefinedOr.ts"
import * as Sse from "../encoding/Sse.ts"
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
import * as MediaType from "./internal/mediaType.ts"
import * as OpenApi from "./OpenApi.ts"

/**
 * Registers an `HttpApi` with a `HttpRouter`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const layer = <Id extends string, Groups extends HttpApiGroup.Constraint>(
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
    const groups = Object.values(api.groups) as ReadonlyArray<HttpApiGroup.Top>
    for (const group of groups) {
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
  Groups extends HttpApiGroup.Constraint,
  const Identifier extends HttpApiGroup.Identifier<Groups>,
  Return
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  groupIdentifier: Identifier,
  build: (
    handlers: Handlers.FromGroup<HttpApiGroup.WithIdentifier<Groups, Identifier>>
  ) => Handlers.ValidateReturn<Return>
): Layer.Layer<
  HttpApiGroup.Service<ApiId, Identifier>,
  Handlers.Error<Return>,
  Exclude<Handlers.Context<Return>, Scope.Scope>
> =>
  Layer.effectContext(Effect.gen(function*() {
    const services = (yield* Effect.context<any>()).pipe(
      Context.omit(Scope.Scope)
    )
    const group = api.groups[groupIdentifier] as HttpApiGroup.Constraint
    const result = build(makeHandlers(group))
    const handlers: Handlers<any, any, any> = Effect.isEffect(result)
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

const HandlersTypeId = "~effect/httpapi/HttpApiBuilder/Handlers"

type EndpointMap<Endpoints extends HttpApiEndpoint.Constraint> = {
  readonly [Endpoint in Endpoints as HttpApiEndpoint.Identifier<Endpoint>]: Endpoint
}

type HandlerRequirements<
  Endpoint extends HttpApiEndpoint.Constraint,
  R1,
  R = HttpApiEndpoint.ExcludeProvided<
    Endpoint,
    R1 | HttpApiEndpoint.ServerServices<Endpoint>
  >
> =
  | HttpApiEndpoint.Middleware<Endpoint>
  | HttpApiEndpoint.MiddlewareServices<Endpoint>
  | ([R] extends [never] ? never : HttpRouter.Request.From<"Requires", R>)

interface HandlerOptions {
  readonly uninterruptible?: boolean | undefined
}

/** @internal */
export interface HandlerRuntime {
  readonly endpoint: HttpApiEndpoint.Top
  readonly handler: HttpApiEndpoint.Handler<HttpApiEndpoint.Constraint, unknown, unknown>
  readonly isRaw: boolean
  readonly uninterruptible: boolean
}

type HandleAllEntry<Endpoint extends HttpApiEndpoint.Constraint> =
  | HttpApiEndpoint.Handler<
    Endpoint,
    HttpApiEndpoint.MiddlewareError<Endpoint>,
    unknown
  >
  | {
    readonly handler: HttpApiEndpoint.Handler<
      Endpoint,
      HttpApiEndpoint.MiddlewareError<Endpoint>,
      unknown
    >
    readonly options?: HandlerOptions | undefined
  }

type HandleAllHandlers<EndpointsByIdentifier extends Record<string, HttpApiEndpoint.Constraint>> = {
  readonly [Identifier in keyof EndpointsByIdentifier]?: HandleAllEntry<EndpointsByIdentifier[Identifier]>
}

type HandleAllExtraKeys<
  EndpointsByIdentifier extends Record<string, HttpApiEndpoint.Constraint>,
  HandlersByIdentifier
> = {
  readonly [Identifier in Exclude<keyof HandlersByIdentifier, keyof EndpointsByIdentifier>]: never
}

type NotHandledIdentifier<Identifier extends PropertyKey, HandledIdentifiers extends PropertyKey> = Identifier extends
  HandledIdentifiers ? never :
  unknown

type HandleAllEntryHandler<Entry> = Entry extends { readonly handler: infer Handler } ? Handler : Entry

type HandleAllRequirements<
  EndpointsByIdentifier extends Record<string, HttpApiEndpoint.Constraint>,
  HandlersByIdentifier extends HandleAllHandlers<EndpointsByIdentifier>
> = {
  readonly [Identifier in keyof HandlersByIdentifier & keyof EndpointsByIdentifier]: HandleAllEntryHandler<
    HandlersByIdentifier[Identifier]
  > extends HttpApiEndpoint.Handler<
    EndpointsByIdentifier[Identifier],
    HttpApiEndpoint.MiddlewareError<EndpointsByIdentifier[Identifier]>,
    infer R1
  > ? HandlerRequirements<EndpointsByIdentifier[Identifier], R1> :
    never
}[keyof HandlersByIdentifier & keyof EndpointsByIdentifier]

type HandlersResult<A> = A extends Effect.Effect<infer H, any, any> ? H : A

type MissingHandlerNames<H extends Handlers<any, any, any>> = Exclude<
  keyof H["~EndpointsByIdentifier"],
  H["~HandledIdentifiers"]
>

type ValidateHandlersReturn<
  A,
  H = HandlersResult<A>,
  Missing = H extends Handlers<any, any, any> ? MissingHandlerNames<H> : never
> = H extends Handlers<any, any, any> ? [Missing] extends [never] ? A
  : `Endpoint not handled: ${Missing & string}`
  : `Must return the implemented handlers`

/**
 * Mutable handler collection for one `HttpApi` group.
 *
 * **Details**
 *
 * Each call to `handle` or `handleRaw` registers an endpoint implementation and
 * adds that endpoint identifier to the type-level set of implemented endpoints.
 * Endpoint identifiers that were already handled are rejected at the type level.
 *
 * @category handlers
 * @since 4.0.0
 */
export interface Handlers<
  R,
  EndpointsByIdentifier extends Record<string, HttpApiEndpoint.Constraint> = {},
  HandledIdentifiers extends keyof EndpointsByIdentifier = never
> extends Pipeable {
  readonly [HandlersTypeId]: typeof HandlersTypeId
  readonly "~EndpointsByIdentifier": EndpointsByIdentifier
  readonly "~HandledIdentifiers": HandledIdentifiers
  /** @internal */
  readonly group: HttpApiGroup.Top
  /** @internal */
  readonly handlers: Map<string, HandlerRuntime>

  /**
   * Add the implementation for an unhandled `HttpApiEndpoint` to a `Handlers` group.
   */
  handle<
    Identifier extends keyof EndpointsByIdentifier,
    R1
  >(
    identifier: Identifier & NotHandledIdentifier<Identifier, HandledIdentifiers>,
    handler: HttpApiEndpoint.Handler<
      EndpointsByIdentifier[Identifier],
      HttpApiEndpoint.MiddlewareError<EndpointsByIdentifier[Identifier]>,
      R1
    >,
    options?: { readonly uninterruptible?: boolean | undefined } | undefined
  ): Handlers<
    R | HandlerRequirements<EndpointsByIdentifier[Identifier], R1>,
    EndpointsByIdentifier,
    HandledIdentifiers | Identifier
  >

  /**
   * Add implementations for unhandled `HttpApiEndpoint`s in a `Handlers` group.
   */
  handleAll<const HandlersByIdentifier extends HandleAllHandlers<Omit<EndpointsByIdentifier, HandledIdentifiers>>>(
    handlers:
      & HandlersByIdentifier
      & HandleAllExtraKeys<Omit<EndpointsByIdentifier, HandledIdentifiers>, HandlersByIdentifier>
  ): Handlers<
    R | HandleAllRequirements<EndpointsByIdentifier, HandlersByIdentifier>,
    EndpointsByIdentifier,
    HandledIdentifiers | keyof HandlersByIdentifier & keyof EndpointsByIdentifier
  >

  /**
   * Add the implementation for an unhandled `HttpApiEndpoint` to a `Handlers` group.
   * This version opts out of automatic payload decoding and provides the raw request.
   */
  handleRaw<
    Identifier extends keyof EndpointsByIdentifier,
    R1
  >(
    identifier: Identifier & NotHandledIdentifier<Identifier, HandledIdentifiers>,
    handler: HttpApiEndpoint.HandlerRaw<
      EndpointsByIdentifier[Identifier],
      HttpApiEndpoint.MiddlewareError<EndpointsByIdentifier[Identifier]>,
      R1
    >,
    options?: { readonly uninterruptible?: boolean | undefined } | undefined
  ): Handlers<
    R | HandlerRequirements<EndpointsByIdentifier[Identifier], R1>,
    EndpointsByIdentifier,
    HandledIdentifiers | Identifier
  >
}

/**
 * Namespace containing helper types for `HttpApiBuilder` handler collections.
 *
 * @since 4.0.0
 */
export declare namespace Handlers {
  /**
   * Creates a handler collection for a group where every endpoint in the group is
   * still awaiting an implementation.
   *
   * @category handlers
   * @since 4.0.0
   */
  export type FromGroup<Group extends HttpApiGroup.Constraint> = Handlers<
    never,
    Group["endpoints"]
  >

  /**
   * Validates the return value of a group handler builder, preserving successful
   * handler collections and producing a descriptive type error when endpoints remain
   * unhandled.
   *
   * @category handlers
   * @since 4.0.0
   */
  export type ValidateReturn<A> = ValidateHandlersReturn<A>

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
      infer _EndpointsByIdentifier,
      infer _HandledIdentifiers
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
    infer _EndpointsByIdentifier,
    infer _HandledIdentifiers
  > ? _R :
    A extends Effect.Effect<
      Handlers<
        infer _R,
        infer _EndpointsByIdentifier,
        infer _HandledIdentifiers
      >,
      infer _EX,
      infer _RX
    > ? _R | _RX :
    never
}

type EndpointReturn<
  Groups extends HttpApiGroup.Constraint,
  GroupIdentifier extends HttpApiGroup.Identifier<Groups>,
  EndpointIdentifier extends HttpApiGroup.Endpoints<
    HttpApiGroup.WithIdentifier<Groups, GroupIdentifier>
  >["identifier"],
  R,
  Endpoint extends HttpApiEndpoint.Constraint = HttpApiEndpoint.WithIdentifier<
    HttpApiGroup.Endpoints<HttpApiGroup.WithIdentifier<Groups, GroupIdentifier>>,
    EndpointIdentifier
  >
> = Effect.Effect<
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
>

/**
 * Builds the server-side HTTP effect for a single endpoint in an API group using
 * the endpoint metadata, middleware, codecs, and supplied handler.
 *
 * @category handlers
 * @since 4.0.0
 */
export const endpoint = <
  ApiId extends string,
  Groups extends HttpApiGroup.Constraint,
  const GroupIdentifier extends HttpApiGroup.Identifier<Groups>,
  const EndpointIdentifier extends HttpApiGroup.Endpoints<
    HttpApiGroup.WithIdentifier<Groups, GroupIdentifier>
  >["identifier"],
  R
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  groupIdentifier: GroupIdentifier,
  endpointIdentifier: EndpointIdentifier,
  handler: NoInfer<
    HttpApiEndpoint.HandlerWithIdentifier<
      HttpApiGroup.Endpoints<HttpApiGroup.WithIdentifier<Groups, GroupIdentifier>>,
      EndpointIdentifier,
      never,
      R
    >
  >
): EndpointReturn<Groups, GroupIdentifier, EndpointIdentifier, R> =>
  Effect.contextWith((context: Context.Context<any>) => {
    const group = api.groups[groupIdentifier] as unknown as HttpApiGroup.Top
    const endpoint = group.endpoints[endpointIdentifier]
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
        (request) =>
          Redacted.make(
            getAuthorizationCredential(request.headers.authorization, self.scheme) ?? ""
          ) as any
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
      return Effect.map(HttpServerRequest, (request) => {
        const encoded = getAuthorizationCredential(request.headers.authorization, basicScheme)
        if (encoded === undefined) return empty
        const decoded = Result.getOrUndefined(Encoding.decodeBase64String(encoded))
        if (decoded === undefined) return empty
        // RFC 7617, Section 2: only the first colon separates the user-id from the password.
        // https://www.rfc-editor.org/rfc/rfc7617.html#section-2
        const separator = decoded.indexOf(":")
        if (separator === -1) return empty
        return {
          username: decoded.slice(0, separator),
          password: Redacted.make(decoded.slice(separator + 1))
        } as any
      })
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

const basicScheme = "Basic"

function getAuthorizationCredential(
  authorization: string | undefined,
  scheme: string
): string | undefined {
  const schemeLength = scheme.length
  // RFC 9110, Section 11.1: schemes are case-insensitive and credentials follow 1*SP.
  // https://www.rfc-editor.org/rfc/rfc9110.html#section-11.1
  if (
    authorization === undefined ||
    authorization.length <= schemeLength ||
    authorization.charCodeAt(schemeLength) !== 32 ||
    authorization.slice(0, schemeLength).toLowerCase() !== scheme.toLowerCase()
  ) {
    return undefined
  }
  let credentialStart = schemeLength + 1
  while (authorization.charCodeAt(credentialStart) === 32) {
    credentialStart++
  }
  return credentialStart === authorization.length ? undefined : authorization.slice(credentialStart)
}

const registerHandler = (
  self: Handlers<any, any, any>,
  identifier: string,
  handler: HttpApiEndpoint.Handler<HttpApiEndpoint.Constraint, any, any>,
  isRaw: boolean,
  options?: HandlerOptions | undefined
) => {
  if (!Object.hasOwn(self.group.endpoints, identifier)) {
    throw new Error(`HttpApiEndpoint "${identifier}" not found in HttpApiGroup "${self.group.identifier}"`)
  }
  if (self.handlers.has(identifier)) {
    throw new Error(
      `Handler for HttpApiEndpoint "${identifier}" is already registered in HttpApiGroup "${self.group.identifier}"`
    )
  }
  const endpoint = self.group.endpoints[identifier]
  self.handlers.set(identifier, {
    endpoint,
    handler,
    isRaw,
    uninterruptible: options?.uninterruptible ?? false
  })
  return self
}

const HandlersProto = {
  [HandlersTypeId]: HandlersTypeId,
  pipe() {
    return pipeArguments(this, arguments)
  },
  handle(
    this: Handlers<any, any, any>,
    identifier: string,
    handler: HttpApiEndpoint.Handler<HttpApiEndpoint.Constraint, any, any>,
    options?: { readonly uninterruptible?: boolean | undefined } | undefined
  ) {
    return registerHandler(this, identifier, handler, false, options)
  },
  handleAll(
    this: Handlers<any, any, any>,
    handlers: Record<
      string,
      HttpApiEndpoint.Handler<HttpApiEndpoint.Constraint, any, any> | {
        readonly handler: HttpApiEndpoint.Handler<HttpApiEndpoint.Constraint, any, any>
        readonly options?: HandlerOptions | undefined
      }
    >
  ) {
    for (const [identifier, entry] of Object.entries(handlers)) {
      const handler = typeof entry === "function" ? entry : entry.handler
      const options = typeof entry === "function" ? undefined : entry.options
      registerHandler(this, identifier, handler, false, options)
    }
    return this
  },
  handleRaw(
    this: Handlers<any, any, any>,
    identifier: string,
    handler: HttpApiEndpoint.Handler<HttpApiEndpoint.Constraint, any, any>,
    options?: { readonly uninterruptible?: boolean | undefined } | undefined
  ) {
    return registerHandler(this, identifier, handler, true, options)
  }
}

const makeHandlers = <R, Group extends HttpApiGroup.Constraint>(
  group: Group
): Handlers<R, EndpointMap<HttpApiGroup.Endpoints<Group>>> => {
  const self = Object.create(HandlersProto)
  self.group = group
  self.handlers = new Map<string, HandlerRuntime>()
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
        nullOnEmpty: schemas.some((s) => SchemaAST.isNull(SchemaAST.toEncoded(s.ast)))
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
    ? MediaType.normalize(httpRequest.headers["content-type"] ?? "application/json")
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
      return Effect.flatMap(Effect.orDie(httpRequest.text), (text) => {
        if (text === "") {
          return decode(existing.nullOnEmpty ? null : undefined)
        }
        try {
          return decode(JSON.parse(text))
        } catch (cause) {
          return Effect.fail(
            new Schema.SchemaError(
              new SchemaIssue.InvalidValue(Option.some(text), { message: `Invalid JSON: ${cause}` })
            )
          )
        }
      })
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
  group: HttpApiGroup.Top,
  endpoint: HttpApiEndpoint.Top,
  context: Context.Context<any>,
  handler: HttpApiEndpoint.Handler<HttpApiEndpoint.Constraint, any, any>,
  isRaw: boolean
) {
  const encodeSuccess = Schema.encodeUnknownEffect(makeSuccessSchema(endpoint))
  const encodeError = Schema.encodeUnknownEffect(makeErrorSchema(endpoint))
  const decodeParams = UndefinedOr.map(endpoint.params, Schema.decodeUnknownEffect)
  const decodeHeaders = UndefinedOr.map(endpoint.headers, Schema.decodeUnknownEffect)
  const decodeQuery = UndefinedOr.map(endpoint.query, Schema.decodeUnknownEffect)
  const encodeStream = makeStreamEncoder(endpoint)

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
      if (Response.isHttpServerResponse(response)) {
        return response
      }
      const streamResponse = encodeStream?.(response, context)
      if (streamResponse !== undefined) {
        return yield* HttpApiSchemaError.wrap("Body", streamResponse)
      }
      return yield* HttpApiSchemaError.wrap("Body", encodeSuccess(response))
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
  group: HttpApiGroup.Top,
  handler: HandlerRuntime,
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

const applyMiddleware = <Group extends HttpApiGroup.Constraint, A extends Effect.Effect<any, any, any>>(
  group: Group,
  endpoint: HttpApiEndpoint.Top,
  context: Context.Context<any>,
  handler: A
) => {
  const options = { group, endpoint }
  for (const key_ of endpoint.middlewares) {
    const key = key_ as HttpApiMiddleware.AnyService
    const service = Context.getUnsafe(context, key)
    const apply = HttpApiMiddleware.isSecurity(key)
      ? makeSecurityMiddleware(key, service)
      : service
    handler = apply(handler, options)
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
    readonly group: HttpApiGroup.Top
    readonly endpoint: HttpApiEndpoint.Top
  }) {
    handler = Effect.mapError(handler, (error) => new HandlerError(error))
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
        if (isHandlerError(result.failure)) {
          return yield* Effect.fail(result.failure.error)
        }
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

const HandlerErrorTypeId = "~effect/httpapi/HttpApiBuilder/HandlerError" as const
class HandlerError {
  readonly [HandlerErrorTypeId] = HandlerErrorTypeId
  readonly error: unknown
  constructor(error: unknown) {
    this.error = error
  }
}
const isHandlerError = (value: unknown): value is HandlerError => hasProperty(value, HandlerErrorTypeId)

const $HttpServerResponse = Schema.declare(Response.isHttpServerResponse)

type StreamEncoder = (response: unknown, context: Context.Context<never>) =>
  | Effect.Effect<HttpServerResponse, Schema.SchemaError, unknown>
  | undefined

function makeStreamEncoder(endpoint: HttpApiEndpoint.Top): StreamEncoder | undefined {
  const streamSchema = getStreamSuccessSchema(endpoint)
  if (streamSchema === undefined) {
    return undefined
  }

  const hasBuffered = hasBufferedSuccess(endpoint)
  const status = HttpApiSchema.getStatusStream(streamSchema)
  const contentType = streamSchema.contentType

  if (HttpApiSchema.isStreamUint8Array(streamSchema)) {
    return (response, context) => {
      if (!Stream.isStream(response)) {
        return hasBuffered ? undefined : new Schema.SchemaError(
          new SchemaIssue.InvalidValue(Option.some(response), { message: "Expected a streaming response" })
        )
      }

      return Effect.succeed(Response.stream(
        Stream.provideContext(
          response as Stream.Stream<Uint8Array, unknown, unknown>,
          context as Context.Context<unknown>
        ),
        { status, contentType }
      ))
    }
  }

  const sseEncoder = makeSseEncoder(streamSchema)

  return (response, context) => {
    if (!Stream.isStream(response)) {
      return hasBuffered ? undefined : new Schema.SchemaError(
        new SchemaIssue.InvalidValue(Option.some(response), { message: "Expected a streaming response" })
      )
    }

    return Effect.succeed(Response.stream(
      Stream.provideContext(
        encodeSseStream(response, sseEncoder),
        context as Context.Context<unknown>
      ),
      { status, contentType }
    ))
  }
}

function getStreamSuccessSchema(endpoint: HttpApiEndpoint.Top) {
  for (const schema of endpoint.success) {
    if (HttpApiSchema.isStreamSchema(schema)) {
      return schema
    }
  }
}

function hasBufferedSuccess(endpoint: HttpApiEndpoint.Top): boolean {
  for (const schema of endpoint.success) {
    if (Schema.isSchema(schema) && !HttpApiSchema.isStreamSchema(schema)) return true
  }
  return endpoint.success.size === 0
}

interface SseStreamEncoder {
  readonly sseMode: HttpApiSchema.StreamSseMode
  readonly encodeEvents: (
    input: NonEmptyReadonlyArray<unknown>
  ) => Effect.Effect<NonEmptyReadonlyArray<Sse.EventEncoded>, Schema.SchemaError, unknown>
  readonly encodeCause: (input: unknown) => Effect.Effect<string, Schema.SchemaError, unknown>
}

function makeSseEncoder<Events extends Sse.EventCodec, Error extends Schema.Constraint>(
  streamSchema: HttpApiSchema.StreamSse<Events, Error, unknown>
): SseStreamEncoder {
  const CauseSchema = Schema.toCodecJson(Schema.Cause(streamSchema.error, Schema.Defect()))
  return {
    sseMode: streamSchema.sseMode,
    encodeEvents: Schema.encodeUnknownEffect(Schema.Array(streamSchema.events)) as any,
    encodeCause: Schema.encodeUnknownEffect(Schema.fromJsonString(CauseSchema))
  }
}

function encodeSseStream(
  stream: Stream.Stream<unknown, unknown, unknown>,
  encoder: SseStreamEncoder
): Stream.Stream<Uint8Array, unknown, unknown> {
  return stream.pipe(
    encoder.sseMode === "data" ?
      Stream.map((value) => ({
        id: undefined,
        event: "message",
        data: value
      })) :
      identity,
    Stream.mapArrayEffect((chunk) => Effect.orDie(encoder.encodeEvents(chunk))),
    Stream.catchCause((cause) => Stream.fromEffect(encodeFailureEvent(cause, encoder))),
    Stream.map(renderSseEvent),
    Stream.encodeText
  )
}

function encodeFailureEvent(cause: Cause.Cause<unknown>, encoder: SseStreamEncoder) {
  return encoder.encodeCause(cause).pipe(
    Effect.orDie,
    Effect.map((encodedCause) => ({
      id: undefined,
      event: reservedStreamFailureEvent,
      data: encodedCause
    }))
  )
}

const reservedStreamFailureEvent = "effect/httpapi/stream/failure"

function renderSseEvent(event: Sse.EventEncoded) {
  return Sse.encoder.write({
    _tag: "Event",
    event: event.event,
    id: event.id,
    data: event.data
  })
}

const toResponseSuccessSchema = toResponseSchema(HttpApiSchema.getStatusSuccess)
const toResponseErrorSchema = toResponseSchema(HttpApiSchema.getStatusError)

function makeSuccessSchema(
  endpoint: HttpApiEndpoint.Top
): Schema.ConstraintEncoder<HttpServerResponse, unknown> {
  const schemas = HttpApiEndpoint.getSuccessSchemas(endpoint).map(toResponseSuccessSchema)
  return schemas.length === 1 ? schemas[0] : Schema.Union(schemas)
}

function makeErrorSchema(
  endpoint: HttpApiEndpoint.Top
): Schema.ConstraintEncoder<HttpServerResponse, unknown> {
  const schemas = HttpApiEndpoint.getErrorSchemas(endpoint).map(toResponseErrorSchema)
  if (schemas.length === 0) return Schema.Never
  return schemas.length === 1 ? schemas[0] : Schema.Union(schemas)
}

function toResponseSchema(getStatus: (ast: SchemaAST.AST) => number) {
  const cache = new WeakMap<SchemaAST.AST, Schema.Top>()

  return (schema: Schema.Constraint): Schema.ConstraintEncoder<HttpServerResponse, unknown> => {
    const cached = cache.get(schema.ast)
    if (cached !== undefined) {
      return cached as any
    }
    const responseSchema = $HttpServerResponse.pipe(
      Schema.decodeTo(schema, getResponseTransformation(getStatus, schema))
    )
    cache.set(schema.ast, responseSchema)
    return responseSchema
  }
}

function getResponseTransformation(
  getStatus: (ast: SchemaAST.AST) => number,
  schema: Schema.Constraint
): SchemaTransformation.Transformation<unknown, Response.HttpServerResponse> {
  const ast = schema.ast
  const encode = getResponseEncode(
    getStatus(ast),
    HttpApiSchema.getResponseEncoding(ast),
    HttpApiSchema.isNoContent(ast)
  )

  return SchemaTransformation.transformOrFail({
    decode: (res) => Effect.fail(new SchemaIssue.Forbidden(Option.some(res), { message: "Encode only schema" })),
    encode
  })
}

function getResponseEncode<E>(
  status: number,
  encoding: HttpApiSchema.ResponseEncoding,
  isNoContent: boolean
): (e: E) => Effect.Effect<Response.HttpServerResponse, SchemaIssue.InvalidValue, never> {
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
          return Effect.fail(new SchemaIssue.InvalidValue(Option.some(e), { message: globalThis.String(error) }))
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
