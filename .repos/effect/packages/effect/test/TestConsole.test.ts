import { assert, describe, it } from "@effect/vitest"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as TestConsole from "effect/testing/TestConsole"

describe("TestConsole", () => {
  for (
    const [method, write, read] of [
      ["warn", Console.warn, TestConsole.warnLines],
      ["info", Console.info, TestConsole.infoLines],
      ["debug", Console.debug, TestConsole.debugLines],
      ["trace", Console.trace, TestConsole.traceLines]
    ] as const
  ) {
    it.effect(`${method}Lines captures parameters from only ${method} calls`, () =>
      Effect.gen(function*() {
        const details = { value: 1 }
        yield* Console.log("log", details)
        yield* Console.error("error", details)
        yield* Console.warn("warn", details)
        yield* Console.info("info", details)
        yield* Console.debug("debug", details)
        yield* Console.trace("trace", details)
        yield* write("second", 42)

        const lines = yield* read
        assert.deepStrictEqual(lines, [method, details, "second", 42])
      }))
  }
})
