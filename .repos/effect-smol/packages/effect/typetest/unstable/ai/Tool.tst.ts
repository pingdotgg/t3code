import type { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { describe, expect, it } from "tstyche"

describe("Tool", () => {
  describe("make", () => {
    it("omitting parameters defaults to EmptyParams", () => {
      const tool = Tool.make("A")

      expect(tool).type.toBe<
        Tool.Tool<"A", {
          readonly parameters: Tool.EmptyParams
          readonly success: typeof Schema.Void
          readonly failure: typeof Schema.Never
          readonly failureMode: "error"
        }>
      >()
    })

    it("explicit EmptyParams matches omitted parameters", () => {
      const tool = Tool.make("A", { parameters: Tool.EmptyParams })

      expect(tool).type.toBe<
        Tool.Tool<"A", {
          readonly parameters: Tool.EmptyParams
          readonly success: typeof Schema.Void
          readonly failure: typeof Schema.Never
          readonly failureMode: "error"
        }>
      >()
    })
  })
})
