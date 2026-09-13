import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"
import { Reactivity } from "effect/unstable/reactivity"
import { vi } from "vitest"

const state = vi.hoisted(() => ({ vfsCloseCalls: 0 }))

vi.mock("@effect/wa-sqlite/dist/wa-sqlite.mjs", () => ({ default: async () => ({}) }))
vi.mock("@effect/wa-sqlite/src/examples/AccessHandlePoolVFS.js", () => ({
  AccessHandlePoolVFS: {
    create: async () => ({
      close: async () => {
        state.vfsCloseCalls++
      }
    })
  }
}))
vi.mock("@effect/wa-sqlite", () => ({
  Factory: () => ({
    close() {},
    open_v2: () => 1,
    vfs_register() {}
  })
}))

import { OpfsWorker, SqliteClient } from "@effect/sql-sqlite-wasm"

class FakePort extends EventTarget {
  close() {}

  postMessage(message: ReadonlyArray<unknown>): void {
    if (message[0] === "ready") {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: ["close"] })))
    }
  }
}

class FakeWorker extends EventTarget {
  onerror: unknown = null

  constructor(readonly queryPosted: Deferred.Deferred<void>) {
    super()
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: unknown
  ): void {
    super.addEventListener(type, listener, options as boolean)
    if (type === "message") {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: ["ready"] })))
    }
  }

  postMessage(message: ReadonlyArray<unknown>): void {
    if (typeof message[0] === "number") {
      Effect.runFork(Deferred.succeed(this.queryPosted, undefined))
    }
  }
}

describe("Client", () => {
  it.effect("should work", () => Effect.void)

  it.effect("closes the OPFS VFS when the worker loop closes", () =>
    Effect.gen(function*() {
      yield* OpfsWorker.run({ port: new FakePort(), dbName: "test.db" })
      assert.strictEqual(state.vfsCloseCalls, 1)
    }))

  it.effect("settles an in-flight query when the worker errors and reconnects", () =>
    Effect.gen(function*() {
      const queryPosted = yield* Deferred.make<void>()
      const worker = new FakeWorker(queryPosted)
      const sql = yield* SqliteClient.make({ worker: Effect.succeed(worker as unknown as Worker) })
      const fiber = yield* Effect.forkChild(sql`SELECT 1`)

      yield* Deferred.await(queryPosted)
      worker.dispatchEvent(new Event("error"))

      const joinFiber = yield* Fiber.join(fiber).pipe(Effect.exit, Effect.timeoutOption("100 millis"), Effect.forkChild)
      yield* TestClock.adjust("100 millis")
      const result = yield* Fiber.join(joinFiber)
      assert(Option.isSome(result), "the request remained pending after worker replacement")
      assert(Exit.isFailure(result.value))
    }).pipe(Effect.provide(Reactivity.layer)))
})
