import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Queue } from "effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { Socket, type SocketServer } from "effect/unstable/socket"
import * as Net from "node:net"
import { WS } from "vitest-websocket-mock"

const makeServer = Effect.gen(function*() {
  const server = yield* NodeSocketServer.make({ port: 0 })

  yield* server.run(Effect.fnUntraced(function*(socket) {
    const write = yield* socket.writer
    yield* socket.run(write)
  }, Effect.scoped)).pipe(Effect.forkScoped)

  return server
})

describe("Socket", () => {
  it.live("closes with a pending pre-run socket", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(Scope.provide(scope))
      assert.strictEqual(server.address._tag, "TcpAddress")
      if (server.address._tag !== "TcpAddress") return
      const socket = Net.createConnection({ host: "127.0.0.1", port: server.address.port })
      yield* Effect.promise(() =>
        new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve)
          socket.once("error", reject)
        })
      )
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
      const exit = yield* Fiber.await(closing).pipe(
        Effect.timeout("1 second"),
        Effect.ensuring(Effect.sync(() => socket.destroy()))
      )
      assert.isTrue(Exit.isSuccess(exit))
    }))

  it.live("closes with a pending pre-run WebSocket", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const server = yield* NodeSocketServer.makeWebSocket({ host: "127.0.0.1", port: 0 }).pipe(Scope.provide(scope))
      assert.strictEqual(server.address._tag, "TcpAddress")
      if (server.address._tag !== "TcpAddress") return
      const socket = new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${server.address.port}`)
      yield* Effect.promise(() =>
        new Promise<void>((resolve, reject) => {
          socket.once("open", resolve)
          socket.once("error", reject)
        })
      )
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
      const exit = yield* Fiber.await(closing).pipe(
        Effect.timeout("1 second"),
        Effect.ensuring(Effect.sync(() => socket.terminate()))
      )
      assert.isTrue(Exit.isSuccess(exit))
    }))

  it.effect("open", () =>
    Effect.gen(function*() {
      const server = yield* makeServer
      const channel = NodeSocket.makeNetChannel({ port: (server.address as SocketServer.TcpAddress).port })

      const outputEffect = Stream.make("Hello", "World").pipe(
        Stream.encodeText,
        Stream.pipeThroughChannel(channel),
        Stream.decodeText(),
        Stream.mkString
      )

      const output = yield* outputEffect
      assert.strictEqual(output, "HelloWorld")
    }))

  it.live("respects a zero open timeout", () =>
    Effect.gen(function*() {
      const socket = yield* NodeSocket.fromDuplex(Effect.never, { openTimeout: 0 })
      const error = yield* socket.runRaw(() => {}).pipe(
        Effect.flip,
        Effect.timeout("1 second")
      )
      assert.strictEqual(error.reason._tag, "SocketOpenError")
      if (error.reason._tag === "SocketOpenError") {
        assert.strictEqual(error.reason.kind, "Timeout")
      }
    }))

  describe("WebSocket", () => {
    const url = `ws://localhost:1234`

    const makeServer = Effect.acquireRelease(
      Effect.sync(() => new WS(url)),
      (ws) =>
        Effect.sync(() => {
          ws.close()
          WS.clean()
        })
    )

    it.effect("messages", () =>
      Effect.gen(function*() {
        const server = yield* makeServer
        const socket = yield* Socket.makeWebSocket(Effect.succeed(url), {
          closeCodeIsError: () => false
        })
        const messages = yield* Queue.unbounded<Uint8Array>()
        const fiber = yield* Effect.forkChild(socket.run((_) => Queue.offer(messages, _)))
        yield* Effect.gen(function*() {
          const write = yield* socket.writer
          yield* write(new TextEncoder().encode("Hello"))
          yield* write(new TextEncoder().encode("World"))
        }).pipe(Effect.scoped)
        assert.deepStrictEqual(yield* Effect.promise(() => server.nextMessage), new TextEncoder().encode("Hello"))
        assert.deepStrictEqual(yield* Effect.promise(() => server.nextMessage), new TextEncoder().encode("World"))

        server.send("Right back at you!")
        let message = yield* Queue.take(messages)
        assert.deepStrictEqual(message, new TextEncoder().encode("Right back at you!"))

        server.send(new Blob(["A Blob message"]))
        message = yield* Queue.take(messages)
        assert.deepStrictEqual(message, new TextEncoder().encode("A Blob message"))

        server.close()
        const exit = yield* Fiber.await(fiber)
        assert.strictEqual(exit._tag, "Success")
      }).pipe(
        Effect.provideService(Socket.WebSocketConstructor, (url) => new globalThis.WebSocket(url))
      ))

    it.effect("close codes are errors by default", () =>
      Effect.gen(function*() {
        const server = yield* makeServer
        const socket = yield* Socket.makeWebSocket(Effect.succeed(url))
        const fiber = yield* Effect.forkChild(socket.run(() => {}))

        yield* Effect.promise(() => server.connected)
        server.close({ code: 1000, reason: "done", wasClean: true })

        const exit = yield* Effect.exit(Fiber.join(fiber))
        assert.isTrue(exit._tag === "Failure")
        if (exit._tag === "Failure") {
          const failure = exit.cause.reasons[0]
          if (failure._tag === "Fail") {
            assert.isTrue(failure.error instanceof Socket.SocketError)
            assert.strictEqual(failure.error.reason._tag, "SocketCloseError")
            if (failure.error.reason._tag === "SocketCloseError") {
              assert.strictEqual(failure.error.reason.code, 1000)
              assert.strictEqual(failure.error.reason.closeReason, "done")
            }
          }
        }
      }).pipe(
        Effect.provideService(Socket.WebSocketConstructor, (url) => new globalThis.WebSocket(url))
      ))

    it.effect("reports send errors as SocketError", () =>
      Effect.gen(function*() {
        class ThrowingWebSocket extends EventTarget {
          readonly readyState = globalThis.WebSocket.OPEN

          close(): void {}

          send(): void {
            throw new Error("send failed")
          }
        }
        const webSocket = new ThrowingWebSocket()
        const socket = yield* Socket.makeWebSocket(Effect.succeed(url), { closeCodeIsError: () => false }).pipe(
          Effect.provideService(
            Socket.WebSocketConstructor,
            () => webSocket as unknown as globalThis.WebSocket
          )
        )
        const exit = yield* Effect.scoped(Effect.gen(function*() {
          const run = yield* Effect.forkChild(socket.runRaw(() => {}))
          const write = yield* socket.writer
          const exit = yield* Effect.exit(write(new Uint8Array([1])))
          webSocket.dispatchEvent(new CloseEvent("close", { code: 1000 }))
          yield* Fiber.join(run)
          return exit
        }))
        assert.strictEqual(exit._tag, "Failure")
        if (exit._tag === "Failure") {
          assert.strictEqual(exit.cause.reasons[0]?._tag, "Fail")
          const reason = exit.cause.reasons[0]
          if (reason?._tag === "Fail") {
            assert.isTrue(Socket.SocketError.is(reason.error))
            assert.strictEqual(reason.error.reason._tag, "SocketWriteError")
          }
        }
      }))
  })

  describe("TransformStream", () => {
    it.effect("works", () =>
      Effect.gen(function*() {
        const readable = Stream.make("A", "B", "C").pipe(
          Stream.tap(() => Effect.sleep(50)),
          Stream.toReadableStream()
        )
        const decoder = new TextDecoder()
        const chunks: Array<string> = []
        const writable = new WritableStream<Uint8Array>({
          write(chunk) {
            chunks.push(decoder.decode(chunk))
          }
        })

        const socket = yield* Socket.fromTransformStream(
          Effect.succeed({
            readable,
            writable
          }),
          {
            closeCodeIsError: () => false
          }
        )
        yield* socket.writer.pipe(
          Effect.tap((write) =>
            write("Hello").pipe(
              Effect.andThen(write("World"))
            )
          ),
          Effect.scoped,
          Effect.forkChild
        )
        const received: Array<string> = []
        yield* socket.run((chunk) =>
          Effect.sync(() => {
            received.push(decoder.decode(chunk))
          })
        ).pipe(Effect.scoped)

        assert.deepStrictEqual(chunks, ["Hello", "World"])
        assert.deepStrictEqual(received, ["A", "B", "C"])
      }))

    it.effect("reports writable stream rejection as SocketError", () =>
      Effect.gen(function*() {
        const socket = yield* Socket.fromTransformStream(Effect.succeed({
          readable: new ReadableStream<Uint8Array>({}),
          writable: new WritableStream<Uint8Array>({
            write: () => Promise.reject(new Error("write failed"))
          })
        }))
        const exit = yield* Effect.scoped(Effect.gen(function*() {
          const run = yield* Effect.forkChild(socket.runRaw(() => {}))
          const write = yield* socket.writer
          const exit = yield* Effect.exit(write(new Uint8Array([1])))
          yield* Fiber.interrupt(run)
          return exit
        }))
        assert.strictEqual(exit._tag, "Failure")
        if (exit._tag === "Failure") {
          assert.strictEqual(exit.cause.reasons[0]?._tag, "Fail")
          const reason = exit.cause.reasons[0]
          if (reason?._tag === "Fail") {
            assert.isTrue(Socket.SocketError.is(reason.error))
            assert.strictEqual(reason.error.reason._tag, "SocketWriteError")
          }
        }
      }))
  })
})
