import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import * as McpSchema from "effect/unstable/ai/McpSchema"

describe("McpSchema", () => {
  const decodeCreateMessage = Schema.decodeUnknownSync(McpSchema.CreateMessage.payloadSchema)

  it("allows create-message metadata to be omitted", () => {
    assert.doesNotThrow(() => decodeCreateMessage({ messages: [], maxTokens: 1 }))
  })

  it("requires create-message metadata to be an object", () => {
    assert.throws(() => decodeCreateMessage({ messages: [], maxTokens: 1, metadata: "invalid" }))
  })
})
