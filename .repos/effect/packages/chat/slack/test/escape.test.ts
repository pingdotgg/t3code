import { escape } from "@effect/chat-slack/internal/escape"
import { assert, describe, it } from "@effect/vitest"

const sent = (text: string, notify = {}) => escape(text, notify, { flush: true }).sent

describe("escape", () => {
  it("escapes < outside code only", () => {
    assert.strictEqual(sent("a <@U1> b"), "a &lt;@U1> b")
    assert.strictEqual(sent("`<@U1>` and ``x <!here> y``"), "`<@U1>` and ``x <!here> y``")
    assert.strictEqual(sent("```\n<@U1>\n```\n<@U1>"), "```\n<@U1>\n```\n&lt;@U1>")
    assert.strictEqual(sent("~~~ts\nif (a < b) {}\n~~~"), "~~~ts\nif (a < b) {}\n~~~")
    assert.strictEqual(sent("a `b < c"), "a `b &lt; c")
    assert.strictEqual(sent("\\<@U1>"), "\\&lt;@U1>")
  })

  it("keeps the tokens the notify options allow", () => {
    const notify = { users: ["U1"], groups: ["S1"], broadcast: true }
    assert.strictEqual(
      sent("<@U1> <@U2> <!subteam^S1> <!subteam^S2> <!here>", notify),
      "<@U1> &lt;@U2> <!subteam^S1> &lt;!subteam^S2> <!here>"
    )
    assert.strictEqual(sent("<@U1|name>", { users: ["U1"] }), "<@U1|name>")
    assert.strictEqual(sent("<!channel>", {}), "&lt;!channel>")
  })
})
