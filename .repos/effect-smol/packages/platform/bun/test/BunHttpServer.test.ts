import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as Net from "node:net"

const fetchText = (url: string) =>
  Effect.promise(() => fetch(url, { headers: { connection: "close" } }).then((response) => response.text()))

interface WebSocketFrame {
  readonly opcode: number
  readonly payload: Uint8Array
  readonly payloadLength: number
  readonly rsv1: boolean
}

interface WebSocketFrames {
  readonly frames: ReadonlyArray<WebSocketFrame>
  readonly headers: string
}

const readWebSocketFrames = (port: number, perMessageDeflate: boolean) =>
  Effect.callback<WebSocketFrames, Error>((resume) => {
    const socket = Net.createConnection({ host: "127.0.0.1", port })
    let received = Buffer.alloc(0)
    let result: WebSocketFrames | undefined

    socket.on("connect", () => {
      socket.write([
        "GET / HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...(perMessageDeflate ? ["Sec-WebSocket-Extensions: permessage-deflate"] : []),
        "",
        ""
      ].join("\r\n"))
    })
    socket.on("error", (error) => resume(Effect.fail(error)))
    socket.on("close", () => {
      if (result) resume(Effect.succeed(result))
    })
    socket.on("data", (chunk) => {
      if (result) return
      received = Buffer.concat([received, typeof chunk === "string" ? Buffer.from(chunk) : chunk])
      const headerEnd = received.indexOf("\r\n\r\n")
      if (headerEnd === -1) return

      const headers = received.subarray(0, headerEnd).toString()
      const frames: Array<WebSocketFrame> = []
      let offset = headerEnd + 4
      while (frames.length < 2) {
        if (received.length < offset + 2) return
        const first = received[offset]
        const length = received[offset + 1] & 0x7f
        const headerLength = length === 126 ? 4 : 2
        if (received.length < offset + headerLength) return
        const payloadLength = length === 126 ? received.readUInt16BE(offset + 2) : length
        if (received.length < offset + headerLength + payloadLength) return
        frames.push({
          opcode: first & 0x0f,
          payload: Uint8Array.from(received.subarray(offset + headerLength, offset + headerLength + payloadLength)),
          payloadLength,
          rsv1: (first & 0x40) !== 0
        })
        offset += headerLength + payloadLength
      }
      result = { frames, headers }
      socket.write(Buffer.from([0x88, 0x82, 0, 0, 0, 0, 0x03, 0xe8]))
    })

    return Effect.sync(() => socket.destroy())
  })

const makeWebSocketServer = Effect.fnUntraced(function*(payload: string, compressionThreshold?: number) {
  const server = yield* BunHttpServer.make({
    hostname: "127.0.0.1",
    port: 0,
    websocket: { perMessageDeflate: true, compressionThreshold }
  })
  yield* server.serve(Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const socket = yield* request.upgrade
    const write = yield* socket.writer
    yield* socket.runRaw(() => undefined, {
      onOpen: Effect.gen(function*() {
        yield* Effect.orDie(write(payload))
        yield* Effect.orDie(write(new TextEncoder().encode(payload)))
      })
    })
    return HttpServerResponse.empty()
  }))
  return server
})

describe("BunHttpServer", () => {
  it.effect("closing an older serve scope keeps the newer handler active", () =>
    Effect.gen(function*() {
      const ownerScope = yield* Effect.scope
      const server = yield* BunHttpServer.make({
        hostname: "127.0.0.1",
        port: 0
      })
      const firstScope = yield* Scope.fork(ownerScope)
      const secondScope = yield* Scope.fork(ownerScope)

      yield* server.serve(Effect.succeed(HttpServerResponse.text("first"))).pipe(Scope.provide(firstScope))
      yield* server.serve(Effect.succeed(HttpServerResponse.text("second"))).pipe(Scope.provide(secondScope))
      const url = HttpServer.formatAddress(server.address)

      assert.strictEqual(yield* fetchText(url), "second")
      yield* Scope.close(firstScope, Exit.void)
      assert.strictEqual(yield* fetchText(url), "second")
    }))

  it.effect("closing the newer serve scope restores the older handler", () =>
    Effect.gen(function*() {
      const ownerScope = yield* Effect.scope
      const server = yield* BunHttpServer.make({
        hostname: "127.0.0.1",
        port: 0
      })
      const firstScope = yield* Scope.fork(ownerScope)
      const secondScope = yield* Scope.fork(ownerScope)

      yield* server.serve(Effect.succeed(HttpServerResponse.text("first"))).pipe(Scope.provide(firstScope))
      yield* server.serve(Effect.succeed(HttpServerResponse.text("second"))).pipe(Scope.provide(secondScope))
      const url = HttpServer.formatAddress(server.address)

      assert.strictEqual(yield* fetchText(url), "second")
      yield* Scope.close(secondScope, Exit.void)
      assert.strictEqual(yield* fetchText(url), "first")
    }))

  it.effect("compresses outgoing WebSocket messages when per-message deflate is negotiated", () =>
    Effect.gen(function*() {
      const payload = "a".repeat(4_096)
      const server = yield* makeWebSocketServer(payload)
      const port = (server.address as HttpServer.TcpAddress).port
      const { frames, headers } = yield* readWebSocketFrames(port, true)

      assert.match(headers, /^sec-websocket-extensions:.*permessage-deflate/im)
      assert.deepStrictEqual(frames.map((frame) => frame.opcode), [1, 2])
      assert.isTrue(frames.every((frame) => frame.rsv1))
      assert.isTrue(frames.every((frame) => frame.payloadLength < payload.length))
    }))

  it.effect("leaves small WebSocket messages uncompressed even when per-message deflate is negotiated", () =>
    Effect.gen(function*() {
      const payload = "a".repeat(64)
      const server = yield* makeWebSocketServer(payload)
      const port = (server.address as HttpServer.TcpAddress).port
      const { frames, headers } = yield* readWebSocketFrames(port, true)

      assert.match(headers, /^sec-websocket-extensions:.*permessage-deflate/im)
      assert.deepStrictEqual(frames.map((frame) => frame.opcode), [1, 2])
      assert.isFalse(frames.some((frame) => frame.rsv1))
      assert.isTrue(frames.every((frame) => frame.payloadLength === payload.length))
    }))

  it.effect("compresses small WebSocket messages when below a custom compressionThreshold", () =>
    Effect.gen(function*() {
      const payload = "a".repeat(64)
      const server = yield* makeWebSocketServer(payload, 32)
      const port = (server.address as HttpServer.TcpAddress).port
      const { frames } = yield* readWebSocketFrames(port, true)

      assert.deepStrictEqual(frames.map((frame) => frame.opcode), [1, 2])
      assert.isTrue(frames.every((frame) => frame.rsv1))
      assert.isTrue(frames.every((frame) => frame.payloadLength < payload.length))
    }))

  it.effect("supports WebSocket clients without per-message deflate", () =>
    Effect.gen(function*() {
      const payload = "a".repeat(4_096)
      const server = yield* makeWebSocketServer(payload)
      const port = (server.address as HttpServer.TcpAddress).port
      const { frames, headers } = yield* readWebSocketFrames(port, false)

      assert.notMatch(headers, /^sec-websocket-extensions:.*permessage-deflate/im)
      assert.deepStrictEqual(frames.map((frame) => frame.opcode), [1, 2])
      assert.isFalse(frames.some((frame) => frame.rsv1))
      assert.isTrue(frames.every((frame) => frame.payloadLength === payload.length))
      assert.deepStrictEqual(frames.map((frame) => new TextDecoder().decode(frame.payload)), [payload, payload])
    }))
})
