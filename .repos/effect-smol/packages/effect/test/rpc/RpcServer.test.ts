import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Socket, SocketServer } from "effect/unstable/socket"

const producedWithoutReadingFramedBody = Effect.fnUntraced(function*(
  streamBufferSize?: number | "unbounded"
) {
  let produced = 0
  const Rpcs = RpcGroup.make(Rpc.make("events", {
    payload: Schema.Struct({}),
    success: Schema.Number,
    stream: true
  }))
  const Handlers = Rpcs.toLayerHandler(
    "events",
    () => Stream.fromEffectRepeat(Effect.sync(() => ++produced)).pipe(Stream.take(10_000))
  )
  const Server = RpcServer.layerHttp({
    group: Rpcs,
    path: "/rpc",
    protocol: "http",
    ...(streamBufferSize === undefined ? {} : { streamBufferSize })
  }).pipe(
    Layer.provide(Handlers),
    Layer.provide(RpcSerialization.layerNdjson)
  )
  const { dispose, handler } = HttpRouter.toWebHandler(Server)
  yield* Effect.addFinalizer(() => Effect.promise(dispose))

  const response = yield* Effect.promise(() =>
    handler(
      new Request("http://test/rpc", {
        method: "POST",
        body: `{"_tag":"Request","id":1,"tag":"events","payload":{},"headers":[]}\n`
      })
    )
  )
  yield* Effect.addFinalizer(() => response.body === null ? Effect.void : Effect.promise(() => response.body!.cancel()))
  for (let i = 0; i < 100; i++) {
    yield* Effect.yieldNow
  }

  return produced
})

describe("RpcServer", () => {
  it.effect("applies backpressure to framed HTTP responses by default", () =>
    Effect.gen(function*() {
      const produced = yield* producedWithoutReadingFramedBody()

      assert.isAbove(produced, 0)
      assert.isBelow(produced, 10_000)
    }))

  it.effect("uses the configured framed HTTP response buffer size", () =>
    Effect.gen(function*() {
      const produced = yield* producedWithoutReadingFramedBody(1)

      assert.isAbove(produced, 0)
      assert.isBelow(produced, 16)
    }))

  it.effect("allows unbounded framed HTTP response buffering", () =>
    Effect.gen(function*() {
      const produced = yield* producedWithoutReadingFramedBody("unbounded")

      assert.strictEqual(produced, 10_000)
    }))

  it.effect("keeps non-framed HTTP responses unbounded", () =>
    Effect.gen(function*() {
      let produced = 0
      const Rpcs = RpcGroup.make(Rpc.make("events", {
        payload: Schema.Struct({}),
        success: Schema.Number,
        stream: true
      }))
      const Handlers = Rpcs.toLayerHandler(
        "events",
        () => Stream.fromEffectRepeat(Effect.sync(() => ++produced)).pipe(Stream.take(100))
      )
      const Server = RpcServer.layerHttp({
        group: Rpcs,
        path: "/rpc",
        protocol: "http",
        streamBufferSize: 1
      }).pipe(
        Layer.provide(Handlers),
        Layer.provide(RpcSerialization.layerJson)
      )
      const { dispose, handler } = HttpRouter.toWebHandler(Server)
      yield* Effect.addFinalizer(() => Effect.promise(dispose))

      yield* Effect.promise(() =>
        handler(
          new Request("http://test/rpc", {
            method: "POST",
            body: `{"_tag":"Request","id":1,"tag":"events","payload":{},"headers":[]}`
          })
        )
      )

      assert.strictEqual(produced, 100)
    }))

  it.effect("closes a socket when the serialization buffer limit is exceeded", () =>
    Effect.gen(function*() {
      const handledChunks: Array<string> = []
      const writes: Array<Uint8Array | string | Socket.CloseEvent> = []
      const completed = yield* Deferred.make<void>()
      let closed = false

      const socket = Socket.make({
        runRaw: (handler) =>
          Effect.gen(function*() {
            for (const chunk of ["12", "34", "5", "{\"_tag\":\"Ping\"}\n"]) {
              if (closed) break
              handledChunks.push(chunk)
              const result = handler(chunk)
              if (Effect.isEffect(result)) {
                yield* result
              }
            }
          }).pipe(Effect.ensuring(Deferred.succeed(completed, void 0))),
        writer: Effect.succeed((chunk) =>
          Effect.sync(() => {
            writes.push(chunk)
            if (Socket.isCloseEvent(chunk)) {
              closed = true
            }
          })
        )
      })
      const socketServer = SocketServer.SocketServer.of({
        address: {
          _tag: "TcpAddress",
          hostname: "localhost",
          port: 0
        },
        run: (handler) => handler(socket).pipe(Effect.orDie, Effect.andThen(Effect.never))
      })

      const protocol = yield* RpcServer.makeProtocolSocketServer.pipe(
        Effect.provide(Layer.succeed(SocketServer.SocketServer, socketServer)),
        Effect.provide(Layer.succeed(
          RpcSerialization.RpcSerialization,
          RpcSerialization.makeNdjson({ maxBufferSize: 4 })
        ))
      )
      yield* Effect.forkScoped(protocol.run(() => Effect.void))
      yield* Deferred.await(completed)

      assert.deepStrictEqual(handledChunks, ["12", "34", "5"])
      assert.strictEqual(writes.length, 1)
      const closeEvent = writes[0]
      assert(Socket.isCloseEvent(closeEvent))
      assert.strictEqual(closeEvent.code, 1009)
    }))
})
