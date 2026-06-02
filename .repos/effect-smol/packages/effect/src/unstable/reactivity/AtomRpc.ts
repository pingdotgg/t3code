/**
 * The `AtomRpc` module connects typed RPC clients to the atom reactivity
 * runtime. It builds a `Context.Service` that exposes the flattened
 * `RpcClient`, an `AtomRuntime`, mutation helpers, and query helpers for every
 * RPC in an `RpcGroup`.
 *
 * Use it when remote read models should be represented as atoms, mutations
 * should refresh affected reads through `Reactivity` keys, or non-streaming
 * query results need serialization metadata for hydration. The RPC `protocol`
 * layer supplies the transport, and may be static or derived from the current
 * atom context, so request headers, transport dependencies, and client
 * middleware remain part of the normal Effect environment.
 *
 * Non-streaming queries produce atoms of `AsyncResult` values. Supplying a
 * `serializationKey` marks those query atoms as serializable using codecs
 * derived from the RPC success schema and the combined RPC, middleware, and
 * client error schemas; choose stable, unique keys when dehydrating. Streaming
 * RPCs produce writable pull atoms instead, so callers advance the stream by
 * writing to the atom and should not expect serialization metadata. Query family
 * caching includes the payload, normalized headers, reactivity keys, TTL, and
 * serialization key, so use stable values for those inputs when atom identity
 * matters.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import * as Layer from "../../Layer.ts"
import type { ReadonlyRecord } from "../../Record.ts"
import * as Schema from "../../Schema.ts"
import type { Scope } from "../../Scope.ts"
import * as Stream from "../../Stream.ts"
import type { Mutable, NoInfer } from "../../Types.ts"
import * as Headers from "../http/Headers.ts"
import type * as Rpc from "../rpc/Rpc.ts"
import * as RpcClient from "../rpc/RpcClient.ts"
import { RpcClientError } from "../rpc/RpcClientError.ts"
import type * as RpcGroup from "../rpc/RpcGroup.ts"
import type { RequestId } from "../rpc/RpcMessage.ts"
import * as RpcSchema from "../rpc/RpcSchema.ts"
import * as AsyncResult from "./AsyncResult.ts"
import * as Atom from "./Atom.ts"
import * as Reactivity from "./Reactivity.ts"

/**
 * A `Context.Service` for a flattened RPC client integrated with atom reactivity.
 *
 * **Details**
 *
 * It exposes the RPC client, an atom runtime, mutation helpers that return `AtomResultFn`s, and query helpers that
 * return atoms or pull atoms for RPC results.
 *
 * @category models
 * @since 4.0.0
 */
export interface AtomRpcClient<Self, Id extends string, Rpcs extends Rpc.Any> extends
  Context.Service<
    Self,
    RpcClient.RpcClient.Flat<Rpcs, RpcClientError>
  >
{
  new(_: never): Context.ServiceClass.Shape<
    Id,
    RpcClient.RpcClient.Flat<Rpcs, RpcClientError>
  >

  readonly runtime: Atom.AtomRuntime<Self>

  readonly mutation: <Tag extends Rpc.Tag<Rpcs>>(
    arg: Tag
  ) => Rpc.ExtractTag<Rpcs, Tag> extends Rpc.Rpc<
    infer _Tag,
    infer _Payload,
    infer _Success,
    infer _Error,
    infer _Middleware,
    infer _Requires
  > ? [_Success] extends [RpcSchema.Stream<infer _A, infer _E>] ? never
    : Atom.AtomResultFn<
      {
        readonly payload: Rpc.PayloadConstructor<Rpc.ExtractTag<Rpcs, Tag>>
        readonly reactivityKeys?:
          | ReadonlyArray<unknown>
          | ReadonlyRecord<string, ReadonlyArray<unknown>>
          | undefined
        readonly headers?: Headers.Input | undefined
      },
      _Success["Type"],
      _Error["Type"] | RpcClientError | _Middleware["error"]["Type"]
    >
    : never

  readonly query: <Tag extends Rpc.Tag<Rpcs>>(
    tag: Tag,
    payload: Rpc.PayloadConstructor<Rpc.ExtractTag<Rpcs, Tag>>,
    options?: {
      readonly headers?: Headers.Input | undefined
      readonly reactivityKeys?:
        | ReadonlyArray<unknown>
        | ReadonlyRecord<string, ReadonlyArray<unknown>>
        | undefined
      readonly timeToLive?: Duration.Input | undefined
      readonly serializationKey?: string | undefined
    }
  ) => Rpc.ExtractTag<Rpcs, Tag> extends Rpc.Rpc<
    infer _Tag,
    infer _Payload,
    infer _Success,
    infer _Error,
    infer _Middleware
  > ? [_Success] extends [RpcSchema.Stream<infer _A, infer _E>] ? Atom.Writable<
        Atom.PullResult<
          _A["Type"],
          _E["Type"] | _Error["Type"] | RpcClientError | _Middleware["error"]["Type"]
        >,
        void
      >
    : Atom.Atom<
      AsyncResult.AsyncResult<
        _Success["Type"],
        _Error["Type"] | RpcClientError | _Middleware["error"]["Type"]
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
 * Creates a `Context.Service` class for an RPC client backed by an atom runtime.
 *
 * **Details**
 *
 * The options provide the RPC group, protocol layer, tracing options, request id generation, optional custom client
 * effect, and runtime factory used by the query and mutation helpers.
 *
 * @category constructors
 * @since 4.0.0
 */
export const Service = <Self>() =>
<
  const Id extends string,
  Rpcs extends Rpc.Any,
  ER,
  RM =
    | RpcClient.Protocol
    | Rpc.MiddlewareClient<NoInfer<Rpcs>>
    | Rpc.ServicesClient<NoInfer<Rpcs>>
>(
  id: Id,
  options: {
    readonly group: RpcGroup.RpcGroup<Rpcs>
    readonly protocol:
      | Layer.Layer<Exclude<NoInfer<RM>, Scope>, ER>
      | ((get: Atom.AtomContext) => Layer.Layer<Exclude<NoInfer<RM>, Scope>, ER>)
    readonly spanPrefix?: string | undefined
    readonly spanAttributes?: Record<string, unknown> | undefined
    readonly generateRequestId?: (() => RequestId) | undefined
    readonly disableTracing?: boolean | undefined
    readonly makeEffect?:
      | Effect.Effect<
        RpcClient.RpcClient.Flat<Rpcs, RpcClientError>,
        never,
        RM
      >
      | undefined
    readonly runtime?: Atom.RuntimeFactory | undefined
  }
): AtomRpcClient<Self, Id, Rpcs> => {
  const self: Mutable<AtomRpcClient<Self, Id, Rpcs>> = Context.Service<
    Self,
    RpcClient.RpcClient.Flat<Rpcs, RpcClientError>
  >()(id) as any

  const layer = Layer.effect(
    self,
    options.makeEffect ??
      (RpcClient.make(options.group, {
        ...options,
        flatten: true
      }) as Effect.Effect<
        RpcClient.RpcClient.Flat<Rpcs, RpcClientError>,
        never,
        RM
      >)
  )
  const runtimeFactory = options.runtime ?? Atom.runtime
  self.runtime = runtimeFactory(
    typeof options.protocol === "function" ?
      (get) =>
        Layer.provide(
          layer,
          Layer.orDie(
            (options.protocol as ((get: Atom.AtomContext) => Layer.Layer<Exclude<NoInfer<RM>, Scope>, ER>))(get)
          )
        ) :
      Layer.provide(layer, Layer.orDie(options.protocol))
  )

  self.mutation = Atom.family(<Tag extends Rpc.Tag<Rpcs>>(tag: Tag) => {
    const rpc = options.group.requests.get(tag)! as any as Rpc.AnyWithProps
    return self.runtime.fn<{
      readonly payload: Rpc.PayloadConstructor<Rpc.ExtractTag<Rpcs, Tag>>
      readonly reactivityKeys?:
        | ReadonlyArray<unknown>
        | ReadonlyRecord<string, ReadonlyArray<unknown>>
        | undefined
      readonly headers?: Headers.Input | undefined
    }>()(
      Effect.fnUntraced(function*({ headers, payload, reactivityKeys }) {
        const client = yield* self
        const effect = client(tag, payload, { headers } as any)
        return yield* (reactivityKeys
          ? Reactivity.mutation(effect, reactivityKeys) as Effect.Effect<any>
          : effect as any as Effect.Effect<any>)
      })
    ).pipe(
      Atom.serializable({
        key: `AtomRpc:mutation:${tag}`,
        schema: AsyncResult.Schema({
          success: rpc.successSchema,
          error: makeErrorSchema(rpc)
        }) as any
      })
    )
  }) as any

  const queryFamily = Atom.family(
    (key: QueryKey) => {
      const { headers, payload, reactivityKeys, tag, timeToLive } = key
      const rpc = options.group.requests.get(tag)! as any as Rpc.AnyWithProps
      const isStream = RpcSchema.isStreamSchema(rpc.successSchema)
      let atom = isStream
        ? self.runtime.pull(
          Stream.unwrap(
            self.use((client) =>
              Effect.succeed(
                client(tag, payload, { headers } as any) as any
              )
            )
          )
        )
        : self.runtime.atom(
          self.use((client) => client(tag, payload, { headers } as any)) as any
        )
      if (!isStream && key.serializationKey) {
        atom = Atom.serializable(atom, {
          key: `AtomRpc:${key.tag}:${key.serializationKey}`,
          schema: AsyncResult.Schema({
            success: rpc.successSchema,
            error: makeErrorSchema(rpc)
          }) as any
        })
      }
      if (timeToLive) {
        atom = Duration.isFinite(timeToLive)
          ? Atom.setIdleTTL(atom, timeToLive)
          : Atom.keepAlive(atom)
      }
      return reactivityKeys
        ? self.runtime.factory.withReactivity(reactivityKeys)(atom)
        : atom
    }
  )

  self.query = <Tag extends Rpc.Tag<Rpcs>>(
    tag: Tag,
    payload: Rpc.PayloadConstructor<Rpc.ExtractTag<Rpcs, Tag>>,
    options?: {
      readonly headers?: Headers.Input | undefined
      readonly reactivityKeys?:
        | ReadonlyArray<unknown>
        | ReadonlyRecord<string, ReadonlyArray<unknown>>
        | undefined
      readonly timeToLive?: Duration.Input | undefined
      readonly serializationKey?: string | undefined
    }
  ) => {
    const key: QueryKey = {
      tag,
      payload,
      headers: options?.headers
        ? Headers.fromInput(options.headers)
        : undefined,
      reactivityKeys: options?.reactivityKeys,
      timeToLive: options?.timeToLive
        ? Duration.fromInputUnsafe(options.timeToLive)
        : undefined,
      serializationKey: options?.serializationKey
    }
    return queryFamily(key) as any
  }

  return self as AtomRpcClient<Self, Id, Rpcs>
}

interface QueryKey {
  tag: string
  payload: any
  headers: Headers.Headers | undefined
  reactivityKeys:
    | ReadonlyArray<unknown>
    | ReadonlyRecord<string, ReadonlyArray<unknown>>
    | undefined
  timeToLive: Duration.Duration | undefined
  serializationKey: string | undefined
}

const makeErrorSchema = (rpc: Rpc.AnyWithProps): Schema.Top =>
  Schema.Union([
    rpc.errorSchema,
    ...Array.from(rpc.middlewares, (middleware) => middleware.error),
    RpcClientError
  ])
