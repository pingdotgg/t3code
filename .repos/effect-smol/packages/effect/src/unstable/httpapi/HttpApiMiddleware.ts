/**
 * Declares middleware for schema-driven HTTP APIs.
 *
 * HTTP API middleware wraps endpoint execution on the server and, when the API
 * requires it, can also wrap requests made by generated clients. It is used for
 * cross-cutting behavior that belongs to the API contract, such as
 * authentication, authorization, logging, tracing, rate limiting,
 * request-scoped services, schema-error handling, and client request
 * decoration. This module defines the middleware service keys and helpers used
 * by `HttpApi` declarations.
 *
 * @since 4.0.0
 */
/** @effect-diagnostics floatingEffect:skip-file */
/** @effect-diagnostics classSelfMismatch:off */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import { getStackTraceLimit, setStackTraceLimit } from "../../internal/stackTraceLimit.ts"
import * as Layer from "../../Layer.ts"
import { hasProperty } from "../../Predicate.ts"
import type * as Schema from "../../Schema.ts"
import { Scope } from "../../Scope.ts"
import type { unhandled } from "../../Types.ts"
import type * as HttpClientError from "../http/HttpClientError.ts"
import type * as HttpClientRequest from "../http/HttpClientRequest.ts"
import type * as HttpClientResponse from "../http/HttpClientResponse.ts"
import type * as HttpRouter from "../http/HttpRouter.ts"
import type { HttpServerResponse } from "../http/HttpServerResponse.ts"
import type * as HttpApiEndpoint from "./HttpApiEndpoint.ts"
import { HttpApiSchemaError } from "./HttpApiError.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"
import type * as HttpApiSecurity from "./HttpApiSecurity.ts"

const TypeId = "~effect/httpapi/HttpApiMiddleware"

const SecurityTypeId = "~effect/httpapi/HttpApiMiddleware/Security"

/**
 * Returns `true` when an HTTP API middleware service is security middleware.
 *
 * @category guards
 * @since 4.0.0
 */
export const isSecurity = (u: AnyService): u is AnyServiceSecurity => hasProperty(u, SecurityTypeId)

type ErrorConstraint = Schema.Top | ReadonlyArray<Schema.Top>

type ErrorSchemaFromConstraint<E> = E extends ReadonlyArray<Schema.Constraint> ? E[number]
  : E extends Schema.Constraint ? E
  : never

/**
 * Server-side middleware function for an HTTP API endpoint.
 *
 * **Details**
 *
 * It receives the endpoint response effect and endpoint/group metadata, and returns
 * a new response effect that may require additional services and fail with the
 * middleware's declared error schema.
 *
 * @category models
 * @since 4.0.0
 */
export type HttpApiMiddleware<Provides, E extends ErrorConstraint, Requires> = (
  httpEffect: Effect.Effect<HttpServerResponse, unhandled, Provides>,
  options: {
    readonly endpoint: HttpApiEndpoint.Top
    readonly group: HttpApiGroup.Top
  }
) => Effect.Effect<HttpServerResponse, unhandled | ErrorSchemaFromConstraint<E>["Type"], Requires | HttpRouter.Provided>

/**
 * Server-side middleware implementations for one or more security schemes.
 *
 * **Details**
 *
 * Each property handles the credential decoded for that scheme and wraps the
 * endpoint response effect with the middleware's declared requirements and errors.
 *
 * @category models
 * @since 4.0.0
 */
export type HttpApiMiddlewareSecurity<
  Security extends Record<string, HttpApiSecurity.HttpApiSecurity>,
  Provides,
  E extends ErrorConstraint,
  Requires
> = {
  readonly [K in keyof Security]: (
    httpEffect: Effect.Effect<HttpServerResponse, unhandled, Provides>,
    options: {
      readonly credential: HttpApiSecurity.HttpApiSecurity.Type<Security[K]>
      readonly endpoint: HttpApiEndpoint.Top
      readonly group: HttpApiGroup.Top
    }
  ) => Effect.Effect<
    HttpServerResponse,
    unhandled | ErrorSchemaFromConstraint<E>["Type"],
    Requires | HttpRouter.Provided
  >
}

/**
 * Client-side middleware function for generated HTTP API clients.
 *
 * **Details**
 *
 * It receives endpoint/group metadata, the outgoing request, and a `next` function
 * for continuing the request pipeline.
 *
 * @category models
 * @since 4.0.0
 */
export interface HttpApiMiddlewareClient<_E, CE, R> {
  (options: {
    readonly endpoint: HttpApiEndpoint.Top
    readonly group: HttpApiGroup.Top
    readonly request: HttpClientRequest.HttpClientRequest
    readonly next: (
      request: HttpClientRequest.HttpClientRequest
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
  }): Effect.Effect<HttpClientResponse.HttpClientResponse, CE | HttpClientError.HttpClientError, R>
}

/**
 * Client-side service marker required when a middleware declares `requiredForClient`.
 *
 * @category models
 * @since 4.0.0
 */
export interface ForClient<Id> {
  readonly _: unique symbol
  readonly id: Id
}

/**
 * Base service key shape for HTTP API middleware services, including provided services, declared error schemas, and client requirements.
 *
 * @category models
 * @since 4.0.0
 */
export interface AnyService extends Context.Key<any, any> {
  readonly [TypeId]: typeof TypeId
  readonly provides: any
  readonly error: ReadonlySet<Schema.Top>
  readonly requiredForClient: boolean
  readonly "~ClientError": any
}

/**
 * Middleware service key shape for security middleware, including the security schemes handled by the service.
 *
 * @category models
 * @since 4.0.0
 */
export interface AnyServiceSecurity extends AnyService {
  readonly [SecurityTypeId]: typeof SecurityTypeId
  readonly security: Record<string, HttpApiSecurity.HttpApiSecurity>
}

/**
 * Type-level identifier carried by middleware services to track provided services, required services, errors, client errors, and client requirements.
 *
 * @category models
 * @since 4.0.0
 */
export interface AnyId {
  readonly [TypeId]: {
    readonly provides: any
    readonly requires: any
    readonly error: ErrorConstraint
    readonly clientError: any
    readonly requiredForClient: boolean
  }
}

/**
 * Extracts the services provided by a middleware identifier.
 *
 * @category models
 * @since 4.0.0
 */
export type Provides<A> = A extends { readonly [TypeId]: { readonly provides: infer P } } ? P : never

/**
 * Extracts the services required to run a middleware implementation.
 *
 * @category models
 * @since 4.0.0
 */
export type Requires<A> = A extends { readonly [TypeId]: { readonly requires: infer R } } ? R : never

/**
 * Applies a middleware's service changes to an existing requirement type by removing services it provides and adding services it requires.
 *
 * @category models
 * @since 4.0.0
 */
export type ApplyServices<A extends AnyId, R> = Exclude<R, Provides<A>> | Requires<A>

/**
 * Extracts the schema or schema union used for errors declared by a middleware identifier.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorSchema<A> = A extends { readonly [TypeId]: { readonly error: infer E } } ? ErrorSchemaFromConstraint<E>
  : never

/**
 * Extracts the decoded error type declared by a middleware identifier.
 *
 * @category models
 * @since 4.0.0
 */
export type Error<A> = ErrorSchema<A>["Type"]

/**
 * Extracts the client-side error type for middleware that is required on generated clients.
 *
 * @category models
 * @since 4.0.0
 */
export type ClientError<A> = A extends {
  readonly [TypeId]: {
    readonly clientError: infer CE
    readonly requiredForClient: true
  }
} ? CE
  : never

/**
 * Computes the client-side service marker required for middleware that must also run in generated clients.
 *
 * @category models
 * @since 4.0.0
 */
export type MiddlewareClient<A> = A extends {
  readonly [TypeId]: {
    readonly requiredForClient: true
  }
} ? ForClient<A>
  : never

/**
 * Extracts the schema services required to encode errors declared by a middleware identifier.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorServicesEncode<A> = ErrorSchema<A>["EncodingServices"]

/**
 * Extracts the schema services required to decode errors declared by a middleware identifier.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorServicesDecode<A> = ErrorSchema<A>["DecodingServices"]

/**
 * Class type produced by `Service` for an HTTP API middleware service.
 *
 * **Details**
 *
 * It combines a `Context.Service` class with the middleware metadata used by
 * endpoints, builders, and generated clients.
 *
 * @category schemas
 * @since 4.0.0
 */
export type ServiceClass<
  Self,
  Id extends string,
  Config extends {
    requires: any
    provides: any
    error: ErrorConstraint
    clientError: any
    requiredForClient: boolean
    security: Record<string, HttpApiSecurity.HttpApiSecurity>
  },
  Service =
    ([Config["security"]] extends [never] ? HttpApiMiddleware<Config["provides"], Config["error"], Config["requires"]>
      : HttpApiMiddlewareSecurity<Config["security"], Config["provides"], Config["error"], Config["requires"]>)
> =
  & Context.Service<Self, Service>
  & {
    new(_: never): Context.ServiceClass.Shape<Id, Service> & {
      readonly [TypeId]: {
        readonly error: Config["error"]
        readonly requires: Config["requires"]
        readonly provides: Config["provides"]
        readonly clientError: Config["clientError"]
        readonly requiredForClient: Config["requiredForClient"]
      }
    }
    readonly [TypeId]: typeof TypeId
    readonly error: ReadonlySet<Schema.Top>
    readonly requiredForClient: Config["requiredForClient"]
    readonly "~ClientError": Config["clientError"]
  }
  & ([keyof Config["security"]] extends [never] ? {} : {
    readonly [SecurityTypeId]: typeof SecurityTypeId
    readonly security: Config["security"]
  })

/**
 * Creates a `Context.Service` class for an HTTP API middleware implementation.
 *
 * **When to use**
 *
 * Use when you need an HTTP API middleware service whose configuration declares
 * required services, provided services, typed error schemas, security schemes,
 * client errors, or a matching client middleware requirement.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Service = <
  Self,
  Config extends {
    requires?: any
    provides?: any
    clientError?: any
  } = { requires: never; provides: never; clientError: never }
>(): <
  const Id extends string,
  const Error extends ErrorConstraint = never,
  const Security extends Record<string, HttpApiSecurity.HttpApiSecurity> = never,
  RequiredForClient extends boolean = false
>(
  id: Id,
  options?: {
    readonly error?: Error | undefined
    readonly security?: Security | undefined
    readonly requiredForClient?: RequiredForClient | undefined
  } | undefined
) => ServiceClass<Self, Id, {
  requires: "requires" extends keyof Config ? Config["requires"] : never
  provides: "provides" extends keyof Config ? Config["provides"] : never
  error: Error
  clientError: "clientError" extends keyof Config ? Config["clientError"] : never
  requiredForClient: RequiredForClient
  security: Security
}> =>
(
  id: string,
  options?: {
    readonly security?: Record<string, HttpApiSecurity.HttpApiSecurity> | undefined
    readonly error?: ErrorConstraint | undefined
    readonly requiredForClient?: boolean | undefined
  } | undefined
) => {
  const Err = globalThis.Error as any
  const limit = getStackTraceLimit()
  setStackTraceLimit(2)
  const creationError = new Err()
  setStackTraceLimit(limit)

  class Service extends Context.Service<Self, any>()(id) {}
  const self = Service as any
  Object.defineProperty(Service, "stack", {
    get() {
      return creationError.stack
    }
  })
  self[TypeId] = TypeId
  self.error = getError(options?.error)
  self.requiredForClient = options?.requiredForClient ?? false
  if (options?.security !== undefined) {
    if (Object.keys(options.security).length === 0) {
      throw new Error("HttpApiMiddleware.Service: security object must not be empty")
    }
    self[SecurityTypeId] = SecurityTypeId
    self.security = options.security
  }
  return self
}

function getError(error: ErrorConstraint | undefined): ReadonlySet<Schema.Top> {
  if (error === undefined) return new Set()
  return new Set(Array.isArray(error) ? error : [error])
}

/**
 * Creates a middleware layer that transforms `HttpApiSchemaError` failures.
 *
 * **Details**
 *
 * The middleware catches schema errors produced while running an endpoint and uses
 * the supplied `transform` function to convert them into the middleware's declared
 * error schema.
 *
 * **Example** (Mapping schema errors to custom errors)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { HttpApiMiddleware } from "effect/unstable/httpapi"
 *
 * export class CustomError extends Schema.TaggedErrorClass<CustomError>()("CustomError", {}) {}
 *
 * export class ErrorHandler extends HttpApiMiddleware.Service<ErrorHandler>()("api/ErrorHandler", {
 *   error: CustomError
 * }) {}
 *
 * export const ErrorHandlerLayer = HttpApiMiddleware.layerSchemaErrorTransform(
 *   ErrorHandler,
 *   (schemaError) =>
 *     Effect.log("Got SchemaError", schemaError).pipe(
 *       Effect.andThen(Effect.fail(new CustomError()))
 *     )
 * )
 * ```
 *
 * @category SchemaError transform
 * @since 4.0.0
 */
export const layerSchemaErrorTransform = <Id, E extends ErrorConstraint, Requires>(
  service: Context.Service<Id, HttpApiMiddleware<never, E, Requires>>,
  transform: (
    error: HttpApiSchemaError,
    context: {
      readonly endpoint: HttpApiEndpoint.Top
      readonly group: HttpApiGroup.Top
    }
  ) => Effect.Effect<
    HttpServerResponse,
    ErrorSchemaFromConstraint<E>["Type"] | HttpApiSchemaError,
    Requires | HttpRouter.Provided
  >
): Layer.Layer<Id> =>
  Layer.succeed(
    service,
    (httpEffect, options) =>
      Effect.catch(
        httpEffect,
        (e): Effect.Effect<
          HttpServerResponse,
          unhandled | HttpApiSchemaError | ErrorSchemaFromConstraint<E>["Type"],
          Requires | HttpRouter.Provided
        > => HttpApiSchemaError.is(e) ? transform(e, options) : Effect.fail(e)
      )
  )

/**
 * Provides a client-side middleware implementation for a middleware that is required by generated clients.
 *
 * **Details**
 *
 * The layer captures the surrounding services and makes the middleware available
 * through the `ForClient` service marker used by HTTP API clients.
 *
 * @category client
 * @since 4.0.0
 */
export const layerClient = <Id extends AnyId, S, R, EX = never, RX = never>(
  tag: Context.Key<Id, S>,
  service:
    | HttpApiMiddlewareClient<Error<Id>, Id[typeof TypeId]["clientError"], R>
    | Effect.Effect<
      HttpApiMiddlewareClient<Error<Id>, Id[typeof TypeId]["clientError"], R>,
      EX,
      RX
    >
): Layer.Layer<ForClient<Id>, EX, R | Exclude<RX, Scope>> =>
  Layer.effectContext(Effect.gen(function*() {
    const services = (yield* Effect.context<R | Scope>()).pipe(
      Context.omit(Scope)
    ) as Context.Context<R>
    const middleware = Effect.isEffect(service) ? yield* service : service
    return Context.makeUnsafe(
      new Map([[
        `${tag.key}/Client`,
        (options: any) =>
          Effect.updateContext(
            middleware(options),
            (requestContext) => Context.merge(services, requestContext)
          )
      ]])
    )
  }))
