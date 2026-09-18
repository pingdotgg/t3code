import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { Rpc, RpcClient, RpcGroup, RpcMessage, RpcSchema, RpcSerialization } from "effect/unstable/rpc"
import { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import * as Socket from "effect/unstable/socket/Socket"
import * as Worker from "effect/unstable/workers/Worker"
import { WorkerError, WorkerReceiveError } from "effect/unstable/workers/WorkerError"
import { vi } from "vitest"
import type * as RpcClientErrorModule from "../../src/unstable/rpc/RpcClientError.ts"

const TestGroup = RpcGroup.make(
  Rpc.make("Ping", { success: Schema.String }),
  Rpc.make("Events", { success: RpcSchema.Stream(Schema.String, Schema.Never) })
)

const makeHttpClient = (body: string): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { status: 200 })
      )
    )
  )

const makeProtocolLayerWithClient = (
  serializationLayer: Layer.Layer<RpcSerialization.RpcSerialization>,
  client: HttpClient.HttpClient
) =>
  RpcClient.layerProtocolHttp({ url: "http://localhost/rpc" }).pipe(
    Layer.provideMerge(serializationLayer),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client))
  )

const makeProtocolLayer = (
  serializationLayer: Layer.Layer<RpcSerialization.RpcSerialization>,
  body: string
) => makeProtocolLayerWithClient(serializationLayer, makeHttpClient(body))

const assertEmptyResponseFailsRequest = (
  serializationLayer: Layer.Layer<RpcSerialization.RpcSerialization>,
  body: string
) =>
  Effect.gen(function*() {
    const client = yield* RpcClient.make(TestGroup).pipe(
      Effect.provide(makeProtocolLayer(serializationLayer, body))
    )

    const cause = yield* client.Ping().pipe(
      Effect.timeout("1 second"),
      Effect.sandbox,
      Effect.flip
    )

    const error = Cause.squash(cause)
    assert.instanceOf(error, RpcClientError)
    assert.strictEqual(error.reason._tag, "RpcClientDefect")
    assert.strictEqual(error.reason.message, "Received empty HTTP response from RPC server")
  })

describe("RpcClient", () => {
  it.effect("releases a worker pool slot when the worker run fails", () =>
    Effect.gen(function*() {
      const runFailure = yield* Deferred.make<never, WorkerError>()
      const firstRequestSent = yield* Deferred.make<void>()
      const secondRequestSent = yield* Deferred.make<void>()
      const protocolErrorReceived = yield* Deferred.make<void>()
      const sentRequestIds: Array<string | number> = []
      let runCount = 0
      const backing: Worker.Worker<any, any> = {
        send(message) {
          return Effect.sync(() => {
            if (message._tag !== "Request") return
            sentRequestIds.push(message.id)
          }).pipe(
            Effect.andThen(
              message._tag === "Request" && message.id === 1
                ? Deferred.succeed(firstRequestSent, void 0)
                : message._tag === "Request" && message.id === 2
                ? Deferred.succeed(secondRequestSent, void 0)
                : Effect.void
            )
          )
        },
        run() {
          return runCount++ === 0 ? Deferred.await(runFailure) : Effect.never
        }
      }
      const workerPlatform = Worker.WorkerPlatform.of({
        spawn: () => Effect.succeed(backing)
      })
      const protocol = yield* RpcClient.makeProtocolWorker({ size: 1, concurrency: 1 }).pipe(
        Effect.provideService(Worker.WorkerPlatform, workerPlatform),
        Effect.provideService(Worker.Spawner, (() => undefined) as Worker.SpawnerFn)
      )
      yield* protocol.run(0, (response) =>
        response._tag === "ClientProtocolError"
          ? Deferred.succeed(protocolErrorReceived, void 0)
          : Effect.void).pipe(Effect.forkScoped)

      const request = (id: number) => ({
        _tag: "Request" as const,
        id,
        tag: "Test",
        payload: null,
        headers: []
      })
      const first = yield* protocol.send(0, request(1)).pipe(Effect.forkChild)
      yield* Deferred.await(firstRequestSent)
      yield* Deferred.fail(
        runFailure,
        new WorkerError({ reason: new WorkerReceiveError({ message: "worker exited" }) })
      )
      yield* Deferred.await(protocolErrorReceived)

      const firstCompleted = yield* Fiber.join(first).pipe(
        Effect.timeout("1 second"),
        Effect.forkChild
      )
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(firstCompleted)

      const second = yield* protocol.send(0, request(2)).pipe(Effect.forkChild)
      const secondSent = yield* Deferred.await(secondRequestSent).pipe(
        Effect.timeout("1 second"),
        Effect.forkChild
      )
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(secondSent)
      yield* Fiber.interrupt(second)
      assert.deepStrictEqual(sentRequestIds, [1, 2])
    }))

  it("preserves RpcClientError failures from a reloaded module copy", async () => {
    vi.resetModules()
    const ForeignRpcClientError = await vi.importActual<typeof RpcClientErrorModule>(
      "../../src/unstable/rpc/RpcClientError.ts"
    )
    const rpcClientError = new ForeignRpcClientError.RpcClientError({
      reason: new ForeignRpcClientError.RpcClientDefect({ message: "boom", cause: undefined })
    })
    assert.isFalse(rpcClientError instanceof RpcClientError)

    const httpClient = HttpClient.make((request) => {
      const response = HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))
      Object.defineProperty(response, "stream", { value: Stream.fail(rpcClientError) })
      return Effect.succeed(response)
    })
    const error = await Effect.gen(function*() {
      const client = yield* RpcClient.make(TestGroup).pipe(
        Effect.provide(makeProtocolLayerWithClient(RpcSerialization.layerNdjson, httpClient))
      )
      return yield* client.Ping().pipe(Effect.flip)
    }).pipe(Effect.scoped, Effect.runPromise)

    assert.strictEqual(error, rpcClientError)
  })

  it.effect("fails request on empty HTTP response for unframed serialization", () =>
    assertEmptyResponseFailsRequest(RpcSerialization.layerJson, "[]"))

  it.effect("fails request on empty HTTP response for framed serialization", () =>
    assertEmptyResponseFailsRequest(RpcSerialization.layerNdjson, ""))

  it.effect("defects request when framed HTTP response closes before request completes", () =>
    Effect.gen(function*() {
      const client = yield* RpcClient.make(TestGroup, {
        generateRequestId: () => RpcMessage.RequestId("0")
      }).pipe(
        Effect.provide(makeProtocolLayer(
          RpcSerialization.layerNdjson,
          JSON.stringify({ _tag: "Chunk", requestId: "0", values: ["event"] }) + "\n"
        ))
      )

      const cause = yield* client.Events().pipe(
        Stream.runDrain,
        Effect.timeout("1 second"),
        Effect.sandbox,
        Effect.flip
      )

      const error = Cause.squash(cause)
      assert.instanceOf(error, RpcClientError)
      assert.strictEqual(error.reason._tag, "RpcClientDefect")
      assert.strictEqual(error.reason.message, "HTTP response ended before RPC request completed")
    }))

  it.effect("reports transient socket open errors without failing in-flight streams", () =>
    Effect.gen(function*() {
      const requestSent = yield* Deferred.make<void>()
      const threeErrors = yield* Deferred.make<void>()
      const errors: Array<RpcClientError> = []
      const socketError = new Socket.SocketError({
        reason: new Socket.SocketOpenError({
          kind: "Unknown",
          cause: new Error("connection refused")
        })
      })
      const socket = Socket.make({
        reader: Effect.succeed({
          pull: Deferred.await(requestSent).pipe(Effect.andThen(Effect.fail(socketError))),
          upgrade: Socket.SocketUpgradeError.unsupported
        }),
        writer: Effect.succeed({
          write: () => Effect.asVoid(Deferred.succeed(requestSent, void 0)),
          writeAll: () => Effect.asVoid(Deferred.succeed(requestSent, void 0))
        })
      })
      const protocol = yield* RpcClient.makeProtocolSocket({
        retryTransientErrors: true,
        retryPolicy: Schedule.spaced("1 millis"),
        onTransientError: (error) =>
          Effect.suspend(() => {
            errors.push(error)
            return errors.length === 3 ? Deferred.succeed(threeErrors, void 0) : Effect.void
          })
      }).pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerNdjson)
      )
      const client = yield* RpcClient.make(TestGroup).pipe(
        Effect.provideService(RpcClient.Protocol, protocol)
      )
      const streamFiber = yield* client.Events().pipe(Stream.runDrain, Effect.forkChild)

      yield* TestClock.adjust("2 millis")
      yield* Deferred.await(threeErrors).pipe(Effect.timeout("1 second"))

      assert.lengthOf(errors, 3)
      for (const error of errors) {
        assert.strictEqual(error.reason._tag, "SocketOpenError")
      }
      assert.isUndefined(streamFiber.pollUnsafe())
    }))

  it.effect("fails in-flight streams when transient retries are exhausted", () =>
    Effect.gen(function*() {
      const requestSent = yield* Deferred.make<void>()
      const socketError = new Socket.SocketError({
        reason: new Socket.SocketOpenError({
          kind: "Unknown",
          cause: new Error("connection refused")
        })
      })
      const socket = Socket.make({
        reader: Effect.succeed({
          pull: Deferred.await(requestSent).pipe(Effect.andThen(Effect.fail(socketError))),
          upgrade: Socket.SocketUpgradeError.unsupported
        }),
        writer: Effect.succeed({
          write: () => Effect.asVoid(Deferred.succeed(requestSent, void 0)),
          writeAll: () => Effect.asVoid(Deferred.succeed(requestSent, void 0))
        })
      })
      const protocol = yield* RpcClient.makeProtocolSocket({
        retryTransientErrors: true,
        retryPolicy: Schedule.recurs(2)
      }).pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerNdjson)
      )
      const client = yield* RpcClient.make(TestGroup).pipe(
        Effect.provideService(RpcClient.Protocol, protocol)
      )
      const streamFiber = yield* client.Events().pipe(
        Stream.runDrain,
        Effect.timeout("1 second"),
        Effect.flip,
        Effect.forkChild
      )

      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(streamFiber)

      assert.instanceOf(error, RpcClientError)
      assert.strictEqual(error.reason._tag, "SocketOpenError")
    }))

  it.effect("continues retrying when the transient error hook defects", () =>
    Effect.gen(function*() {
      const requestSent = yield* Deferred.make<void>()
      let attempts = 0
      const socketError = new Socket.SocketError({
        reason: new Socket.SocketOpenError({
          kind: "Unknown",
          cause: new Error("connection refused")
        })
      })
      const socket = Socket.make({
        reader: Effect.succeed({
          pull: Deferred.await(requestSent).pipe(
            Effect.tap(() => Effect.sync(() => attempts++)),
            Effect.andThen(Effect.fail(socketError))
          ),
          upgrade: Socket.SocketUpgradeError.unsupported
        }),
        writer: Effect.succeed({
          write: () => Effect.asVoid(Deferred.succeed(requestSent, void 0)),
          writeAll: () => Effect.asVoid(Deferred.succeed(requestSent, void 0))
        })
      })
      const protocol = yield* RpcClient.makeProtocolSocket({
        retryTransientErrors: true,
        retryPolicy: Schedule.recurs(2),
        onTransientError: () => Effect.die("hook defect")
      }).pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerNdjson)
      )
      const client = yield* RpcClient.make(TestGroup).pipe(
        Effect.provideService(RpcClient.Protocol, protocol)
      )
      const streamFiber = yield* client.Events().pipe(
        Stream.runDrain,
        Effect.timeout("1 second"),
        Effect.flip,
        Effect.forkChild
      )

      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(streamFiber)

      assert.strictEqual(attempts, 3)
      assert.instanceOf(error, RpcClientError)
      assert.strictEqual(error.reason._tag, "SocketOpenError")
    }))
})
