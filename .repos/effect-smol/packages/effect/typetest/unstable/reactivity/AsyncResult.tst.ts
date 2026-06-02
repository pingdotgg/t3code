import { AsyncResult } from "effect/unstable/reactivity"
import { describe, expect, it } from "tstyche"

interface TestError {
  readonly _tag: "TestError"
}

declare const result: AsyncResult.AsyncResult<number, TestError>

describe("AsyncResult", () => {
  describe("builder", () => {
    it("exhaustive is only available when all cases are handled", () => {
      const complete = AsyncResult.builder(result)
        .onInitialOrWaiting(() => "loading" as const)
        .onErrorTag("TestError", (error) => {
          expect(error).type.toBe<TestError>()
          return "error" as const
        })
        .onFailure(() => "failure" as const)
        .onSuccess((value) => value)

      expect(complete.exhaustive()).type.toBe<number | "loading" | "error" | "failure">()

      const completeWithFailure = AsyncResult.builder(result)
        .onInitialOrWaiting(() => "loading" as const)
        .onFailure(() => "failure" as const)
        .onSuccess((value) => value)

      expect(completeWithFailure.exhaustive()).type.toBe<number | "loading" | "failure">()

      const missingFailure = AsyncResult.builder(result)
        .onInitialOrWaiting(() => "loading" as const)
        .onErrorTag("TestError", () => "error" as const)
        .onSuccess((value) => value)

      expect(missingFailure).type.not.toHaveProperty("exhaustive")

      const missingFailureCause = AsyncResult.builder(result)
        .onInitialOrWaiting(() => "loading" as const)
        .onErrorTag("TestError", () => "error" as const)
        .onDefect(() => "defect" as const)
        .onSuccess((value) => value)

      expect(missingFailureCause).type.not.toHaveProperty("exhaustive")

      const missingError = AsyncResult.builder(result)
        .onInitialOrWaiting(() => "loading" as const)
        .onSuccess((value) => value)

      expect(missingError).type.not.toHaveProperty("exhaustive")

      const missingInitial = AsyncResult.builder(result)
        .onErrorTag("TestError", () => "error" as const)
        .onSuccess((value) => value)

      expect(missingInitial).type.not.toHaveProperty("exhaustive")

      const missingSuccess = AsyncResult.builder(result)
        .onInitialOrWaiting(() => "loading" as const)
        .onErrorTag("TestError", () => "error" as const)

      expect(missingSuccess).type.not.toHaveProperty("exhaustive")
    })
  })
})
