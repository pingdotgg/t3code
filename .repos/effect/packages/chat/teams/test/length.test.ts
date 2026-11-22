import * as Length from "@effect/chat-teams/internal/length"
import * as Render from "@effect/chat-teams/internal/render"
import { assert, describe, it } from "@effect/vitest"
import type * as ChatUi from "effect/chat/ChatUi"

describe("render", () => {
  it("measure bounds each serialised form", () => {
    const tokenLength = (button: { readonly id: string; readonly value?: string | undefined }) =>
      20 + button.id.length + (button.value?.length ?? 0)
    const measure = Length.makeMeasure(tokenLength)
    const actions: ReadonlyArray<ChatUi.Action> = [
      { _tag: "Button", id: "approve", label: "Yes & <no>", style: "danger", value: "v" },
      { _tag: "LinkButton", label: "Docs", url: "https://example.com/?a=1&b=<2>" }
    ]
    const cards: ReadonlyArray<
      readonly [string, ReadonlyArray<ChatUi.Action>, ((button: ChatUi.Button) => boolean)?]
    > = [
      ["```\nx\n```\np\n\nq\n\nr", actions],
      ["> - # x", actions],
      ["| a | b |\n| - | - |\n| c | d |", actions],
      // A dialog button's label with lone surrogates.
      ["x", [{ _tag: "Button", id: "open", label: "\uD800".repeat(20_000) }], () => true]
    ]
    for (const [markdown, actions, opensDialog] of cards) {
      const card = Render.cardActivity(markdown, actions, (button) => "t".repeat(tokenLength(button)), opensDialog)
      assert.isAtMost(JSON.stringify(card).length, measure(markdown, actions) + Length.R, markdown)
    }
    const dollars = "$".repeat(10_000) + "\\$"
    assert.isAtMost(JSON.stringify(Render.textActivity(dollars)).length, measure(dollars) + Length.R)
  })

  it("removes only the opening fence indentation from code", () => {
    const [block] = Render.blocks("  ```\n    x\n  ```")
    assert.propertyVal(block, "codeSnippet", "  x")
  })

  it("escapes each dollar outside code, so Teams reads no math", () => {
    const markdown = "$x$ \\$y \\\\$z `$c$`\n```\n$$\n```\n$"
    const sent = "\\$x\\$ \\$y \\\\\\$z `$c$`\n```\n$$\n```\n\\$"
    assert.strictEqual(Render.textActivity(markdown).text, sent)
  })
})
