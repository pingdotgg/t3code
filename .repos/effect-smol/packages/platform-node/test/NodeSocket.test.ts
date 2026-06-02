import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Queue } from "effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import { Socket, type SocketServer } from "effect/unstable/socket"
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
        yield* Effect.promise(async () => {
          await expect(server).toReceiveMessage(new TextEncoder().encode("Hello"))
          await expect(server).toReceiveMessage(new TextEncoder().encode("World"))
        })

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
  })
})
