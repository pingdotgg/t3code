import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Scope from "effect/Scope"
import * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"

type EventType = "open" | "message" | "error" | "close"

class TestWebSocket implements Socket.WebSocketLike {
  readonly listeners = new Map<
    EventType,
    Set<{ readonly listener: (event: Socket.WebSocketEvent) => void; readonly once: boolean }>
  >()
  readyState = 0
  readonly closes: Array<ReadonlyArray<unknown>> = []
  // Like a global WebSocket, which only accepts 1000 and 3000-4999.
  rejectsCloseCode = false

  constructor(readonly openListenerAttached: Latch.Latch) {}

  addEventListener(
    type: EventType,
    listener: (event: Socket.WebSocketEvent) => void,
    options?: { readonly once?: boolean }
  ): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add({ listener, once: options?.once === true })
    this.listeners.set(type, listeners)
    if (type === "open") this.openListenerAttached.openUnsafe()
  }

  removeEventListener(type: EventType, listener: (event: Socket.WebSocketEvent) => void): void {
    const listeners = this.listeners.get(type)
    if (listeners === undefined) return
    for (const entry of listeners) {
      if (entry.listener === listener) listeners.delete(entry)
    }
  }

  dispatch(type: EventType, event: Socket.WebSocketEvent): void {
    const listeners = this.listeners.get(type)
    if (listeners === undefined) return
    for (const entry of Array.from(listeners)) {
      if (entry.once) listeners.delete(entry)
      entry.listener(event)
    }
  }

  listenerCount(type: EventType): number {
    return this.listeners.get(type)?.size ?? 0
  }

  close(...args: ReadonlyArray<unknown>): void {
    if (args.length > 0 && this.rejectsCloseCode) throw new Error("InvalidAccessError")
    this.closes.push(args)
  }
  send(): void {}
}

class PausableTestWebSocket extends TestWebSocket {
  pauseCount = 0
  resumeCount = 0

  pause(): void {
    this.pauseCount++
  }

  resume(): void {
    this.resumeCount++
  }
}

const stubSocket = (pull: Socket.Reader["pull"]) => {
  let upgraded = false
  const socket = Socket.make({
    reader: Effect.succeed({
      pull,
      upgrade: () =>
        Effect.sync(() => {
          upgraded = true
        })
    }),
    writer: Effect.succeed({
      write: () => Effect.void,
      writeAll: () => Effect.void
    })
  })
  return { socket, wasUpgraded: () => upgraded }
}

describe("Socket", () => {
  describe("make", () => {
    it.effect("exposes TLS upgrade on the acquired reader", () =>
      Effect.gen(function*() {
        const { socket, wasUpgraded } = stubSocket(Effect.never)

        const { upgrade } = yield* socket.reader
        yield* upgrade()

        assert.isTrue(wasUpgraded())
      }))

    it.effect("readerBytes maps pulls to bytes", () =>
      Effect.gen(function*() {
        const { socket } = stubSocket(Effect.succeed(["hello"]))

        const pull = yield* Socket.readerBytes(socket)
        const [message] = yield* pull

        assert.deepStrictEqual(message, new TextEncoder().encode("hello"))
      }))

    it.effect("readerString maps pulls to strings", () =>
      Effect.gen(function*() {
        const { socket } = stubSocket(Effect.succeed([new TextEncoder().encode("hello")]))

        const pull = yield* Socket.readerString(socket)
        const [message] = yield* pull

        assert.strictEqual(message, "hello")
      }))

    it.effect("readerString decodes characters split across pulls", () =>
      Effect.gen(function*() {
        const pulls: Array<[Uint8Array]> = [[new Uint8Array([0x61, 0xe2, 0x98])], [new Uint8Array([0x95])]]
        const { socket } = stubSocket(Effect.sync(() => pulls.shift()!))

        const pull = yield* Socket.readerString(socket)
        assert.deepStrictEqual(yield* pull, ["a"])
        assert.deepStrictEqual(yield* pull, ["☕"])
      }))

    it.effect("readerString flushes an incomplete character before a string frame", () =>
      Effect.gen(function*() {
        const { socket } = stubSocket(Effect.succeed([new Uint8Array([0x61, 0xe2]), "b"]))

        const pull = yield* Socket.readerString(socket)
        assert.deepStrictEqual(yield* pull, ["a", "\ufffdb"])
      }))

    it.effect("readerString flushes an incomplete character on a normal close", () =>
      Effect.gen(function*() {
        const close = new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) })
        const pulls: Array<Socket.Reader["pull"]> = [
          Effect.succeed([new Uint8Array([0x61, 0xe2, 0x98])])
        ]
        const { socket } = stubSocket(Effect.suspend(() => pulls.shift() ?? Effect.fail(close)))

        const pull = yield* Socket.readerString(socket)
        assert.deepStrictEqual(yield* pull, ["a"])
        assert.deepStrictEqual(yield* pull, ["\ufffd"])
        assert.deepStrictEqual(yield* Effect.flip(pull), close)
      }))
  })

  describe("fromWebSocket", () => {
    it.effect("fails writes on a terminal non-reconnectable socket", () =>
      Effect.gen(function*() {
        const ws = new TestWebSocket(Latch.makeUnsafe(false))
        ws.readyState = 1
        const scope = yield* Scope.make()
        const socket = yield* Socket.fromWebSocket(Scope.close(scope, Exit.void).pipe(Effect.as(ws)), {
          disableReconnects: true
        })
        const writer = yield* socket.writer

        const write = yield* Effect.flip(writer.write("later")).pipe(Effect.forkChild({ startImmediately: true }))
        const error = yield* Effect.flip(Scope.provide(socket.reader, scope))
        assert.isTrue(Socket.isSocketError(error))
        assert.strictEqual(yield* Fiber.join(write), error)
      }))

    it.effect("removes the open listener when the socket closes while connecting", () =>
      Effect.gen(function*() {
        const openListenerAttached = Latch.makeUnsafe(false)
        const ws = new TestWebSocket(openListenerAttached)
        const socket = yield* Socket.fromWebSocket(Effect.succeed(ws))
        const reader = yield* socket.reader.pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true })
        )

        yield* openListenerAttached.await
        ws.dispatch("close", { code: 1006, reason: "closed while connecting" })

        assert.isTrue(Exit.isFailure(yield* Fiber.join(reader)))
        assert.strictEqual(ws.listenerCount("open"), 0)
      }))

    it.effect("pauses at the highWaterMark and resumes after draining", () =>
      Effect.gen(function*() {
        const ws = new PausableTestWebSocket(Latch.makeUnsafe(false))
        ws.readyState = 1
        const socket = yield* Socket.fromWebSocket(Effect.succeed(ws), { highWaterMark: 10 })
        const { pull } = yield* socket.reader
        const firstPull = yield* pull.pipe(Effect.forkChild({ startImmediately: true }))

        ws.dispatch("message", { data: "first" })
        assert.deepStrictEqual(yield* Fiber.join(firstPull), ["first"])

        ws.dispatch("message", { data: "hello" })
        assert.strictEqual(ws.pauseCount, 0)
        ws.dispatch("message", { data: "world" })
        assert.strictEqual(ws.pauseCount, 1)

        assert.deepStrictEqual(yield* pull, ["hello", "world"])
        assert.strictEqual(ws.resumeCount, 1)
      }))

    it.effect("counts text frames toward the highWaterMark by UTF-8 byte length", () =>
      Effect.gen(function*() {
        const ws = new PausableTestWebSocket(Latch.makeUnsafe(false))
        ws.readyState = 1
        const socket = yield* Socket.fromWebSocket(Effect.succeed(ws), { highWaterMark: 3 })
        const { pull } = yield* socket.reader

        ws.dispatch("message", { data: "€" })

        assert.strictEqual(ws.pauseCount, 1)
        assert.deepStrictEqual(yield* pull, ["€"])
      }))

    it.effect("uses the default highWaterMark for pausable sockets", () =>
      Effect.gen(function*() {
        const ws = new PausableTestWebSocket(Latch.makeUnsafe(false))
        ws.readyState = 1
        const socket = yield* Socket.fromWebSocket(Effect.succeed(ws))
        const { pull } = yield* socket.reader
        const payload = "a".repeat(64 * 1024)

        ws.dispatch("message", { data: payload })
        assert.strictEqual(ws.pauseCount, 1)
        assert.deepStrictEqual(yield* pull, [payload])
        assert.strictEqual(ws.resumeCount, 1)
      }))

    it.effect("counts empty frames toward the highWaterMark and never fails a pausable socket", () =>
      Effect.gen(function*() {
        const ws = new PausableTestWebSocket(Latch.makeUnsafe(false))
        ws.readyState = 1
        const socket = yield* Socket.fromWebSocket(Effect.succeed(ws), { highWaterMark: 2 })
        const { pull } = yield* socket.reader

        ws.dispatch("message", { data: "" })
        ws.dispatch("message", { data: "" })
        assert.strictEqual(ws.pauseCount, 1)
        // frames already in flight when the transport paused
        ws.dispatch("message", { data: "abc" })

        assert.deepStrictEqual(yield* pull, ["", "", "abc"])
        assert.strictEqual(ws.resumeCount, 1)
        assert.deepStrictEqual(ws.closes, [])
      }))

    for (
      const { closes, frames, highWaterMark, name, rejectsCloseCode, retained } of [
        { name: "byte frames", highWaterMark: 2, frames: ["a", "b", "c", "d"], retained: 3 },
        { name: "empty frames", highWaterMark: 2, frames: ["", "", "", ""], retained: 3 },
        // "€" is 3 bytes, so it is the frame that takes the queue above the mark
        { name: "a multibyte frame crossing the mark", highWaterMark: 3, frames: ["a", "€", "b", "c"], retained: 2 },
        { name: "a single frame larger than the mark", highWaterMark: 2, frames: ["abc", "d"], retained: 1 },
        {
          name: "a transport rejecting close code 1008",
          highWaterMark: 2,
          frames: ["a", "b", "c", "d"],
          retained: 3,
          rejectsCloseCode: true,
          closes: [[]]
        }
      ]
    ) {
      it.effect(`fails a socket without pause once the highWaterMark is exceeded: ${name}`, () =>
        Effect.gen(function*() {
          const ws = new TestWebSocket(Latch.makeUnsafe(false))
          ws.readyState = 1
          ws.rejectsCloseCode = rejectsCloseCode === true
          const socket = yield* Socket.fromWebSocket(Effect.succeed(ws), { highWaterMark })
          const { pull } = yield* socket.reader

          for (const data of frames) ws.dispatch("message", { data })

          assert.deepStrictEqual([...(yield* pull)], frames.slice(0, retained))
          const error = yield* Effect.flip(pull)
          assert(error.reason._tag === "SocketReadError")
          assert.strictEqual(
            String(error.reason.cause),
            `Error: Socket highWaterMark of ${highWaterMark} bytes exceeded`
          )
          assert.deepStrictEqual(ws.closes, closes ?? [[1008, "Inbound message buffer limit exceeded"]])
        }))
    }
  })

  describe("toChannel", () => {
    it.effect("reports a write failure while a pull is suspended", () =>
      Effect.gen(function*() {
        const writeError = new Socket.SocketError({
          reason: new Socket.SocketWriteError({ cause: new Error("write failed") })
        })
        // an idle reader that only fails once its acquisition scope closes,
        // which is the whole reason `toChannel` needs no per-pull race
        const socket = Socket.make({
          reader: Effect.gen(function*() {
            const closed = Latch.makeUnsafe(false)
            yield* Effect.addFinalizer(() => closed.open)
            return {
              pull: Effect.andThen(
                closed.await,
                Effect.fail(new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) }))
              ),
              upgrade: Socket.SocketUpgradeError.unsupported
            }
          }),
          writer: Effect.succeed({
            write: () => Effect.fail(writeError),
            writeAll: () => Effect.fail(writeError)
          })
        })

        const exit = yield* Stream.make("hello").pipe(
          Stream.encodeText,
          Stream.pipeThroughChannel(Socket.toChannel(socket)),
          Stream.runDrain,
          Effect.exit
        )

        assert.deepStrictEqual(exit, Exit.fail(writeError))
      }))
  })
})
