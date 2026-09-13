import * as DenoSocket from "@effect/platform-deno/DenoSocket"
import * as DenoSocketServer from "@effect/platform-deno/DenoSocketServer"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Option, References, Scope } from "effect"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import type * as Socket from "effect/unstable/socket/Socket"
import { fromListener } from "../src/internal/denoSocketServer.ts"

const makeTempDir = Effect.acquireRelease(
  Effect.promise(() => Deno.makeTempDir()),
  (path) => Effect.promise(() => Deno.remove(path, { recursive: true }))
)

const echo = (socket: Socket.Socket) =>
  Effect.scoped(
    Effect.gen(function*() {
      const write = yield* socket.writer
      yield* socket.run(write)
    })
  )

const makeTestConn = (onClose?: () => void): Deno.Conn => {
  const transform = new TransformStream<Uint8Array>()
  return {
    readable: transform.readable,
    writable: transform.writable,
    read: () => Promise.resolve(null),
    write: (data) => Promise.resolve(data.length),
    close() {
      onClose?.()
    },
    closeWrite: () => Promise.resolve(),
    ref() {},
    unref() {},
    localAddr: { transport: "tcp", hostname: "127.0.0.1", port: 1 },
    remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 2 },
    [Symbol.dispose]() {}
  }
}

const makeTestListener = (
  accepts: ReadonlyArray<() => Promise<Deno.Conn>>,
  called: ReadonlyArray<Deferred.Deferred<void>>
): Deno.Listener<Deno.Conn, Deno.NetAddr | Deno.UnixAddr> => {
  let index = 0
  return {
    addr: { transport: "tcp", hostname: "127.0.0.1", port: 1 },
    accept() {
      Deferred.doneUnsafe(called[index], Exit.void)
      return accepts[index++]!()
    },
    close() {},
    ref() {},
    unref() {},
    [Symbol.dispose]() {}
  } as unknown as Deno.Listener<Deno.Conn, Deno.NetAddr | Deno.UnixAddr>
}

const neverAccept = () => new Promise<Deno.Conn>(() => {})
const settlePromises = Effect.promise(() => Promise.resolve())

describe("DenoSocketServer", () => {
  it.effect("echoes over TCP and reports its address", () =>
    Effect.gen(function*() {
      const server = yield* DenoSocketServer.make({ hostname: "127.0.0.1", port: 0 })
      const address = server.address
      assert.strictEqual(address._tag, "TcpAddress")
      if (address._tag !== "TcpAddress") return
      assert.strictEqual(address.hostname, "127.0.0.1")
      assert.notStrictEqual(address.port, 0)
      yield* server.run(echo).pipe(Effect.forkScoped)

      const output = yield* Stream.make("Hello", "Deno").pipe(
        Stream.encodeText,
        Stream.pipeThroughChannel(DenoSocket.makeTcpChannel({
          hostname: address.hostname,
          port: address.port
        })),
        Stream.decodeText(),
        Stream.mkString
      )

      assert.strictEqual(output, "HelloDeno")
    }))

  it.effect("echoes over Unix sockets and reports its address", () =>
    Effect.gen(function*() {
      const directory = yield* makeTempDir
      const path = `${directory}/echo.sock`
      const server = yield* DenoSocketServer.make({ transport: "unix", path })
      assert.deepStrictEqual(server.address, { _tag: "UnixAddress", path })
      yield* server.run(echo).pipe(Effect.forkScoped)

      const output = yield* Stream.make("Hello", "Unix").pipe(
        Stream.encodeText,
        Stream.pipeThroughChannel(DenoSocket.makeTcpChannel({ transport: "unix", path })),
        Stream.decodeText(),
        Stream.mkString
      )

      assert.strictEqual(output, "HelloUnix")
    }))

  it.effect("interrupts handler fibers when run is interrupted", () =>
    Effect.gen(function*() {
      const server = yield* DenoSocketServer.make({ hostname: "127.0.0.1", port: 0 })
      const address = server.address
      assert.strictEqual(address._tag, "TcpAddress")
      if (address._tag !== "TcpAddress") return
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const runFiber = yield* server.run(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
        )
      ).pipe(Effect.forkChild)
      const conn = yield* Effect.acquireRelease(
        Effect.promise(() => Deno.connect({ hostname: address.hostname, port: address.port })),
        (conn) => Effect.sync(() => conn.close())
      )
      void conn
      yield* Deferred.await(started)

      yield* Fiber.interrupt(runFiber)

      assert.isTrue(yield* Deferred.isDone(interrupted))
    }))

  it.effect("does not surface BadResource when the listener is closed", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const server = yield* DenoSocketServer.make({ hostname: "127.0.0.1", port: 0 }).pipe(Scope.provide(scope))
      const runFiber = yield* server.run(() => Effect.void).pipe(Effect.forkChild)

      yield* Scope.close(scope, Exit.void)
      yield* Effect.yieldNow

      assert.isUndefined(runFiber.pollUnsafe())
      yield* Fiber.interrupt(runFiber)
    }))

  it.effect("closes with a pending pre-run connection", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const server = yield* DenoSocketServer.make({ hostname: "127.0.0.1", port: 0 }).pipe(Scope.provide(scope))
      const address = server.address
      assert.strictEqual(address._tag, "TcpAddress")
      if (address._tag !== "TcpAddress") return
      const conn = yield* Effect.acquireRelease(
        Effect.promise(() => Deno.connect({ hostname: address.hostname, port: address.port })),
        (conn) => Effect.sync(() => conn.close())
      )
      void conn

      yield* Scope.close(scope, Exit.void).pipe(Effect.timeout("1 second"))
    }))

  it.effect("closes the connection after its handler completes", () =>
    Effect.gen(function*() {
      const called = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()]
      const handled = yield* Deferred.make<void>()
      const closed = yield* Deferred.make<void>()
      const listener = makeTestListener([
        () => Promise.resolve(makeTestConn(() => Deferred.doneUnsafe(closed, Exit.void))),
        neverAccept
      ], called)
      const server = fromListener(listener)
      yield* server.run(() => Deferred.succeed(handled, undefined)).pipe(Effect.forkChild)

      yield* Deferred.await(handled)
      yield* Effect.yieldNow

      assert.isTrue(yield* Deferred.isDone(closed))
    }))

  it.effect("logs accept failures and continues accepting", () =>
    Effect.gen(function*() {
      const called = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()]
      const failure = new Error("accept failed")
      const handled = yield* Deferred.make<void>()
      const logs: Array<{ readonly cause: Cause.Cause<unknown>; readonly message: unknown }> = []
      const logger = Logger.make<unknown, void>((options) =>
        logs.push({ cause: options.cause, message: options.message })
      )
      const listener = makeTestListener([
        () => Promise.reject(failure),
        () => Promise.resolve(makeTestConn()),
        neverAccept
      ], called)
      const server = fromListener(listener)
      yield* server.run(() => Deferred.succeed(handled, undefined)).pipe(
        Effect.provide(Logger.layer([logger])),
        Effect.provideService(References.UnhandledLogLevel, "Error"),
        Effect.forkChild
      )

      yield* Deferred.await(called[0])
      yield* settlePromises
      yield* TestClock.adjust(10)
      assert.isTrue(yield* Deferred.isDone(handled))

      assert.strictEqual(logs.length, 1)
      assert.deepStrictEqual(logs[0]!.message, ["Unhandled error in SocketServer"])
      assert.deepStrictEqual(Cause.findErrorOption(logs[0]!.cause), Option.some(failure))
    }))

  it.effect("backs off consecutive accept failures", () =>
    Effect.gen(function*() {
      const called = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()]
      const listener = makeTestListener([
        () => Promise.reject(new Error("first")),
        () => Promise.reject(new Error("second")),
        neverAccept
      ], called)
      const server = fromListener(listener)
      yield* server.run(() => Effect.void).pipe(
        Effect.provideService(References.UnhandledLogLevel, undefined),
        Effect.forkChild
      )

      yield* Deferred.await(called[0])
      yield* settlePromises
      yield* TestClock.adjust(9)
      assert.isFalse(yield* Deferred.isDone(called[1]))
      yield* TestClock.adjust(1)
      assert.isTrue(yield* Deferred.isDone(called[1]))
      yield* settlePromises
      yield* TestClock.adjust(19)
      assert.isFalse(yield* Deferred.isDone(called[2]))
      yield* TestClock.adjust(1)
      assert.isTrue(yield* Deferred.isDone(called[2]))
    }))

  it.effect("resets accept backoff after a successful connection", () =>
    Effect.gen(function*() {
      const called = [
        Deferred.makeUnsafe<void>(),
        Deferred.makeUnsafe<void>(),
        Deferred.makeUnsafe<void>(),
        Deferred.makeUnsafe<void>()
      ]
      const listener = makeTestListener([
        () => Promise.reject(new Error("first")),
        () => Promise.resolve(makeTestConn()),
        () => Promise.reject(new Error("after success")),
        neverAccept
      ], called)
      const server = fromListener(listener)
      yield* server.run(() => Effect.void).pipe(
        Effect.provideService(References.UnhandledLogLevel, undefined),
        Effect.forkChild
      )

      yield* Deferred.await(called[0])
      yield* settlePromises
      yield* TestClock.adjust(10)
      assert.isTrue(yield* Deferred.isDone(called[2]))
      yield* settlePromises
      yield* TestClock.adjust(9)
      assert.isFalse(yield* Deferred.isDone(called[3]))
      yield* TestClock.adjust(1)
      assert.isTrue(yield* Deferred.isDone(called[3]))
    }))
})
