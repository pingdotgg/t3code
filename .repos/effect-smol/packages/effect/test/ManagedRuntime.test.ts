import { assert, describe, it, test } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { Context, Effect, Exit, Layer, ManagedRuntime } from "effect"

describe("ManagedRuntime", () => {
  test("memoizes the layer build", async () => {
    let count = 0
    const layer = Layer.effectDiscard(Effect.sync(() => {
      count++
    }))
    const runtime = ManagedRuntime.make(layer)
    await runtime.runPromise(Effect.void)
    await runtime.runPromise(Effect.void)
    await runtime.dispose()
    strictEqual(count, 1)
  })

  test("provides context", async () => {
    const tag = Context.Service<string>("string")
    const layer = Layer.succeed(tag)("test")
    const runtime = ManagedRuntime.make(layer)
    const result = await runtime.runPromise(tag)
    await runtime.dispose()
    strictEqual(result, "test")
  })

  test("allows sharing a MemoMap", async () => {
    let count = 0
    const layer = Layer.effectDiscard(Effect.sync(() => {
      count++
    }))
    const runtimeA = ManagedRuntime.make(layer)
    const runtimeB = ManagedRuntime.make(layer, { memoMap: runtimeA.memoMap })
    await runtimeA.runPromise(Effect.void)
    await runtimeB.runPromise(Effect.void)
    await runtimeA.dispose()
    await runtimeB.dispose()
    strictEqual(count, 1)
  })

  it("can be built synchronously", () => {
    const tag = Context.Service<string>("string")
    const layer = Layer.succeed(tag)("test")
    const managedRuntime = ManagedRuntime.make(layer)
    const services = Effect.runSync(managedRuntime.contextEffect)
    const result = Context.get(services, tag)
    strictEqual(result, "test")
  })

  it("fibers are interrupted on dispose", async () => {
    const runtime = ManagedRuntime.make(Layer.empty)
    const fiber = runtime.runFork(Effect.never)
    await runtime.dispose()
    const exit = fiber.pollUnsafe()
    assert(exit)
    assert.isTrue(Exit.hasInterrupts(exit))
  })
})
