/**
 * Client-side runtime for typed RPC calls.
 *
 * This module turns RPC definitions from an `RpcGroup` into callable client
 * methods. Each method encodes its payload, sends a request through the active
 * transport, and routes the matching server response back to the waiting
 * `Effect` or `Stream`.
 *
 * **Mental model**
 *
 * `make` builds a schema-aware client on top of a client `Protocol`. The
 * protocol owns the encoded transport boundary: HTTP sends one request per
 * call, while socket and worker protocols keep receive loops alive for
 * streaming, acknowledgements, interruption, and protocol-level failures.
 * `makeNoSerialization` keeps the same request lifecycle when another layer has
 * already decoded messages.
 *
 * **Common tasks**
 *
 * - Build a typed client with {@link make} and a provided protocol layer
 * - Use {@link makeNoSerialization} for in-process or already-decoded channels
 * - Provide HTTP, socket, or worker transports with {@link layerProtocolHttp},
 *   {@link layerProtocolSocket}, or {@link layerProtocolWorker}
 * - Add request headers with {@link withHeaders} or per-call options
 *
 * **Gotchas**
 *
 * HTTP does not support client acknowledgements, so streaming back pressure is
 * only available on protocols that keep a live channel. Streaming RPCs return
 * `Stream`s by default; enabling `asQueue` returns a scoped queue whose buffer
 * size is controlled by `streamBufferSize`. Payloads, exits, stream chunks, and
 * middleware errors are encoded and decoded through RPC schemas, so any schema
 * services required by those codecs remain in the generated method
 * environment. Client middleware can rewrite or short-circuit requests and adds
 * its client error type to the call signature.
 *
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import * as Context from "../../Context.ts"
import type * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Fiber from "../../Fiber.ts"
import { constVoid, dual, flow, identity } from "../../Function.ts"
import * as Latch from "../../Latch.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import * as Pool from "../../Pool.ts"
import * as Queue from "../../Queue.ts"
import * as Result from "../../Result.ts"
import * as Schedule from "../../Schedule.ts"
import * as Schema from "../../Schema.ts"
import * as Scope from "../../Scope.ts"
import * as Stream from "../../Stream.ts"
import type * as Struct from "../../Struct.ts"
import type { Span } from "../../Tracer.ts"
import * as Headers from "../http/Headers.ts"
import * as HttpBody from "../http/HttpBody.ts"
import * as HttpClient from "../http/HttpClient.ts"
import { HttpClientErrorSchema } from "../http/HttpClientError.ts"
import * as HttpClientRequest from "../http/HttpClientRequest.ts"
import * as Socket from "../socket/Socket.ts"
import * as Transferable from "../workers/Transferable.ts"
import * as Worker from "../workers/Worker.ts"
import type { WorkerError } from "../workers/WorkerError.ts"
import * as Rpc from "./Rpc.ts"
import { RpcClientDefect, RpcClientError } from "./RpcClientError.ts"
import type * as RpcGroup from "./RpcGroup.ts"
import type { FromClient, FromClientEncoded, FromServer, FromServerEncoded, Request } from "./RpcMessage.ts"
import { constPing, RequestId } from "./RpcMessage.ts"
import type * as RpcMiddleware from "./RpcMiddleware.ts"
import * as RpcSchema from "./RpcSchema.ts"
import * as RpcSerialization from "./RpcSerialization.ts"
import * as RpcWorker from "./RpcWorker.ts"
import { withRunClient } from "./Utils.ts"

/**
 * The object-shaped client generated from a union of RPC definitions, with one
 * method per RPC tag.
 *
 * @category client
 * @since 4.0.0
 */
export type RpcClient<Rpcs extends Rpc.Any, E = never> = Struct.Simplify<RpcClient.From<Rpcs, E>>

/**
 * Type-level helpers for deriving RPC client call signatures from RPC
 * definitions.
 *
 * @since 4.0.0
 */
export declare namespace RpcClient {
  /**
   * Builds an object client type from an RPC union, mapping each RPC tag to a
   * method that accepts the RPC payload and returns either an `Effect` or
   * `Stream` based on the RPC success schema.
   *
   * @category client
   * @since 4.0.0
   */
  export type From<Rpcs extends Rpc.Any, E = never> = {
    readonly [Current in Rpcs as Current["_tag"]]: <
      const AsQueue extends boolean = false,
      const Discard = false
    >(
      input: Rpc.PayloadConstructor<Current>,
      options?: Rpc.Success<Current> extends Stream.Stream<infer _A, infer _E, infer _R> ? {
          readonly asQueue?: AsQueue | undefined
          readonly streamBufferSize?: number | undefined
          readonly headers?: Headers.Input | undefined
          readonly context?: Context.Context<never> | undefined
        } :
        {
          readonly headers?: Headers.Input | undefined
          readonly context?: Context.Context<never> | undefined
          readonly discard?: Discard | undefined
        }
    ) => Current extends Rpc.Rpc<
      infer _Tag,
      infer _Payload,
      infer _Success,
      infer _Error,
      infer _Middleware,
      infer _Requires
    > ? [_Success] extends [RpcSchema.Stream<infer _A, infer _E>] ? AsQueue extends true ? Effect.Effect<
            Queue.Dequeue<
              _A["Type"],
              _E["Type"] | _Error["Type"] | E | _Middleware["error"]["Type"] | _Middleware["~ClientError"] | Cause.Done
            >,
            never,
            | Scope.Scope
            | _Payload["EncodingServices"]
            | _Success["DecodingServices"]
            | _Error["DecodingServices"]
            | _Middleware["error"]["DecodingServices"]
          >
        : Stream.Stream<
          _A["Type"],
          _E["Type"] | _Error["Type"] | E | _Middleware["error"]["Type"] | _Middleware["~ClientError"],
          | _Payload["EncodingServices"]
          | _Success["DecodingServices"]
          | _Error["DecodingServices"]
          | _Middleware["error"]["DecodingServices"]
        >
      : Effect.Effect<
        Discard extends true ? void : _Success["Type"],
        | (Discard extends true ? never : _Error["Type"])
        | E
        | _Middleware["error"]["Type"]
        | _Middleware["~ClientError"],
        | _Payload["EncodingServices"]
        | _Success["DecodingServices"]
        | _Error["DecodingServices"]
        | _Middleware["error"]["DecodingServices"]
      > :
      never
  }

  /**
   * Builds a flattened RPC client function that accepts an RPC tag and payload,
   * returning the corresponding `Effect` or `Stream` for that RPC.
   *
   * @category client
   * @since 4.0.0
   */
  export type Flat<Rpcs extends Rpc.Any, E = never> = <
    const Tag extends Rpcs["_tag"],
    const AsQueue extends boolean = false,
    const Discard = false
  >(
    tag: Tag,
    payload: Rpc.PayloadConstructor<Rpc.ExtractTag<Rpcs, Tag>>,
    options?: Rpc.Success<Rpc.ExtractTag<Rpcs, Tag>> extends Stream.Stream<infer _A, infer _E, infer _R> ? {
        readonly asQueue?: AsQueue | undefined
        readonly streamBufferSize?: number | undefined
        readonly headers?: Headers.Input | undefined
        readonly context?: Context.Context<never> | undefined
      } :
      {
        readonly headers?: Headers.Input | undefined
        readonly context?: Context.Context<never> | undefined
        readonly discard?: Discard | undefined
      }
  ) => Rpc.ExtractTag<Rpcs, Tag> extends Rpc.Rpc<
    infer _Tag,
    infer _Payload,
    infer _Success,
    infer _Error,
    infer _Middleware,
    infer _Requires
  > ? [_Success] extends [RpcSchema.Stream<infer _A, infer _E>] ? AsQueue extends true ? Effect.Effect<
          Queue.Dequeue<
            _A["Type"],
            _E["Type"] | _Error["Type"] | E | _Middleware["error"]["Type"] | _Middleware["~ClientError"]
          >,
          never,
          | Scope.Scope
          | _Payload["EncodingServices"]
          | _Success["DecodingServices"]
          | _Error["DecodingServices"]
          | _Middleware["error"]["DecodingServices"]
        >
      : Stream.Stream<
        _A["Type"],
        _E["Type"] | _Error["Type"] | E | _Middleware["error"]["Type"] | _Middleware["~ClientError"],
        | _Payload["EncodingServices"]
        | _Success["DecodingServices"]
        | _Error["DecodingServices"]
        | _Middleware["error"]["DecodingServices"]
      >
    : Effect.Effect<
      Discard extends true ? void : _Success["Type"],
      (Discard extends true ? never : _Error["Type"]) | E | _Middleware["error"]["Type"] | _Middleware["~ClientError"],
      | _Payload["EncodingServices"]
      | _Success["DecodingServices"]
      | _Error["DecodingServices"]
      | _Middleware["error"]["DecodingServices"]
    > :
    never
}

/**
 * Derives the object-shaped RPC client type for all RPCs contained in an
 * `RpcGroup`.
 *
 * @category client
 * @since 4.0.0
 */
export type FromGroup<Group, E = never> = RpcClient<RpcGroup.Rpcs<Group>, E>

let requestIdCounter = BigInt(0)

/**
 * Creates an RPC client for an already-decoded message channel, returning the
 * client API together with a `write` function for delivering server messages
 * back to the client.
 *
 * @category client
 * @since 4.0.0
 */
export const makeNoSerialization: <Rpcs extends Rpc.Any, E, const Flatten extends boolean = false>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options: {
    readonly onFromClient: (
      options: {
        readonly message: FromClient<Rpcs>
        readonly context: Context.Context<never>
        readonly discard: boolean
      }
    ) => Effect.Effect<void, E>
    readonly supportsAck?: boolean | undefined
    readonly spanPrefix?: string | undefined
    readonly spanAttributes?: Record<string, unknown> | undefined
    readonly generateRequestId?: (() => RequestId) | undefined
    readonly disableTracing?: boolean | undefined
    readonly flatten?: Flatten | undefined
  }
) => Effect.Effect<
  {
    readonly client: Flatten extends true ? RpcClient.Flat<Rpcs, E> : RpcClient<Rpcs, E>
    readonly write: (message: FromServer<Rpcs>) => Effect.Effect<void>
  },
  never,
  Scope.Scope | Rpc.MiddlewareClient<Rpcs>
> = Effect.fnUntraced(function*<Rpcs extends Rpc.Any, E, const Flatten extends boolean = false>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options: {
    readonly onFromClient: (
      options: {
        readonly message: FromClient<Rpcs>
        readonly context: Context.Context<never>
        readonly discard: boolean
      }
    ) => Effect.Effect<void, E>
    readonly supportsAck?: boolean | undefined
    readonly spanPrefix?: string | undefined
    readonly spanAttributes?: Record<string, unknown> | undefined
    readonly generateRequestId?: (() => RequestId) | undefined
    readonly disableTracing?: boolean | undefined
    readonly flatten?: Flatten | undefined
  }
) {
  const spanPrefix = options?.spanPrefix ?? "RpcClient"
  const supportsAck = options?.supportsAck ?? true
  const disableTracing = options?.disableTracing ?? false
  const generateRequestId = options?.generateRequestId ?? (() => requestIdCounter++ as RequestId)

  const services = yield* Effect.context<Rpc.MiddlewareClient<Rpcs> | Scope.Scope>()
  const scope = Context.get(services, Scope.Scope)

  type ClientEntry = {
    readonly _tag: "Effect"
    readonly rpc: Rpc.AnyWithProps
    readonly context: Context.Context<never>
    resume: (_: Exit.Exit<any, any>) => void
  } | {
    readonly _tag: "Queue"
    readonly rpc: Rpc.AnyWithProps
    readonly queue: Queue.Queue<any, any>
    readonly scope: Scope.Scope
    readonly context: Context.Context<never>
  }
  const entries = new Map<RequestId, ClientEntry>()

  let isShutdown = false
  yield* Scope.addFinalizer(
    scope,
    Effect.withFiber((parent) => {
      isShutdown = true
      return clearEntries(Exit.interrupt(parent.id))
    })
  )

  const clearEntries = Effect.fnUntraced(function*(exit: Exit.Exit<never>) {
    for (const [id, entry] of entries) {
      entries.delete(id)
      if (entry._tag === "Queue") {
        yield* (exit._tag === "Success"
          ? Queue.end(entry.queue as any)
          : Queue.failCause(entry.queue as any, exit.cause)) as Effect.Effect<void>
      } else {
        entry.resume(exit)
      }
    }
  })

  const onRequest = (rpc: Rpc.AnyWithProps) => {
    const isStream = RpcSchema.isStreamSchema(rpc.successSchema)
    const middleware = getRpcClientMiddleware(rpc)
    return (payload: any, opts?: {
      readonly asQueue?: boolean | undefined
      readonly streamBufferSize?: number | undefined
      readonly headers?: Headers.Input | undefined
      readonly context?: Context.Context<never> | undefined
      readonly discard?: boolean | undefined
    }) => {
      const headers = opts?.headers ? Headers.fromInput(opts.headers) : Headers.empty
      const context = opts?.context ?? Context.empty()
      if (!isStream) {
        const onRequest = (span: Span | undefined) =>
          onEffectRequest(
            rpc,
            middleware,
            span,
            rpc.payloadSchema.make(payload),
            headers,
            context,
            opts?.discard ?? false
          )
        return disableTracing ? onRequest(undefined) : Effect.useSpan(
          `${spanPrefix}.${rpc._tag}`,
          { attributes: options.spanAttributes },
          onRequest
        )
      }
      const queue = onStreamRequest(
        rpc,
        middleware,
        rpc.payloadSchema.make(payload),
        headers,
        opts?.streamBufferSize ?? 16,
        context
      )
      if (opts?.asQueue) return queue
      return Stream.unwrap(Effect.map(queue, Stream.fromQueue))
    }
  }

  const onEffectRequest = (
    rpc: Rpc.AnyWithProps,
    middleware: (
      send: (request: Request<Rpcs>) => Effect.Effect<any, E>,
      request: Request<Rpcs>
    ) => Effect.Effect<any, E>,
    span: Span | undefined,
    payload: any,
    headers: Headers.Headers,
    context: Context.Context<never>,
    discard: boolean
  ) =>
    Effect.withFiber<any, any, any>((parentFiber) => {
      if (isShutdown) {
        return Effect.interrupt
      }
      const id = generateRequestId()
      const send = middleware(
        (message) =>
          options.onFromClient({
            message,
            context,
            discard
          }),
        {
          _tag: "Request",
          id,
          tag: rpc._tag as Rpc.Tag<Rpcs>,
          payload,
          ...(span ?
            {
              traceId: span.traceId,
              spanId: span.spanId,
              sampled: span.sampled
            } :
            {}),
          headers: Headers.merge(parentFiber.getRef(CurrentHeaders), headers)
        }
      )
      if (discard) {
        return send
      }
      let fiber: Fiber.Fiber<any, any>
      return Effect.onInterrupt(
        Effect.callback<any, any>((resume) => {
          const entry: ClientEntry = {
            _tag: "Effect",
            rpc,
            context,
            resume(exit) {
              resume(exit)
              if (fiber && !fiber.pollUnsafe()) {
                parentFiber.currentDispatcher.scheduleTask(() => {
                  fiber.interruptUnsafe(parentFiber.id)
                }, 0)
              }
            }
          }
          entries.set(id, entry)
          fiber = send.pipe(
            span ? Effect.withParentSpan(span, { captureStackTrace: false }) : identity,
            Effect.runForkWith(parentFiber.context)
          )
          fiber.addObserver((exit) => {
            if (exit._tag === "Failure") {
              return resume(exit)
            }
          })
        }),
        (interruptors) => {
          entries.delete(id)
          return Effect.andThen(
            Fiber.interrupt(fiber),
            sendInterrupt(id, Array.from(interruptors), context)
          )
        }
      )
    })

  const onStreamRequest = Effect.fnUntraced(function*(
    rpc: Rpc.AnyWithProps,
    middleware: (
      send: (request: Request<Rpcs>) => Effect.Effect<any, E>,
      request: Request<Rpcs>
    ) => Effect.Effect<any, E>,
    payload: any,
    headers: Headers.Headers,
    streamBufferSize: number,
    context: Context.Context<never>
  ) {
    if (isShutdown) {
      return yield* Effect.interrupt
    }

    const span = disableTracing ? undefined : yield* Effect.makeSpanScoped(`${spanPrefix}.${rpc._tag}`, {
      attributes: options.spanAttributes
    })
    const fiber = Fiber.getCurrent()!
    const id = generateRequestId()

    const scope = Context.getUnsafe(fiber.context, Scope.Scope)
    yield* Scope.addFinalizerExit(
      scope,
      (exit) => {
        if (!entries.has(id)) return Effect.void
        entries.delete(id)
        return sendInterrupt(
          id,
          Exit.isFailure(exit) ?
            Array.from(Cause.interruptors(exit.cause))
            : [],
          context
        )
      }
    )

    const queue = yield* Queue.bounded<any, any>(streamBufferSize)
    entries.set(id, {
      _tag: "Queue",
      rpc,
      queue,
      scope,
      context
    })

    yield* middleware(
      (message) =>
        options.onFromClient({
          message,
          context,
          discard: false
        }),
      {
        _tag: "Request",
        id,
        tag: rpc._tag as Rpc.Tag<Rpcs>,
        payload,
        ...(span ?
          {
            traceId: span.traceId,
            spanId: span.spanId,
            sampled: span.sampled
          } :
          {}),
        headers: Headers.merge(fiber.getRef(CurrentHeaders), headers)
      }
    ).pipe(
      span ? Effect.withParentSpan(span, { captureStackTrace: false }) : identity,
      Effect.catchCause((error) => Queue.failCause(queue, error)),
      Effect.interruptible,
      Effect.forkIn(scope, { startImmediately: true })
    )

    return queue
  })

  const getRpcClientMiddleware = (
    rpc: Rpc.AnyWithProps
  ): (
    send: (request: Request<Rpcs>) => Effect.Effect<any, E>,
    request: Request<Rpcs>
  ) => Effect.Effect<any, E> => {
    const middlewares: Array<RpcMiddleware.RpcMiddlewareClient<any, any, any>> = []
    for (const tag of rpc.middlewares.values()) {
      const middleware = services.mapUnsafe.get(`${tag.key}/Client`)
      if (!middleware) continue
      middlewares.push(middleware)
    }

    if (middlewares.length === 0) {
      return (send, request) => send(request)
    }

    return function loop(
      send: (request: Request<Rpcs>) => Effect.Effect<any, E>,
      request: Request<Rpcs>,
      index = middlewares.length - 1
    ): Effect.Effect<any, E> {
      if (index === -1) {
        return send(request)
      }
      return middlewares[index]({
        rpc,
        request,
        next(request) {
          return loop(send, request, index - 1) as any
        }
      }) as Effect.Effect<any, E>
    }
  }

  const sendInterrupt = (
    requestId: RequestId,
    interruptors: ReadonlyArray<number>,
    context: Context.Context<never>
  ): Effect.Effect<void> =>
    Effect.callback<void>((resume) => {
      const parentFiber = Fiber.getCurrent()!
      const fiber = options.onFromClient({
        message: { _tag: "Interrupt", requestId, interruptors },
        context,
        discard: false
      }).pipe(
        Effect.timeout(1000),
        Effect.runForkWith(parentFiber.context)
      )
      fiber.addObserver(() => {
        resume(Effect.void)
      })
    })

  const write = (message: FromServer<Rpcs>): Effect.Effect<void> => {
    switch (message._tag) {
      case "Chunk": {
        const requestId = message.requestId
        const entry = entries.get(requestId)
        if (!entry || entry._tag !== "Queue") return Effect.void
        return Queue.offerAll(entry.queue, message.values).pipe(
          supportsAck
            ? Effect.flatMap(() =>
              options.onFromClient({
                message: { _tag: "Ack", requestId: message.requestId },
                context: entry.context,
                discard: false
              })
            )
            : identity,
          Effect.catchCause((cause) => Queue.failCause(entry.queue, cause))
        )
      }
      case "Exit": {
        const requestId = message.requestId
        const entry = entries.get(requestId)
        if (!entry) return Effect.void
        entries.delete(requestId)
        if (entry._tag === "Effect") {
          entry.resume(message.exit)
          return Effect.void
        }
        return message.exit._tag === "Success"
          ? Queue.end(entry.queue)
          : Queue.failCause(entry.queue, message.exit.cause)
      }
      case "Defect": {
        return clearEntries(Exit.die(message.defect))
      }
      case "ClientEnd": {
        return Effect.void
      }
    }
  }

  let client: any
  if (options.flatten) {
    const fns = new Map<string, any>()
    client = function client(tag: string, payload: any, options?: {}) {
      let fn = fns.get(tag)
      if (!fn) {
        fn = onRequest(group.requests.get(tag)! as any)
        fns.set(tag, fn)
      }
      return fn(payload, options)
    }
  } else {
    client = {}
    group.requests.forEach((rpc) => {
      client[rpc._tag] = onRequest(rpc as any)
    })
  }

  return { client, write } as const
})

let clientIdCounter = 0

/**
 * Creates a schema-aware RPC client for a group using the current client
 * `Protocol`, encoding requests and decoding server responses.
 *
 * @category client
 * @since 4.0.0
 */
export const make: <Rpcs extends Rpc.Any, const Flatten extends boolean = false>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options?: {
    readonly spanPrefix?: string | undefined
    readonly spanAttributes?: Record<string, unknown> | undefined
    readonly generateRequestId?: (() => RequestId) | undefined
    readonly disableTracing?: boolean | undefined
    readonly flatten?: Flatten | undefined
  } | undefined
) => Effect.Effect<
  Flatten extends true ? RpcClient.Flat<Rpcs, RpcClientError> : RpcClient<Rpcs, RpcClientError>,
  never,
  Protocol | Rpc.MiddlewareClient<Rpcs> | Scope.Scope
> = Effect.fnUntraced(function*<Rpcs extends Rpc.Any, const Flatten extends boolean = false>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options?: {
    readonly spanPrefix?: string | undefined
    readonly spanAttributes?: Record<string, unknown> | undefined
    readonly generateRequestId?: (() => RequestId) | undefined
    readonly disableTracing?: boolean | undefined
    readonly flatten?: Flatten | undefined
  } | undefined
) {
  const clientId = clientIdCounter++
  const { run, send, supportsAck, supportsTransferables } = yield* Protocol

  type ClientEntry = {
    readonly rpc: Rpc.AnyWithProps
    readonly context: Context.Context<never>
    readonly schemas: RpcSchemas
  }
  const entries = new Map<RequestId, ClientEntry>()

  const { client, write } = yield* makeNoSerialization(group, {
    ...options,
    supportsAck,
    onFromClient({ message }) {
      switch (message._tag) {
        case "Request": {
          const rpc = group.requests.get(message.tag)! as any as Rpc.AnyWithProps
          const collector = supportsTransferables ? Transferable.makeCollectorUnsafe() : undefined

          const fiber = Fiber.getCurrent()!

          const entry: ClientEntry = {
            rpc,
            context: collector ? Context.add(fiber.context, Transferable.Collector, collector) : fiber.context,
            schemas: rpcSchemas(rpc)
          }
          entries.set(message.id, entry)

          return entry.schemas.encodePayload(message.payload).pipe(
            Effect.provideContext(entry.context),
            Effect.orDie,
            Effect.flatMap((payload) =>
              send(clientId, {
                ...message,
                id: String(message.id),
                payload,
                headers: Object.entries(message.headers)
              }, collector && collector.readUnsafe())
            )
          ) as Effect.Effect<void, RpcClientError>
        }
        case "Ack": {
          const entry = entries.get(message.requestId)
          if (!entry) return Effect.void
          return send(clientId, {
            _tag: "Ack",
            requestId: String(message.requestId)
          }) as Effect.Effect<void, RpcClientError>
        }
        case "Interrupt": {
          const entry = entries.get(message.requestId)
          if (!entry) return Effect.void
          entries.delete(message.requestId)
          return send(clientId, {
            _tag: "Interrupt",
            requestId: String(message.requestId)
          }) as Effect.Effect<void, RpcClientError>
        }
        case "Eof": {
          return Effect.void
        }
      }
    }
  })

  yield* run(clientId, (message) => {
    switch (message._tag) {
      case "Chunk": {
        const requestId = RequestId(message.requestId)
        const entry = entries.get(requestId)
        if (!entry || Option.isNone(entry.schemas.decodeChunk)) return Effect.void
        return entry.schemas.decodeChunk.value(message.values).pipe(
          Effect.provideContext(entry.context),
          Effect.orDie,
          Effect.flatMap((chunk) =>
            write({ _tag: "Chunk", clientId: 0, requestId: RequestId(message.requestId), values: chunk })
          ),
          Effect.onError((cause) =>
            write({
              _tag: "Exit",
              clientId: 0,
              requestId: RequestId(message.requestId),
              exit: Exit.failCause(cause)
            })
          )
        ) as Effect.Effect<void>
      }
      case "Exit": {
        const requestId = RequestId(message.requestId)
        const entry = entries.get(requestId)
        if (!entry) return Effect.void
        entries.delete(requestId)
        return entry.schemas.decodeExit(message.exit).pipe(
          Effect.provideContext(entry.context),
          Effect.orDie,
          Effect.matchCauseEffect({
            onSuccess: (exit) => write({ _tag: "Exit", clientId: 0, requestId, exit }),
            onFailure: (cause) => write({ _tag: "Exit", clientId: 0, requestId, exit: Exit.failCause(cause) })
          })
        ) as Effect.Effect<void>
      }
      case "Defect": {
        return write({ _tag: "Defect", clientId: 0, defect: decodeDefect(message.defect as any) })
      }
      case "ClientProtocolError": {
        const exit = Exit.fail(message.error)
        return Effect.forEach(
          entries.keys(),
          (requestId) => write({ _tag: "Exit", clientId: 0, requestId, exit: exit as any })
        )
      }
      default: {
        return Effect.void
      }
    }
  }).pipe(
    Effect.catchCause(Effect.logError),
    Effect.interruptible,
    Effect.forkScoped
  )

  return client
})

interface RpcSchemas {
  readonly decodeChunk: Option.Option<
    (chunk: ReadonlyArray<unknown>) => Effect.Effect<NonEmptyReadonlyArray<any>, Schema.SchemaError, unknown>
  >
  readonly encodePayload: (payload: any) => Effect.Effect<any, Schema.SchemaError, unknown>
  readonly decodeExit: (encoded: unknown) => Effect.Effect<Exit.Exit<any, any>, Schema.SchemaError, unknown>
}
const rpcSchemasCache = new WeakMap<Rpc.AnyWithProps, RpcSchemas>()
const rpcSchemas = (rpc: Rpc.AnyWithProps) => {
  let entry = rpcSchemasCache.get(rpc)
  if (entry !== undefined) {
    return entry
  }
  const streamSchemas = RpcSchema.getStreamSchemas(rpc.successSchema)
  entry = {
    decodeChunk: Option.map(
      streamSchemas,
      (streamSchemas) => Schema.decodeUnknownEffect(Schema.toCodecJson(Schema.NonEmptyArray(streamSchemas.success)))
    ),
    encodePayload: Schema.encodeEffect(Schema.toCodecJson(rpc.payloadSchema)),
    decodeExit: Schema.decodeUnknownEffect(Schema.toCodecJson(Rpc.exitSchema(rpc as any)))
  }
  rpcSchemasCache.set(rpc, entry)
  return entry
}

/**
 * Fiber reference containing headers that are merged into outgoing RPC
 * client requests.
 *
 * **When to use**
 *
 * Use to set request headers that should be automatically merged into outgoing
 * RPC client messages.
 *
 * @category headers
 * @since 4.0.0
 */
export const CurrentHeaders = Context.Reference<Headers.Headers>("effect/rpc/RpcClient/CurrentHeaders", {
  defaultValue: () => Headers.empty
})

/**
 * Runs an effect with additional RPC client headers, merging them with the
 * current `CurrentHeaders` value for outgoing requests.
 *
 * @category headers
 * @since 4.0.0
 */
export const withHeaders: {
  (headers: Headers.Input): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(effect: Effect.Effect<A, E, R>, headers: Headers.Input): Effect.Effect<A, E, R>
} = dual(
  2,
  <A, E, R>(effect: Effect.Effect<A, E, R>, headers: Headers.Input): Effect.Effect<A, E, R> =>
    Effect.updateService(effect, CurrentHeaders, Headers.merge(Headers.fromInput(headers)))
)

/**
 * Defines the service interface for an RPC client transport, responsible for running the
 * receive loop and sending encoded client messages.
 *
 * **When to use**
 *
 * Use to provide the transport boundary for RPC clients over HTTP, WebSocket,
 * workers, sockets, or custom protocols.
 *
 * @category protocols
 * @since 4.0.0
 */
export class Protocol extends Context.Service<Protocol, {
  readonly run: (
    clientId: number,
    f: (data: FromServerEncoded) => Effect.Effect<void>
  ) => Effect.Effect<never>
  readonly send: (
    clientId: number,
    request: FromClientEncoded,
    transferables?: ReadonlyArray<globalThis.Transferable>
  ) => Effect.Effect<void, RpcClientError>
  readonly supportsAck: boolean
  readonly supportsTransferables: boolean
}>()("effect/rpc/RpcClient/Protocol") {
  /**
   * Creates a client protocol service from the supplied RPC request runner.
   *
   * @since 4.0.0
   */
  static make = withRunClient
}

/**
 * Creates a client `Protocol` that sends each RPC request through the supplied
 * `HttpClient` and decodes responses with the current `RpcSerialization`.
 *
 * @category protocols
 * @since 4.0.0
 */
export const makeProtocolHttp = (client: HttpClient.HttpClient): Effect.Effect<
  Protocol["Service"],
  never,
  RpcSerialization.RpcSerialization
> =>
  Protocol.make(Effect.fnUntraced(function*(writeResponse) {
    const serialization = yield* RpcSerialization.RpcSerialization
    const isFramed = serialization.includesFraming
    const httpClientError = (cause: any) =>
      new RpcClientError({
        reason: HttpClientErrorSchema.fromHttpClientError(cause)
      })
    const protocolDefect = (message: string, cause: unknown) =>
      new RpcClientError({
        reason: new RpcClientDefect({ message, cause })
      })
    const emptyResponseError = (request: FromClientEncoded) =>
      protocolDefect("Received empty HTTP response from RPC server", request)

    const send = Effect.fnUntraced(function*(clientId: number, request: FromClientEncoded) {
      if (request._tag !== "Request") {
        return
      }

      const parser = serialization.makeUnsafe()

      const encoded = parser.encode(request)!
      const body = typeof encoded === "string" ?
        HttpBody.text(encoded, serialization.contentType) :
        HttpBody.uint8Array(encoded, serialization.contentType)

      const response = yield* client.post("", { body }).pipe(Effect.mapError(httpClientError))

      if (!isFramed) {
        const text = yield* response.text.pipe(Effect.mapError(httpClientError))
        const responses = yield* Effect.try({
          try: () => parser.decode(text),
          catch: (cause) => protocolDefect("Error decoding HTTP response", cause)
        })
        if (!Array.isArray(responses)) {
          return yield* protocolDefect("Expected an array of responses", responses)
        }
        if (responses.length === 0) {
          return yield* emptyResponseError(request)
        }
        let i = 0
        return yield* Effect.whileLoop({
          while: () => i < responses.length,
          body: () => writeResponse(clientId, responses[i++]),
          step: constVoid
        })
      }

      let hasResponse = false
      yield* Stream.runForEachArray(response.stream, (chunk) =>
        Effect.try({
          try: () => chunk.flatMap(parser.decode) as Array<FromServerEncoded>,
          catch: (cause) => protocolDefect("Error decoding HTTP response", cause)
        }).pipe(
          Effect.flatMap((responses) => {
            if (responses.length === 0) return Effect.void
            hasResponse = true
            let i = 0
            return Effect.whileLoop({
              while: () => i < responses.length,
              body: () => writeResponse(clientId, responses[i++]),
              step: constVoid
            })
          })
        )).pipe(
          Effect.mapError((cause) => cause instanceof RpcClientError ? cause : httpClientError(cause))
        )
      if (!hasResponse) {
        return yield* emptyResponseError(request)
      }
    })

    return {
      send,
      supportsAck: false,
      supportsTransferables: false
    }
  }))

/**
 * Provides a client `Protocol` backed by `HttpClient`, targeting the configured
 * URL and optionally transforming the client before use.
 *
 * @category protocols
 * @since 4.0.0
 */
export const layerProtocolHttp = (options: {
  readonly url: string
  readonly transformClient?: <E, R>(client: HttpClient.HttpClient.With<E, R>) => HttpClient.HttpClient.With<E, R>
}): Layer.Layer<Protocol, never, RpcSerialization.RpcSerialization | HttpClient.HttpClient> =>
  Layer.effect(Protocol)(
    Effect.flatMap(
      HttpClient.HttpClient,
      (client) => {
        client = HttpClient.mapRequest(client, HttpClientRequest.prependUrl(options.url))
        return makeProtocolHttp(options.transformClient ? options.transformClient(client) : client)
      }
    )
  )

/**
 * Creates a client `Protocol` over the current `Socket`, using the current
 * `RpcSerialization`, connection hooks, ping timeouts, and the configured retry
 * policy.
 *
 * @category protocols
 * @since 4.0.0
 */
export const makeProtocolSocket = (options?: {
  readonly retryTransientErrors?: boolean | undefined
  readonly retryPolicy?: Schedule.Schedule<any, Socket.SocketError> | undefined
}): Effect.Effect<
  Protocol["Service"],
  never,
  Scope.Scope | RpcSerialization.RpcSerialization | Socket.Socket
> =>
  Protocol.make(Effect.fnUntraced(function*(writeResponse, clientIds) {
    const socket = yield* Socket.Socket
    const serialization = yield* RpcSerialization.RpcSerialization
    const hooks = yield* Effect.serviceOption(ConnectionHooks)
    const requestClientMap = new Map<string, number>()

    const write = yield* socket.writer

    let parser = serialization.makeUnsafe()

    const pinger = yield* makePinger(write(parser.encode(constPing)!))
    let currentError: RpcClientError | undefined
    const onOpen = Effect.suspend(() => {
      currentError = undefined
      return Option.isSome(hooks) ? hooks.value.onConnect : Effect.void
    })

    const broadcast = (response: FromServerEncoded) =>
      Effect.forEach(clientIds, (clientId) => writeResponse(clientId, response))

    yield* Effect.suspend(() => {
      parser = serialization.makeUnsafe()
      pinger.reset()
      return socket.runRaw((message) => {
        try {
          const responses = parser.decode(message) as Array<FromServerEncoded>
          if (responses.length === 0) return
          let i = 0
          return Effect.whileLoop({
            while: () => i < responses.length,
            body: () => {
              const response = responses[i++]
              if (response._tag === "Pong") {
                pinger.onPong()
                return Effect.void
              }
              if ("requestId" in response) {
                const clientId = requestClientMap.get(response.requestId)
                if (clientId !== undefined) {
                  if (response._tag === "Exit") {
                    requestClientMap.delete(response.requestId)
                  }
                  return writeResponse(clientId, response)
                }
              }
              return broadcast(response)
            },
            step: constVoid
          })
        } catch (defect) {
          return broadcast({
            _tag: "ClientProtocolError",
            error: new RpcClientError({
              reason: new RpcClientDefect({
                message: "Error decoding message",
                cause: defect
              })
            })
          })
        }
      }, { onOpen }).pipe(
        Effect.raceFirst(Effect.flatMap(
          pinger.timeout,
          () =>
            Effect.fail(
              new Socket.SocketError({
                reason: new Socket.SocketOpenError({
                  kind: "Timeout",
                  cause: new Error("ping timeout")
                })
              })
            )
        ))
      )
    }).pipe(
      Effect.flatMap(() =>
        Effect.fail(new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) }))
      ),
      Option.isSome(hooks) ? Effect.ensuring(hooks.value.onDisconnect) : identity,
      Effect.tapCause((cause) => {
        const error = Cause.findError(cause)
        const hasError = Result.isSuccess(error)
        if (
          options?.retryTransientErrors && hasError &&
          error.success.reason._tag === "SocketOpenError"
        ) {
          return Effect.void
        }
        currentError = new RpcClientError({
          reason: hasError ? error.success.reason : new RpcClientDefect({
            message: "Unknown socket error",
            cause: Cause.squash(cause)
          })
        })
        return broadcast({
          _tag: "ClientProtocolError",
          error: currentError
        })
      }),
      Effect.retry(options?.retryPolicy ?? defaultRetryPolicy),
      Effect.annotateLogs({
        module: "RpcClient",
        method: "makeProtocolSocket"
      }),
      Effect.forkScoped
    )

    return {
      send(clientId, request) {
        if (currentError) {
          return Effect.fail(currentError)
        }
        if (request._tag === "Request") {
          requestClientMap.set(request.id, clientId)
        }
        const encoded = parser.encode(request)
        if (encoded === undefined) return Effect.void
        return Effect.orDie(write(encoded))
      },
      supportsAck: true,
      supportsTransferables: false
    }
  }))

const defaultRetryPolicy = Schedule.exponential(500, 1.5).pipe(
  Schedule.either(Schedule.spaced(5000))
)

const makePinger = Effect.fnUntraced(function*<A, E, R>(writePing: Effect.Effect<A, E, R>) {
  let recievedPong = true
  const latch = Latch.makeUnsafe()
  const reset = () => {
    recievedPong = true
    latch.closeUnsafe()
  }
  const onPong = () => {
    recievedPong = true
  }
  yield* Effect.suspend((): Effect.Effect<void, E, R> => {
    if (!recievedPong) return latch.open
    recievedPong = false
    return writePing
  }).pipe(
    Effect.delay("5 seconds"),
    Effect.ignore,
    Effect.forever,
    Effect.interruptible,
    Effect.forkScoped
  )
  return { timeout: latch.await, reset, onPong } as const
})

/**
 * Provides a client `Protocol` backed by the current `Socket` and
 * `RpcSerialization` services.
 *
 * @category protocols
 * @since 4.0.0
 */
export const layerProtocolSocket = (options?: {
  readonly retryTransientErrors?: boolean | undefined
}): Layer.Layer<
  Protocol,
  never,
  Socket.Socket | RpcSerialization.RpcSerialization
> => Layer.effect(Protocol)(makeProtocolSocket(options))

/**
 * Creates a client `Protocol` backed by a pool of workers, routing RPC requests
 * to workers and supporting transferable values when the platform does.
 *
 * @category protocols
 * @since 4.0.0
 */
export const makeProtocolWorker = (
  options: {
    readonly size: number
    readonly concurrency?: number | undefined
    readonly targetUtilization?: number | undefined
  } | {
    readonly minSize: number
    readonly maxSize: number
    readonly concurrency?: number | undefined
    readonly targetUtilization?: number | undefined
    readonly timeToLive: Duration.Input
  }
): Effect.Effect<
  Protocol["Service"],
  WorkerError,
  Scope.Scope | Worker.WorkerPlatform | Worker.Spawner
> =>
  Protocol.make(Effect.fnUntraced(function*(writeResponse, clientIds) {
    const worker = yield* Worker.WorkerPlatform
    const scope = yield* Effect.scope
    let workerId = 0
    const initialMessage = yield* Effect.serviceOption(RpcWorker.InitialMessage)
    const hooks = yield* Effect.serviceOption(ConnectionHooks)

    const entries = new Map<string, {
      readonly clientId: number
      readonly worker: Worker.Worker<FromServerEncoded, FromClientEncoded | RpcWorker.InitialMessage.Encoded>
      readonly latch: Latch.Latch
    }>()

    const broadcast = (response: FromServerEncoded) =>
      Effect.forEach(clientIds, (clientId) => writeResponse(clientId, response))

    const acquire = Effect.gen(function*() {
      const id = workerId++
      const backing = yield* worker.spawn<FromServerEncoded, FromClientEncoded | RpcWorker.InitialMessage.Encoded>(id)

      yield* backing.run((response) => {
        if (response._tag === "Exit") {
          const entry = entries.get(response.requestId)
          if (entry) {
            entries.delete(response.requestId)
            entry.latch.openUnsafe()
            return writeResponse(entry.clientId, response)
          }
        } else if (response._tag === "Defect") {
          for (const [requestId, entry] of entries) {
            entries.delete(requestId)
            entry.latch.openUnsafe()
          }
          return broadcast(response)
        } else if ("requestId" in response) {
          const entry = entries.get(response.requestId)
          if (entry) {
            return writeResponse(entry.clientId, response)
          }
        }
        return broadcast(response)
      }, {
        onSpawn: Option.isSome(initialMessage) ?
          Effect.flatMap(
            initialMessage.value,
            ([value, transfers]) => Effect.orDie(backing.send({ _tag: "InitialMessage", value }, transfers))
          ) :
          undefined
      }).pipe(
        Effect.tapCause((cause) => {
          const error = Cause.findError(cause)
          return broadcast({
            _tag: "ClientProtocolError",
            error: new RpcClientError({
              reason: Result.isSuccess(error) ? error.success.reason : new RpcClientDefect({
                message: "Error in worker",
                cause: Cause.squash(cause)
              })
            })
          })
        }),
        Effect.retry(Schedule.spaced(1000)),
        Effect.annotateLogs({
          module: "RpcClient",
          method: "makeProtocolWorker"
        }),
        Effect.interruptible,
        Effect.forkScoped
      )

      return backing
    })

    const pool = "minSize" in options ?
      yield* Pool.makeWithTTL({
        acquire,
        min: options.minSize,
        max: options.maxSize,
        concurrency: options.concurrency,
        targetUtilization: options.targetUtilization,
        timeToLive: options.timeToLive
      }) :
      yield* Pool.make({
        acquire,
        size: options.size,
        concurrency: options.concurrency,
        targetUtilization: options.targetUtilization
      })

    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        for (const entry of entries.values()) {
          entry.latch.openUnsafe()
        }
        entries.clear()
      })
    )

    const send = (
      clientId: number,
      request: FromClientEncoded,
      transferables?: ReadonlyArray<globalThis.Transferable>
    ) => {
      switch (request._tag) {
        case "Request": {
          return Pool.get(pool).pipe(
            Effect.flatMap((worker) => {
              const latch = Latch.makeUnsafe(false)
              entries.set(request.id, { clientId, worker, latch })
              return Effect.flatMap(worker.send(request, transferables), () => latch.await)
            }),
            Effect.scoped,
            Effect.orDie
          )
        }
        case "Interrupt": {
          const entry = entries.get(request.requestId)
          if (!entry) return Effect.void
          entries.delete(request.requestId)
          entry.latch.openUnsafe()
          return Effect.orDie(entry.worker.send(request))
        }
        case "Ack": {
          const entry = entries.get(request.requestId)
          if (!entry) return Effect.void
          return Effect.orDie(entry.worker.send(request))
        }
      }
      return Effect.void
    }

    yield* Effect.scoped(Pool.get(pool))
    if (Option.isSome(hooks)) yield* hooks.value.onConnect

    return {
      send,
      supportsAck: true,
      supportsTransferables: true
    }
  }))

/**
 * Provides a client `Protocol` backed by a worker pool using the current worker
 * platform and spawner services.
 *
 * @category protocols
 * @since 4.0.0
 */
export const layerProtocolWorker: (
  options: {
    readonly size: number
    readonly concurrency?: number | undefined
    readonly targetUtilization?: number | undefined
  } | {
    readonly minSize: number
    readonly maxSize: number
    readonly concurrency?: number | undefined
    readonly targetUtilization?: number | undefined
    readonly timeToLive: Duration.Input
  }
) => Layer.Layer<
  Protocol,
  WorkerError,
  Worker.WorkerPlatform | Worker.Spawner
> = flow(makeProtocolWorker, Layer.effect(Protocol))

/**
 * Represents optional client protocol hooks that run when a transport connects
 * and disconnects.
 *
 * **When to use**
 *
 * Use to run setup or cleanup effects when an RPC client transport opens or
 * closes.
 *
 * @category connection hooks
 * @since 4.0.0
 */
export class ConnectionHooks extends Context.Service<ConnectionHooks, {
  readonly onConnect: Effect.Effect<void>
  readonly onDisconnect: Effect.Effect<void>
}>()("effect/rpc/RpcClient/ConnectionHooks") {}

// internal

const decodeDefect = Schema.decodeSync(Schema.Defect)
