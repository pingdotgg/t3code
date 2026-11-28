import { assert, describe, it } from "@effect/vitest"
import * as ChatEvent from "effect/chat/ChatEvent"

const thread = { platform: "slack", id: "T1/C1/1794454017.568519" }

describe("ChatEvent", () => {
  describe("StopRequested", () => {
    const event: ChatEvent.StopRequested = {
      _tag: "StopRequested",
      thread,
      id: "1794454026.522466",
      userId: "U1",
      messageIds: ["1794454017.726189"],
      raw: { event: { type: "agent_session_stopped" } }
    }

    it("dedupeKey is stop/{thread}/{id}", () => {
      assert.strictEqual(ChatEvent.dedupeKey(event), "stop/slack:T1/C1/1794454017.568519/1794454026.522466")
      // A redelivery has the same key, whatever streams it lists.
      assert.strictEqual(ChatEvent.dedupeKey({ ...event, messageIds: [] }), ChatEvent.dedupeKey(event))
    })
  })
})
