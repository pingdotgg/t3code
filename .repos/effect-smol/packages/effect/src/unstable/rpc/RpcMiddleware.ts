/**
 * Middleware services for the unstable RPC runtime.
 *
 * A middleware service wraps server handler execution and can also install a
 * client-side wrapper for generated clients. Its metadata records the services
 * provided to downstream handlers, the services required by the middleware
 * implementation, the schema for server-visible failures, the client-only error
 * type, and whether generated clients must require the matching client layer.
 *
 * **Mental model**
 *
 * A server {@link RpcMiddleware} receives the target RPC, decoded payload,
 * request headers, request id, and `Rpc.ServerClient`, then wraps the handler
 * effect. `provides` removes services from the downstream handler requirement,
 * while `requires` adds the services needed by the middleware. A client
 * {@link RpcMiddlewareClient} is installed with {@link layerClient}; it can
 * inspect, rewrite, retry, or short-circuit outgoing requests before calling
 * `next`.
 *
 * **Common tasks**
 *
 * Use {@link Service} to define authentication, authorization, logging,
 * tracing, metrics, rate limiting, header propagation, or request-scoped
 * service injection. Attach the service to individual RPCs or whole groups,
 * then provide the server implementation like any other `Context.Service`.
 * Provide a client implementation with {@link layerClient} when outgoing
 * requests need matching behavior.
 *
 * **Gotchas**
 *
 * Middleware failures that cross the RPC boundary must be declared with a
 * `Schema`, and any encoding or decoding services required by that schema stay
 * in the generated RPC environments. `clientError` contributes only to the
 * client-side call error channel, while the middleware `error` schema is shared
 * with server failures. Set `requiredForClient` only when typed clients must
 * reject calls unless the matching client middleware layer is installed.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import * as Schema from "../../Schema.ts"
import { Scope } from "../../Scope.ts"
import type { Mutable, unhandled } from "../../Types.ts"
import type { Headers } from "../http/Headers.ts"
import type * as Rpc from "./Rpc.ts"
import type { Request, RequestId } from "./RpcMessage.ts"

/**
 * The literal type id used to identify RPC middleware service classes.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~effect/rpc/RpcMiddleware"

/**
 * The runtime type id used to attach and inspect RPC middleware metadata.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~effect/rpc/RpcMiddleware"

/**
 * The server-side RPC middleware function shape, wrapping a handler effect with
 * access to request metadata and translating provided services into required
 * services.
 *
 * @category models
 * @since 4.0.0
 */
export interface RpcMiddleware<Provides, E, Requires> {
  (
    effect: Effect.Effect<SuccessValue, E | unhandled, Provides>,
    options: {
      readonly client: Rpc.ServerClient
      readonly requestId: RequestId
      readonly rpc: Rpc.AnyWithProps
      readonly payload: unknown
      readonly headers: Headers
    }
  ): Effect.Effect<SuccessValue, unhandled | E, Requires | Scope>
}

/**
 * Marker success type used by RPC middleware to represent successful completion
 * without exposing the handler's concrete success value.
 *
 * @category models
 * @since 4.0.0
 */
export interface SuccessValue {
  readonly _: unique symbol
}

/**
 * The client-side RPC middleware function shape, allowing outgoing requests to
 * be inspected or modified before calling `next`.
 *
 * @category models
 * @since 4.0.0
 */
export interface RpcMiddlewareClient<E, CE, R> {
  (options: {
    readonly rpc: Rpc.AnyWithProps
    readonly request: Request<Rpc.Any>
    readonly next: (request: Request<Rpc.Any>) => Effect.Effect<SuccessValue, unhandled | E>
  }): Effect.Effect<SuccessValue, unhandled | E | CE, R>
}

/**
 * Marker service requirement indicating that a middleware has a client-side
 * implementation available for an RPC client.
 *
 * @category models
 * @since 4.0.0
 */
export interface ForClient<Id> {
  readonly _: unique symbol
  readonly id: Id
}

/**
 * An erased server-side RPC middleware function, useful when the concrete
 * provided services, errors, and requirements are not needed.
 *
 * @category models
 * @since 4.0.0
 */
export interface Any {
  (
    effect: Effect.Effect<SuccessValue, any, any>,
    options: {
      readonly client: Rpc.ServerClient
      readonly requestId: RequestId
      readonly rpc: Rpc.AnyWithProps
      readonly payload: unknown
      readonly headers: Headers
    }
  ): Effect.Effect<SuccessValue, any, any>
}

/**
 * A type-level carrier for RPC middleware metadata, including provided
 * services, required services, error schema, and client error type.
 *
 * @category models
 * @since 4.0.0
 */
export interface AnyId {
  readonly [TypeId]: {
    readonly provides: any
    readonly requires: any
    readonly error: Schema.Top
    readonly clientError: any
  }
}

/**
 * The `Context.Service` class shape created for an RPC middleware, including
 * its error schema, service metadata, and client-side requirement marker.
 *
 * @category models
 * @since 4.0.0
 */
export interface ServiceClass<
  Self,
  Name extends string,
  Provides,
  E extends Schema.Top,
  ClientError,
  Requires,
  RequiredForClient extends boolean
> extends Context.Service<Self, RpcMiddleware<Provides, E["Type"], Requires>> {
  new(_: never): Context.ServiceClass.Shape<Name, RpcMiddleware<Provides, E["Type"], Requires>> & {
    readonly [TypeId]: {
      readonly error: E
      readonly provides: Provides
      readonly requires: Requires
      readonly clientError: ClientError
    }
  }
  readonly [TypeId]: typeof TypeId
  readonly error: E
  readonly requiredForClient: RequiredForClient
  readonly "~ClientError": ClientError
}

/**
 * Extracts the services provided by an RPC middleware.
 *
 * @category models
 * @since 4.0.0
 */
export type Provides<A> = A extends { readonly [TypeId]: { readonly provides: infer P } } ? P : never

/**
 * Extracts the services required by an RPC middleware.
 *
 * @category models
 * @since 4.0.0
 */
export type Requires<A> = A extends { readonly [TypeId]: { readonly requires: infer R } } ? R : never

/**
 * Applies a middleware's service transformation to an RPC environment by
 * removing services the middleware provides and adding services it requires.
 *
 * @category models
 * @since 4.0.0
 */
export type ApplyServices<A, R> = Exclude<R, Provides<A>> | Requires<A>

/**
 * Extracts the error schema associated with an RPC middleware.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorSchema<A> = A extends { readonly [TypeId]: { readonly error: infer E } }
  ? E extends Schema.Top ? E : never
  : never

/**
 * Extracts the decoded error type produced by an RPC middleware.
 *
 * @category models
 * @since 4.0.0
 */
export type Error<A> = ErrorSchema<A>["Type"]

/**
 * Extracts the encoding services required by a middleware's error schema.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorServicesEncode<A> = ErrorSchema<A>["EncodingServices"]

/**
 * Extracts the decoding services required by a middleware's error schema.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorServicesDecode<A> = ErrorSchema<A>["DecodingServices"]

/**
 * An erased RPC middleware context key carrying middleware metadata.
 *
 * @category models
 * @since 4.0.0
 */
export interface AnyService extends Context.Key<any, any> {
  readonly [TypeId]: typeof TypeId
  readonly error: Schema.Top
  readonly requiredForClient: boolean
  readonly "~ClientError": any
}

/**
 * An erased RPC middleware context key whose service value is a server-side
 * middleware function.
 *
 * @category models
 * @since 4.0.0
 */
export interface AnyServiceWithProps extends Context.Key<any, RpcMiddleware<any, any, any>> {
  readonly [TypeId]: typeof TypeId
  readonly error: Schema.Top
  readonly requiredForClient: boolean
  readonly "~ClientError": any
}

/**
 * Creates a typed RPC middleware service class, with optional service
 * requirements, provided services, error schema, and client-side requirement
 * metadata.
 *
 * @category tags
 * @since 4.0.0
 */
export const Service = <
  Self,
  Config extends {
    requires?: any
    provides?: any
    clientError?: any
  } = {
    requires: never
    provides: never
    clientError: never
  }
>(): <
  const Name extends string,
  Error extends Schema.Top = Schema.Never,
  const RequiredForClient extends boolean = false
>(
  id: Name,
  options?: {
    readonly error?: Error | undefined
    readonly requiredForClient?: RequiredForClient | undefined
  } | undefined
) => ServiceClass<
  Self,
  Name,
  "provides" extends keyof Config ? Config["provides"] : never,
  Error,
  "clientError" extends keyof Config ? Config["clientError"] : never,
  "requires" extends keyof Config ? Config["requires"] : never,
  RequiredForClient
> =>
(
  id: string,
  options?: {
    readonly error?: Schema.Top | undefined
    readonly requiredForClient?: boolean | undefined
  }
) => {
  const Err = globalThis.Error as any
  const limit = Err.stackTraceLimit
  Err.stackTraceLimit = 2
  const creationError = new Err()
  Err.stackTraceLimit = limit

  function ServiceClass() {}
  const ServiceClass_ = ServiceClass as any as Mutable<AnyService>
  Object.setPrototypeOf(ServiceClass, Object.getPrototypeOf(Context.Service<Self, any>(id)))
  ServiceClass.key = id
  Object.defineProperty(ServiceClass, "stack", {
    get() {
      return creationError.stack
    }
  })
  ServiceClass_[TypeId] = TypeId
  ServiceClass_.error = options?.error ?? Schema.Never
  ServiceClass_.requiredForClient = options?.requiredForClient ?? false
  return ServiceClass as any
}

/**
 * Provides the client-side implementation for an RPC middleware service,
 * capturing the layer's environment and merging it into each middleware
 * invocation.
 *
 * @category client
 * @since 4.0.0
 */
export const layerClient = <Id extends AnyId, S, R, EX = never, RX = never>(
  tag: Context.Key<Id, S>,
  service:
    | RpcMiddlewareClient<Id[TypeId]["error"]["Type"], Id[TypeId]["clientError"], R>
    | Effect.Effect<RpcMiddlewareClient<Id[TypeId]["error"]["Type"], Id[TypeId]["clientError"], R>, EX, RX>
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
