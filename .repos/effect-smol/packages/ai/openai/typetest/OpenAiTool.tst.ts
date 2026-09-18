import { type Generated, OpenAiTool } from "@effect/ai-openai"
import type { Tool } from "effect/unstable/ai"
import { describe, expect, it } from "tstyche"

describe("OpenAiTool", () => {
  it("distinguishes completed file searches from failed and unfinished searches", () => {
    const fileSearch = OpenAiTool.FileSearch({ vector_store_ids: ["vs_123"] })

    type Failure = {
      readonly status: "in_progress" | "searching" | "incomplete" | "failed"
      readonly queries: Generated.FileSearchToolCall["queries"]
      readonly results: Exclude<Generated.FileSearchToolCall["results"], undefined>
    }

    expect<Tool.Failure<typeof fileSearch>>().type.toBe<Failure>()
    expect<Tool.Success<typeof fileSearch>>().type.toBe<Omit<Failure, "status"> & { readonly status: "completed" }>()
  })

  it("distinguishes completed web searches from failed and unfinished searches", () => {
    const webSearch = OpenAiTool.WebSearch({})

    type Failure = {
      readonly action: Generated.WebSearchToolCall["action"]
      readonly status: "in_progress" | "searching" | "failed"
    }

    expect<Tool.Failure<typeof webSearch>>().type.toBe<Failure>()
    expect<Tool.Success<typeof webSearch>["status"]>().type.toBe<"completed">()
  })
})
