import { assert, describe, it } from "@effect/vitest"
import { Prompt, Response } from "effect/unstable/ai"

describe("Prompt", () => {
  describe("fromResponseParts", () => {
    it("folds streamed text and reasoning deltas into an assistant message", () => {
      const parts = [
        Response.makePart("text-start", { id: "1" }),
        Response.makePart("text-delta", { id: "1", delta: "Hello" }),
        Response.makePart("text-delta", { id: "1", delta: ", " }),
        Response.makePart("text-delta", { id: "1", delta: "World!" }),
        Response.makePart("text-end", { id: "1" }),
        Response.makePart("reasoning-start", { id: "2" }),
        Response.makePart("reasoning-delta", { id: "2", delta: "I " }),
        Response.makePart("reasoning-delta", { id: "2", delta: "am " }),
        Response.makePart("reasoning-delta", { id: "2", delta: "thinking" }),
        Response.makePart("reasoning-end", { id: "2" })
      ]
      const prompt = Prompt.fromResponseParts(parts)
      const expected = Prompt.make([
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hello, World!" },
            { type: "reasoning", text: "I am thinking" }
          ]
        }
      ])
      assert.deepStrictEqual(prompt, expected)
    })

    it("places tool calls in assistant messages and tool results in tool messages", () => {
      const parts = [
        Response.makePart("tool-call", {
          id: "call-1",
          name: "get_weather",
          params: { city: "London" },
          providerExecuted: false
        }),
        Response.makePart("tool-result", {
          id: "call-1",
          name: "get_weather",
          isFailure: false,
          result: { temp: 20 },
          encodedResult: { temp: 20 },
          preliminary: false,
          providerExecuted: false
        })
      ]
      const prompt = Prompt.fromResponseParts(parts)

      // Should have assistant message with tool-call, then tool message with tool-result
      assert.strictEqual(prompt.content.length, 2)
      assert.strictEqual(prompt.content[0].role, "assistant")
      assert.strictEqual(prompt.content[1].role, "tool")

      // Assistant message contains the tool-call
      const assistantContent = prompt.content[0].content
      assert.strictEqual(assistantContent.length, 1)
      assert.strictEqual(typeof assistantContent[0] === "object" && assistantContent[0].type, "tool-call")

      // Tool message contains the tool-result
      const toolContent = prompt.content[1].content
      assert.strictEqual(toolContent.length, 1)
      assert.strictEqual(typeof toolContent[0] === "object" && toolContent[0].type, "tool-result")
    })

    it("should handle out-of-order tool results (result before call in stream)", () => {
      // This simulates concurrent tool execution where results may arrive
      // in different order than their corresponding calls
      const parts = [
        // Tool call A arrives first
        Response.makePart("tool-call", {
          id: "call-A",
          name: "tool_a",
          params: {},
          providerExecuted: false
        }),
        // Tool call B arrives second
        Response.makePart("tool-call", {
          id: "call-B",
          name: "tool_b",
          params: {},
          providerExecuted: false
        }),
        // But tool B's result arrives before tool A's result
        Response.makePart("tool-result", {
          id: "call-B",
          name: "tool_b",
          isFailure: false,
          result: "result-B",
          encodedResult: "result-B",
          preliminary: false,
          providerExecuted: false
        }),
        Response.makePart("tool-result", {
          id: "call-A",
          name: "tool_a",
          isFailure: false,
          result: "result-A",
          encodedResult: "result-A",
          preliminary: false,
          providerExecuted: false
        })
      ]
      const prompt = Prompt.fromResponseParts(parts)

      // Should still produce valid message structure
      assert.strictEqual(prompt.content.length, 2)
      assert.strictEqual(prompt.content[0].role, "assistant")
      assert.strictEqual(prompt.content[1].role, "tool")

      // Assistant message has tool calls in order they arrived
      const assistantContent = prompt.content[0].content
      assert.strictEqual(assistantContent.length, 2)
      assert.strictEqual(typeof assistantContent[0] === "object" && assistantContent[0].type, "tool-call")
      assert.deepStrictEqual((assistantContent[0] as any).id, "call-A")
      assert.strictEqual(typeof assistantContent[1] === "object" && assistantContent[1].type, "tool-call")
      assert.deepStrictEqual((assistantContent[1] as any).id, "call-B")

      // Tool message has results in order they arrived (B before A)
      const toolContent = prompt.content[1].content
      assert.strictEqual(toolContent.length, 2)
      assert.strictEqual(typeof toolContent[0] === "object" && toolContent[0].type, "tool-result")
      assert.deepStrictEqual((toolContent[0] as any).id, "call-B")
      assert.strictEqual(typeof toolContent[1] === "object" && toolContent[1].type, "tool-result")
      assert.deepStrictEqual((toolContent[1] as any).id, "call-A")
    })

    it("keeps only the final non-preliminary tool result", () => {
      const parts = [
        Response.makePart("tool-call", {
          id: "call-1",
          name: "long_task",
          params: {},
          providerExecuted: false
        }),
        // Preliminary result (progress update)
        Response.makePart("tool-result", {
          id: "call-1",
          name: "long_task",
          isFailure: false,
          result: { progress: 50 },
          encodedResult: { progress: 50 },
          preliminary: true,
          providerExecuted: false
        }),
        // Another preliminary result
        Response.makePart("tool-result", {
          id: "call-1",
          name: "long_task",
          isFailure: false,
          result: { progress: 100 },
          encodedResult: { progress: 100 },
          preliminary: true,
          providerExecuted: false
        }),
        // Final result
        Response.makePart("tool-result", {
          id: "call-1",
          name: "long_task",
          isFailure: false,
          result: { done: true },
          encodedResult: { done: true },
          preliminary: false,
          providerExecuted: false
        })
      ]
      const prompt = Prompt.fromResponseParts(parts)

      // Should have assistant and tool messages
      assert.strictEqual(prompt.content.length, 2)

      // Tool message should only contain the final result, not preliminary ones
      const toolContent = prompt.content[1].content
      assert.strictEqual(toolContent.length, 1)
      assert.deepStrictEqual((toolContent[0] as any).result, { done: true })
    })
  })

  describe("merge", () => {
    it("should sequentially combine the content of two Prompts", () => {
      const leftMessages = [
        Prompt.makeMessage("user", {
          content: [Prompt.makePart("text", { text: "a" })]
        }),
        Prompt.makeMessage("assistant", {
          content: [Prompt.makePart("text", { text: "b" })]
        })
      ]
      const rightMessages = [
        Prompt.makeMessage("user", {
          content: [Prompt.makePart("text", { text: "c" })]
        }),
        Prompt.makeMessage("assistant", {
          content: [Prompt.makePart("text", { text: "d" })]
        })
      ]
      const left = Prompt.fromMessages(leftMessages)
      const right = Prompt.fromMessages(rightMessages)
      const merged = Prompt.concat(left, right)
      assert.deepStrictEqual(
        merged,
        Prompt.fromMessages([
          ...leftMessages,
          ...rightMessages
        ])
      )
    })

    it("returns Prompt.empty when both inputs have no messages", () => {
      const merged = Prompt.concat(Prompt.empty, [])
      assert.deepStrictEqual(merged, Prompt.empty)
    })

    it("accepts raw message input when the left prompt is empty", () => {
      const prompt = Prompt.empty
      const merged = Prompt.concat(prompt, [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" }
      ])
      assert.deepStrictEqual(
        merged,
        Prompt.make([
          Prompt.makeMessage("user", {
            content: [Prompt.makePart("text", { text: "a" })]
          }),
          Prompt.makeMessage("assistant", {
            content: [Prompt.makePart("text", { text: "b" })]
          })
        ])
      )
    })

    it("returns the original prompt when the input has no messages", () => {
      const messages = [
        Prompt.makeMessage("user", {
          content: [Prompt.makePart("text", { text: "a" })]
        }),
        Prompt.makeMessage("assistant", {
          content: [Prompt.makePart("text", { text: "b" })]
        })
      ]
      const prompt = Prompt.fromMessages(messages)
      const merged = Prompt.concat(prompt, [])
      assert.deepStrictEqual(merged, prompt)
    })
  })

  describe("appendSystem", () => {
    it("appends text to the leading system message", () => {
      const prompt = Prompt.make([
        { role: "system", content: "You are an expert in programming." },
        { role: "user", content: "Hello, world!" }
      ])

      const result = Prompt.appendSystem(prompt, " You are a helpful assistant.")

      assert.deepStrictEqual(
        result.content[0],
        Prompt.makeMessage("system", {
          content: "You are an expert in programming. You are a helpful assistant."
        })
      )
    })

    it("creates a leading system message if none exists", () => {
      const prompt = Prompt.make([
        { role: "user", content: "Hello, world!" }
      ])

      const result = Prompt.appendSystem(prompt, "You are a helpful assistant.")

      assert.deepStrictEqual(
        result.content[0],
        Prompt.makeMessage("system", {
          content: "You are a helpful assistant."
        })
      )
    })

    it("creates a system message for an empty prompt", () => {
      const prompt = Prompt.empty

      const result = Prompt.appendSystem(prompt, "You are a helpful assistant.")

      assert.deepStrictEqual(
        result.content[0],
        Prompt.makeMessage("system", { content: "You are a helpful assistant." })
      )
    })
  })

  describe("prependSystem", () => {
    it("prepends text to the leading system message", () => {
      const prompt = Prompt.make([
        {
          role: "system",
          content: "You are an expert in programming."
        },
        {
          role: "user",
          content: "Hello, world!"
        }
      ])

      const result = Prompt.prependSystem(prompt, "You are a helpful assistant. ")

      assert.deepStrictEqual(
        result.content[0],
        Prompt.makeMessage("system", {
          content: "You are a helpful assistant. You are an expert in programming."
        })
      )
    })

    it("creates a leading system message if none exists", () => {
      const prompt = Prompt.make([
        {
          role: "user",
          content: "Hello, world!"
        }
      ])

      const result = Prompt.prependSystem(prompt, "You are a helpful assistant.")

      assert.deepStrictEqual(
        result.content[0],
        Prompt.makeMessage("system", {
          content: "You are a helpful assistant."
        })
      )
    })

    it("creates a system message for an empty prompt", () => {
      const prompt = Prompt.empty

      const result = Prompt.prependSystem(prompt, "You are a helpful assistant.")

      assert.deepStrictEqual(
        result.content[0],
        Prompt.makeMessage("system", { content: "You are a helpful assistant." })
      )
    })
  })
})
