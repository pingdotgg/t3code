import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { AgUiSchema } from "effect/ai"

const decodeInput = Schema.decodeUnknownExit(AgUiSchema.RunAgentInput)

const input = (messages: ReadonlyArray<unknown>) => ({ threadId: "thread-1", runId: "run-1", messages })

describe("AgUiSchema", () => {
  describe("RunAgentInput", () => {
    // AG-UI requires consumers to strip union members from newer protocol
    // versions instead of rejecting the whole input
    it("drops unrecognised union members", () => {
      const exit = decodeInput(input([
        { id: "1", role: "narrator", content: "Once upon a time" },
        {
          id: "2",
          role: "user",
          content: [
            { type: "text", text: "Hi" },
            { type: "hologram", uri: "holo://1" },
            { type: "image", source: { type: "ipfs", value: "Qm123" } }
          ]
        }
      ]))

      assert.strictEqual(exit._tag, "Success")
      assert.deepStrictEqual(
        exit._tag === "Success" ? exit.value.messages : undefined,
        [{ id: "2", role: "user", content: [{ type: "text", text: "Hi" }] }]
      )
    })

    it("drops entries whose closed-set values are unrecognised", () => {
      const exit = decodeInput({
        ...input([{
          id: "1",
          role: "assistant",
          toolCalls: [
            { id: "call-1", type: "function", function: { name: "GetWeather", arguments: "{}" } },
            { id: "call-2", type: "remote", function: { name: "GetTime", arguments: "{}" } }
          ]
        }]),
        resume: [
          { interruptId: "interrupt-1", status: "expired" },
          { interruptId: "interrupt-2", status: "resolved" }
        ]
      })

      assert.strictEqual(exit._tag, "Success")
      if (exit._tag !== "Success") return
      assert.deepStrictEqual(exit.value.messages, [{
        id: "1",
        role: "assistant",
        toolCalls: [{ id: "call-1", type: "function", function: { name: "GetWeather", arguments: "{}" } }]
      }])
      assert.deepStrictEqual(exit.value.resume, [{ interruptId: "interrupt-2", status: "resolved" }])

      assert.strictEqual(decodeInput({ ...input([]), resume: [{ status: "resolved" }] })._tag, "Failure")
    })

    it("rejects a malformed recognised union member", () => {
      // A missing or non-string discriminator is malformed, even when a nested
      // value is unrecognised
      const malformedContents = [
        [{ type: "text" }],
        [{ source: { type: "future" } }],
        [{ type: 123, source: { type: "future" } }]
      ]
      for (const content of malformedContents) {
        const exit = decodeInput(input([{ id: "1", role: "user", content }]))

        assert.strictEqual(exit._tag, "Failure", JSON.stringify(content))
      }
    })
  })
})
