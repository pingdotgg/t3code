/**
 * Defines named collections of `HttpApiEndpoint`s inside an `HttpApi`.
 *
 * A group is the boundary for endpoints that belong to the same resource,
 * feature area, or domain concern. Builders, generated clients, URL builders,
 * and OpenAPI generation read the same group value, including its identifier,
 * endpoint set, annotations, and `topLevel` flag.
 *
 * **Mental model**
 *
 * Start with {@link make}, add endpoints, then apply group-wide transforms such
 * as `prefix`, `middleware`, or endpoint annotations. A regular group becomes a
 * named namespace in generated clients. A `topLevel` group exposes its endpoint
 * methods directly on the client.
 *
 * **Common tasks**
 *
 * Use this module to collect related endpoints, share a path prefix or
 * middleware across the current endpoint set, attach metadata to the group or to
 * each current endpoint, and derive group-level types for builders and generated
 * clients.
 *
 * **Gotchas**
 *
 * Adding an endpoint with the same name as an existing endpoint replaces it.
 * `prefix`, `middleware`, `annotateEndpoints`, and `annotateEndpointsMerge`
 * affect only endpoints that are already present when those APIs are called.
 * Group annotations stay on the group; use endpoint annotation helpers when
 * metadata must be attached to each endpoint.
 *
 * **See also**
 *
 * `HttpApiEndpoint` for individual route contracts, `HttpApi` for composing
 * groups into a complete API, and `HttpApiBuilder` for supplying
 * implementations.
 *
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import * as Context from "../../Context.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import * as Record from "../../Record.ts"
import type { PathInput } from "../http/HttpRouter.ts"
import type * as HttpApiEndpoint from "./HttpApiEndpoint.ts"
import type * as HttpApiMiddleware from "./HttpApiMiddleware.ts"

const TypeId = "~effect/httpapi/HttpApiGroup"

/**
 * Returns `true` when a value is an `HttpApiGroup`, narrowing the value to the
 * group interface.
 *
 * @category guards
 * @since 4.0.0
 */
export const isHttpApiGroup = (u: unknown): u is Any => Predicate.hasProperty(u, TypeId)

/**
 * An `HttpApiGroup` is a named collection of `HttpApiEndpoint`s that represents
 * a portion of your domain.
 *
 * **Details**
 *
 * Endpoint implementations can be provided later with `HttpApiBuilder.group`.
 *
 * @category models
 * @since 4.0.0
 */
export interface HttpApiGroup<
  out Id extends string,
  out Endpoints extends HttpApiEndpoint.Any = never,
  out TopLevel extends boolean = false
> extends Pipeable {
  new(_: never): {}
  readonly [TypeId]: typeof TypeId
  readonly identifier: Id
  readonly key: string
  readonly topLevel: TopLevel
  readonly endpoints: Record.ReadonlyRecord<string, Endpoints>
  readonly annotations: Context.Context<never>

  /**
   * Add an `HttpApiEndpoint` to an `HttpApiGroup`.
   */
  add<A extends NonEmptyReadonlyArray<HttpApiEndpoint.Any>>(
    ...endpoints: A
  ): HttpApiGroup<Id, Endpoints | A[number], TopLevel>

  /**
   * Add a path prefix to all endpoints in an `HttpApiGroup`. Note that this will only
   * add the prefix to the endpoints before this api is called.
   */
  prefix<const Prefix extends PathInput>(
    prefix: Prefix
  ): HttpApiGroup<Id, HttpApiEndpoint.AddPrefix<Endpoints, Prefix>, TopLevel>

  /**
   * Adds an `HttpApiMiddleware` to every endpoint currently in the group.
   *
   * **Gotchas**
   *
   * Endpoints added after this method is called do not have the middleware
   * applied.
   */
  middleware<I extends HttpApiMiddleware.AnyId, S>(middleware: Context.Key<I, S>): HttpApiGroup<
    Id,
    HttpApiEndpoint.AddMiddleware<Endpoints, I>,
    TopLevel
  >

  /**
   * Merge the annotations of an `HttpApiGroup` with the provided annotations.
   */
  annotateMerge<I>(annotations: Context.Context<I>): HttpApiGroup<Id, Endpoints, TopLevel>

  /**
   * Add an annotation to an `HttpApiGroup`.
   */
  annotate<I, S>(key: Context.Key<I, S>, value: S): HttpApiGroup<Id, Endpoints, TopLevel>

  /**
   * Merges the provided context into every endpoint currently in the group.
   *
   * **Gotchas**
   *
   * Endpoints added after this method is called do not have these annotations.
   */
  annotateEndpointsMerge<I>(annotations: Context.Context<I>): HttpApiGroup<Id, Endpoints, TopLevel>

  /**
   * Adds an annotation to every endpoint currently in the group.
   *
   * **Gotchas**
   *
   * Endpoints added after this method is called do not have this annotation.
   */
  annotateEndpoints<I, S>(key: Context.Key<I, S>, value: S): HttpApiGroup<Id, Endpoints, TopLevel>
}

/**
 * Type-level identity for a group within an HTTP API, pairing the API id with the
 * group name for service derivation.
 *
 * @category models
 * @since 4.0.0
 */
export interface ApiGroup<ApiId extends string, Name extends string> {
  readonly _: unique symbol
  readonly apiId: ApiId
  readonly name: Name
}

/**
 * A widened `HttpApiGroup` type used when the concrete group name, endpoints, and
 * top-level flag are not needed.
 *
 * @category models
 * @since 4.0.0
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
  readonly identifier: string
  readonly key: string
  readonly endpoints: Record.ReadonlyRecord<string, HttpApiEndpoint.Any>
}

/**
 * A widened group type that preserves concrete runtime properties such as
 * identifier, key, top-level status, endpoints, and annotations.
 *
 * @category models
 * @since 4.0.0
 */
export type AnyWithProps = HttpApiGroup<string, HttpApiEndpoint.AnyWithProps, boolean>

/**
 * Derives the API-specific `ApiGroup` service identity for an HTTP API group.
 *
 * @category models
 * @since 4.0.0
 */
export type ToService<ApiId extends string, A> = A extends HttpApiGroup<infer Name, infer _Endpoints, infer _TopLevel> ?
  ApiGroup<ApiId, Name>
  : never

/**
 * Selects the group with the specified identifier from a union of groups.
 *
 * @category models
 * @since 4.0.0
 */
export type WithName<Group, Name extends string> = Extract<Group, { readonly identifier: Name }>

/**
 * Extracts the identifier literal from an `HttpApiGroup`.
 *
 * @category models
 * @since 4.0.0
 */
export type Name<Group> = Group extends HttpApiGroup<infer _Name, infer _Endpoints, infer _TopLevel> ? _Name
  : never

/**
 * Extracts the endpoint union contained in an `HttpApiGroup`.
 *
 * @category models
 * @since 4.0.0
 */
export type Endpoints<Group> = Group extends HttpApiGroup<infer _Name, infer _Endpoints, infer _TopLevel> ? _Endpoints
  : never

/**
 * Computes the services required to encode error responses for every endpoint in a
 * group.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorServicesEncode<Group> = HttpApiEndpoint.ErrorServicesEncode<Endpoints<Group>>

/**
 * Computes the services required to decode error responses for every endpoint in a
 * group.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorServicesDecode<Group> = HttpApiEndpoint.ErrorServicesDecode<Endpoints<Group>>

/**
 * Computes the middleware error union for every endpoint in a group.
 *
 * @category models
 * @since 4.0.0
 */
export type MiddlewareError<Group> = HttpApiEndpoint.MiddlewareError<Endpoints<Group>>

/**
 * Computes the services provided by middleware attached to any endpoint in a
 * group.
 *
 * @category models
 * @since 4.0.0
 */
export type MiddlewareProvides<Group> = HttpApiEndpoint.MiddlewareProvides<Endpoints<Group>>

/**
 * Computes the client-side middleware services required by endpoints in a group.
 *
 * @category models
 * @since 4.0.0
 */
export type MiddlewareClient<Group> = HttpApiEndpoint.MiddlewareClient<Endpoints<Group>>

/**
 * Extracts the runtime services required by middleware attached to the endpoints in an `HttpApiGroup`.
 *
 * @category models
 * @since 4.0.0
 */
export type MiddlewareServices<Group> = HttpApiEndpoint.MiddlewareServices<Endpoints<Group>>

/**
 * Selects the endpoints in a group whose `name` matches the provided endpoint name.
 *
 * @category models
 * @since 4.0.0
 */
export type EndpointsWithName<Group extends Any, Name extends string> = Endpoints<WithName<Group, Name>>

/**
 * Computes the schema encoding and decoding services required by clients for all endpoints in a group.
 *
 * @category models
 * @since 4.0.0
 */
export type ClientServices<Group> = Group extends HttpApiGroup<infer _Name, infer _Endpoints, infer _TopLevel> ?
  HttpApiEndpoint.ClientServices<_Endpoints>
  : never

/**
 * Returns the type of a group after adding the supplied path prefix to each endpoint in the group.
 *
 * @category models
 * @since 4.0.0
 */
export type AddPrefix<Group, Prefix extends PathInput> = Group extends
  HttpApiGroup<infer _Name, infer _Endpoints, infer _TopLevel> ?
  HttpApiGroup<_Name, HttpApiEndpoint.AddPrefix<_Endpoints, Prefix>, _TopLevel>
  : never

/**
 * Returns the type of a group after applying a middleware identifier to every endpoint in the group.
 *
 * @category models
 * @since 4.0.0
 */
export type AddMiddleware<Group, Id extends HttpApiMiddleware.AnyId> = Group extends
  HttpApiGroup<infer _Name, infer _Endpoints, infer _TopLevel> ?
  HttpApiGroup<_Name, HttpApiEndpoint.AddMiddleware<_Endpoints, Id>, _TopLevel>
  : never

const Proto = {
  [TypeId]: TypeId,
  add(this: AnyWithProps, ...toAdd: NonEmptyReadonlyArray<HttpApiEndpoint.AnyWithProps>) {
    const endpoints = { ...this.endpoints }
    for (const endpoint of toAdd) {
      endpoints[endpoint.name] = endpoint
    }
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints,
      annotations: this.annotations
    })
  },
  prefix(this: AnyWithProps, prefix: PathInput) {
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints: Record.map(this.endpoints, (endpoint) => endpoint.prefix(prefix)),
      annotations: this.annotations
    })
  },
  middleware(this: AnyWithProps, middleware: HttpApiMiddleware.AnyService) {
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints: Record.map(this.endpoints, (endpoint) => endpoint.middleware(middleware as any)),
      annotations: this.annotations
    })
  },
  annotateMerge<I>(this: AnyWithProps, annotations: Context.Context<I>) {
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints: this.endpoints,
      annotations: Context.merge(this.annotations, annotations)
    })
  },
  annotate<I, S>(this: AnyWithProps, annotation: Context.Key<I, S>, value: S) {
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints: this.endpoints,
      annotations: Context.add(this.annotations, annotation, value)
    })
  },
  annotateEndpointsMerge<I>(this: AnyWithProps, annotations: Context.Context<I>) {
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints: Record.map(this.endpoints, (endpoint) => endpoint.annotateMerge(annotations)),
      annotations: this.annotations
    })
  },
  annotateEndpoints<I, S>(this: AnyWithProps, annotation: Context.Key<I, S>, value: S) {
    return makeProto({
      identifier: this.identifier,
      topLevel: this.topLevel,
      endpoints: Record.map(this.endpoints, (endpoint) => endpoint.annotate(annotation, value)),
      annotations: this.annotations
    })
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

const makeProto = <
  Id extends string,
  Endpoints extends HttpApiEndpoint.Any,
  TopLevel extends (true | false)
>(options: {
  readonly identifier: Id
  readonly topLevel: TopLevel
  readonly endpoints: Record.ReadonlyRecord<string, Endpoints>
  readonly annotations: Context.Context<never>
}): HttpApiGroup<Id, Endpoints, TopLevel> => {
  function HttpApiGroup() {}
  Object.setPrototypeOf(HttpApiGroup, Proto)
  HttpApiGroup.key = `effect/httpapi/HttpApiGroup/${options.identifier}`
  return Object.assign(HttpApiGroup, options) as any
}

/**
 * Creates an empty `HttpApiGroup` with the supplied identifier.
 *
 * **Details**
 *
 * Add endpoints with `add`, provide implementations with `HttpApiBuilder.group`,
 * and set `topLevel` when the generated client should expose endpoint methods
 * directly instead of nesting them under the group name.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <const Id extends string, const TopLevel extends boolean = false>(identifier: Id, options?: {
  readonly topLevel?: TopLevel | undefined
}): HttpApiGroup<Id, never, TopLevel> =>
  makeProto({
    identifier,
    topLevel: options?.topLevel ?? false as any,
    endpoints: Record.empty(),
    annotations: Context.empty()
  }) as any
