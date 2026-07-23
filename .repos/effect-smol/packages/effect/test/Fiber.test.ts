import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"

describe("Effect", () => {
  it("Fiber is a fiber", async () => {
    const result = Effect.runFork(Effect.succeed(1))
    assert.isTrue(Fiber.isFiber(result))
  })
})
