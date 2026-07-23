/**
 * The `AtomHttpApi` module adapts typed `HttpApi` clients to the unstable atom
 * reactivity runtime. Use it to define a `Context.Service` whose generated HTTP
 * API client is available directly and whose endpoints can also be invoked as
 * atoms: `query` creates an atom of `AsyncResult` for reads, while `mutation`
 * creates an `AtomResultFn` for writes.
 *
 * It is intended for applications that want server state to participate in atom
 * caching, invalidation, and hydration. Queries can be associated with
 * `reactivityKeys` so they refresh when those keys are invalidated, mutations can
 * invalidate the same keys after the request succeeds, and `timeToLive` controls
 * whether idle query atoms expire, stay alive for a duration, or are kept alive.
 *
 * Serialization is schema-based and intentionally limited to decoded values.
 * Mutation atoms are serializable only in `"decoded-only"` mode, while query
 * atoms are serializable only in `"decoded-only"` mode when a stable
 * `serializationKey` is supplied. Choose serialization keys that uniquely
 * identify the endpoint request, keep reactivity keys stable across client and
 * server registries during hydration, and avoid serializing response modes that
 * expose raw `HttpClientResponse` values.
 *
 * The service wraps `HttpApiClient.make`, so the same `HttpApi` definition,
 * schemas, base URL, middleware services, and HTTP client layer must be available
 * wherever the atom runtime is constructed. Use `transformClient` and
 * `transformResponse` for cross-cutting client behavior, and remember that
 * schema or low-level HTTP client failures are raised as defects while endpoint
 * and middleware failures remain typed errors.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import type { ReadonlyRecord } from "../../Record.ts"
import * as Schema from "../../Schema.ts"
import type { SchemaError } from "../../Schema.ts"
import type { Mutable, Simplify } from "../../Types.ts"
import type * as HttpClient from "../http/HttpClient.ts"
import * as HttpClientError from "../http/HttpClientError.ts"
import type { HttpClientResponse } from "../http/HttpClientResponse.ts"
import type * as HttpApi from "../httpapi/HttpApi.ts"
import * as HttpApiClient from "../httpapi/HttpApiClient.ts"
import * as HttpApiEndpoint from "../httpapi/HttpApiEndpoint.ts"
import type * as HttpApiGroup from "../httpapi/HttpApiGroup.ts"
import type * as HttpApiMiddleware from "../httpapi/HttpApiMiddleware.ts"
import * as AsyncResult from "./AsyncResult.ts"
import * as Atom from "./Atom.ts"
import * as Reactivity from "./Reactivity.ts"

/**
 * A `Context.Service` for an HTTP API client integrated with atom reactivity.
 *
 * **Details**
 *
 * It exposes the generated HTTP API client, an atom runtime, mutation helpers that
 * return `AtomResultFn`s, and query helpers that return atoms of endpoint results.
 *
 * @category models
 * @since 4.0.0
 */
export interface AtomHttpApiClient<Self, Id extends string, Groups extends HttpApiGroup.Any>
  extends Context.Service<Self, HttpApiClient.Client<Groups, never, never>>
{
  new(_: never): Context.ServiceClass.Shape<Id, HttpApiClient.Client<Groups, never, never>>

  readonly runtime: Atom.AtomRuntime<Self>

  readonly mutation: <
    GroupName extends HttpApiGroup.Name<Groups>,
    Name extends HttpApiEndpoint.Name<HttpApiGroup.Endpoints<Group>>,
    Group extends HttpApiGroup.Any = HttpApiGroup.WithName<Groups, GroupName>,
    Endpoint extends HttpApiEndpoint.Any = HttpApiEndpoint.WithName<
      HttpApiGroup.Endpoints<Group>,
      Name
    >,
    const ResponseMode extends HttpApiEndpoint.ClientResponseMode = HttpApiEndpoint.ClientResponseMode
  >(
    group: GroupName,
    endpoint: Name,
    options?: {
      readonly responseMode?: ResponseMode | undefined
    }
  ) => [Endpoint] extends [
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
      infer _RE
    >
  ] ? Atom.AtomResultFn<
      Simplify<
        HttpApiEndpoint.ClientRequest<_Params, _Query, _Payload, _Headers, "decoded-only"> & {
          readonly reactivityKeys?: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
        }
      >,
      ResponseByMode<_Success["Type"], ResponseMode>,
      ErrorByMode<_Error, _Middleware, ResponseMode>
    >
    : never

  readonly query: <
    GroupName extends HttpApiGroup.Name<Groups>,
    Name extends HttpApiEndpoint.Name<HttpApiGroup.Endpoints<Group>>,
    Group extends HttpApiGroup.Any = HttpApiGroup.WithName<Groups, GroupName>,
    Endpoint extends HttpApiEndpoint.Any = HttpApiEndpoint.WithName<
      HttpApiGroup.Endpoints<Group>,
      Name
    >,
    const ResponseMode extends HttpApiEndpoint.ClientResponseMode = "decoded-only"
  >(
    group: GroupName,
    endpoint: Name,
    request: [Endpoint] extends [
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
        infer _R,
        infer _RE
      >
    ] ? Simplify<
        HttpApiEndpoint.ClientRequest<_Params, _Query, _Payload, _Headers, ResponseMode> & {
          readonly reactivityKeys?:
            | ReadonlyArray<unknown>
            | ReadonlyRecord<string, ReadonlyArray<unknown>>
            | undefined
          readonly timeToLive?: Duration.Input | undefined
          readonly serializationKey?: string | undefined
        }
      >
      : never
  ) => [Endpoint] extends [
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
      infer _RE
    >
  ] ? Atom.Atom<
      AsyncResult.AsyncResult<
        ResponseByMode<_Success["Type"], ResponseMode>,
        ErrorByMode<_Error, _Middleware, ResponseMode>
      >
    >
    : never
}

declare global {
  interface ErrorConstructor {
    stackTraceLimit: number
  }
}

/**
 * Creates a `Context.Service` class for an HTTP API client backed by an atom
 * runtime.
 *
 * **Details**
 *
 * The options provide the API definition, HTTP client layer, optional client and
 * response transforms, base URL, and runtime factory used by the query and
 * mutation helpers.
 *
 * @category constructors
 * @since 4.0.0
 */
export const Service = <Self>() =>
<const Id extends string, ApiId extends string, Groups extends HttpApiGroup.Any>(
  id: Id,
  options: {
    readonly api: HttpApi.HttpApi<ApiId, Groups>
    readonly httpClient:
      | Layer.Layer<
        | HttpApiGroup.ClientServices<Groups>
        | HttpClient.HttpClient
      >
      | ((get: Atom.AtomContext) => Layer.Layer<
        | HttpApiGroup.ClientServices<Groups>
        | HttpClient.HttpClient
      >)
    readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
    readonly transformResponse?:
      | ((effect: Effect.Effect<unknown, unknown, unknown>) => Effect.Effect<unknown, unknown, unknown>)
      | undefined
    readonly baseUrl?: URL | string | undefined
    readonly runtime?: Atom.RuntimeFactory | undefined
  }
): AtomHttpApiClient<Self, Id, Groups> => {
  const self: Mutable<AtomHttpApiClient<Self, Id, Groups>> = Context.Service<
    Self,
    HttpApiClient.Client<Groups, never, never>
  >()(id) as any

  const layer = Layer.effect(
    self,
    HttpApiClient.make(options.api, options)
  )
  const runtimeFactory = options.runtime ?? Atom.runtime
  self.runtime = runtimeFactory(
    typeof options.httpClient === "function" ?
      (get) =>
        Layer.provide(
          layer,
          (options.httpClient as (get: Atom.AtomContext) => Layer.Layer<
            | HttpApiGroup.ClientServices<Groups>
            | HttpClient.HttpClient
          >)(get)
        ) as Layer.Layer<Self> :
      Layer.provide(layer, options.httpClient) as Layer.Layer<Self>
  )

  const catchErrors = Effect.catch((e: unknown) =>
    Schema.isSchemaError(e) || HttpClientError.isHttpClientError(e) ? Effect.die(e) : Effect.fail(e)
  )

  const mutationFamily = Atom.family(({ endpoint, group, responseMode }: MutationKey) => {
    const atom = self.runtime.fn<{
      params: any
      query: any
      headers: any
      payload: any
      reactivityKeys?: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
    }>()(
      Effect.fnUntraced(function*(opts) {
        const client = (yield* self) as any
        const effect = catchErrors(client[group][endpoint]({
          ...opts,
          responseMode
        }) as Effect.Effect<any>)
        return yield* opts.reactivityKeys
          ? Reactivity.mutation(effect, opts.reactivityKeys)
          : effect
      })
    )
    if (responseMode === "decoded-only") {
      const definition = options.api.groups[group]!.endpoints[endpoint]! as HttpApiEndpoint.AnyWithProps
      return Atom.serializable(atom, {
        key: `AtomHttpApi:mutation:${group}:${endpoint}`,
        schema: AsyncResult.Schema({
          success: Schema.Union(HttpApiEndpoint.getSuccessSchemas(definition)),
          error: Schema.Union(HttpApiEndpoint.getErrorSchemas(definition))
        }) as any
      })
    }
    return atom
  }) as any

  self.mutation = ((group: string, endpoint: string, options?: {
    readonly responseMode?: HttpApiEndpoint.ClientResponseMode | undefined
  }) =>
    mutationFamily({
      group,
      endpoint,
      responseMode: options?.responseMode ?? "decoded-only"
    })) as any

  const queryFamily = Atom.family((opts: QueryKey) => {
    let atom = self.runtime.atom(self.use((client_) => {
      const client = client_ as any
      return catchErrors(client[opts.group][opts.endpoint](opts) as Effect.Effect<
        any,
        HttpClientError.HttpClientError | SchemaError
      >)
    }))
    if (opts.responseMode === "decoded-only" && opts.serializationKey) {
      const endpoint = options.api.groups[opts.group]!.endpoints[opts.endpoint]! as HttpApiEndpoint.AnyWithProps
      atom = Atom.serializable(atom, {
        key: `AtomHttpApi:${opts.group}:${opts.endpoint}:${opts.serializationKey}`,
        schema: AsyncResult.Schema({
          success: Schema.Union(HttpApiEndpoint.getSuccessSchemas(endpoint)),
          error: Schema.Union(HttpApiEndpoint.getErrorSchemas(endpoint))
        }) as any
      })
    }
    if (opts.timeToLive) {
      atom = Duration.isFinite(opts.timeToLive)
        ? Atom.setIdleTTL(atom, opts.timeToLive)
        : Atom.keepAlive(atom)
    }
    return opts.reactivityKeys
      ? self.runtime.factory.withReactivity(opts.reactivityKeys)(atom)
      : atom
  })

  self.query = ((
    group: string,
    endpoint: string,
    request: {
      readonly params?: any
      readonly query?: any
      readonly payload?: any
      readonly headers?: any
      readonly responseMode?: HttpApiEndpoint.ClientResponseMode
      readonly reactivityKeys?: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
      readonly timeToLive?: Duration.Input | undefined
      readonly serializationKey?: string | undefined
    }
  ) => {
    const key: QueryKey = {
      group,
      endpoint,
      params: request.params,
      query: request.query,
      payload: request.payload,
      headers: request.headers,
      responseMode: request.responseMode ?? "decoded-only",
      reactivityKeys: request.reactivityKeys,
      timeToLive: request.timeToLive
        ? Duration.fromInputUnsafe(request.timeToLive)
        : undefined,
      serializationKey: request.serializationKey
    }
    return queryFamily(key)
  }) as any

  return self as AtomHttpApiClient<Self, Id, Groups>
}

interface MutationKey {
  group: string
  endpoint: string
  responseMode: HttpApiEndpoint.ClientResponseMode
}

interface QueryKey {
  group: string
  endpoint: string
  params: any
  query: any
  headers: any
  payload: any
  responseMode: HttpApiEndpoint.ClientResponseMode
  reactivityKeys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>> | undefined
  timeToLive: Duration.Duration | undefined
  serializationKey: string | undefined
}

type ResponseByMode<Success, ResponseMode extends HttpApiEndpoint.ClientResponseMode> = [ResponseMode] extends
  ["decoded-and-response"] ? [Success, HttpClientResponse]
  : [ResponseMode] extends ["response-only"] ? HttpClientResponse
  : Success

type ErrorByMode<
  Error extends Schema.Top,
  Middleware,
  ResponseMode extends HttpApiEndpoint.ClientResponseMode
> =
  | HttpApiMiddleware.Error<Middleware>
  | HttpApiMiddleware.ClientError<Middleware>
  | ([ResponseMode] extends ["response-only"] ? never : Error["Type"])
