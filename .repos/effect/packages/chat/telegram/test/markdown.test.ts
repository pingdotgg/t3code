/**
 * The rendered Markdown stays within what `measure` charged and Telegram's
 * limits, and carries no raw HTML, image, math, spoiler or link outside
 * http, https and mailto. A GFM parser reads the output; live check 2
 * confirms Telegram's parser agrees with it.
 */
import {
  maxColumns,
  maxDepth,
  maxFootnoteReferences,
  maxInlineNodes,
  measure,
  messageLength,
  render,
  reservation
} from "@effect/chat-telegram/internal/markdown"
import { assert, describe, it } from "@effect/vitest"
import * as fc from "fast-check"
import { inspect } from "./gfm.ts"

/** The users whose `tg://user` links stay links. */
const mentions = new Set(["2"])

/** Fails with what a GFM parse of `render(input)` finds that the renderer promises it never holds. */
const assertInert = (input: string) => {
  const out = render(input, { mentions })
  const found = inspect(out)
  const context = JSON.stringify(input) + " rendered " + JSON.stringify(out)
  assert.deepStrictEqual(found.html, [], context)
  assert.strictEqual(found.images, 0, context)
  assert.deepStrictEqual(
    found.links.filter((url) => !/^(?:https?:\/\/|mailto:)/i.test(url) && url !== "tg://user?id=2"),
    [],
    context
  )
  assert.deepStrictEqual(found.active, [], context)
  assert.deepStrictEqual(found.unhonored, [], context)
  assert.isAtMost(found.maxDepth, maxDepth, context)
  assert.isAtMost(found.maxColumns, maxColumns, context)
  assert.isAtMost(found.inline, maxInlineNodes, context)
  // The most blocks Telegram renders in one message.
  if (measure(input) <= messageLength) assert.isAtMost(found.blocks, 500, context)
}

describe("render", () => {
  it("escapes the hostile corpus", () => {
    // Live check 2 found that Telegram ignores the escapes `\]` and `\<`, reads
    // destinations verbatim, reads definitions more loosely than CommonMark
    // and opens emphasis between spaces.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["<b>hi</b> <https://e.com> <javascript:alert(1)>", "&lt;b>hi&lt;/b> <https://e.com> &lt;javascript:alert(1)>"],
      ["![a](https://e.com/a.png) ![b][r]", "\\![a](https://e.com/a.png) \\![b][r]"],
      ["[me](tg://user?id=1) [ok](tg://user?id=2)", "[me]\\(tg://user?id\\=1) [ok](tg://user?id=2)"],
      ["| a | b |\n|---|---|\n| 1 | 2 |", "| a | b |\n|---|---|\n| 1 | 2 |"],
      [">>>>>>>>>>>>>>>>> x", ">>>>>>>>>>>>>>>\\>\\> x"],
      [
        "[x\\](tg://resolve?domain=telegram) \\<b>x\\</b>",
        "\\[x&#93;(tg://resolve?domain\\=telegram) &#60;b>x&#60;/b>"
      ],
      [
        "[a](https://e.com/?q=1&x=2 \"t\") [b](https://e.com/a_b*c\\(d\\))",
        "[a](https://e.com/?q=1&x=2) [b](https://e.com/a_b*c%28d%29)"
      ],
      [
        "[a][b]: tg://x\n\n [c]: tg://x\n\ntext\n[d]: https://e.com",
        "\\[a][b]: tg://x\n\n \\[c]: tg://x\n\ntext\n\\[d]: https://e.com"
      ],
      ["2 * 3 * 4 a _ b\n\n***", "2 \\* 3 \\* 4 a \\_ b\n\n***"],
      // a definition is refused once, keeps no title, and loses no text
      [
        "[a[b]: https://e.com\n\n[^ a]: https://e.com\n\n[c]: https://e.com \"t\"\n[d]: https://e.com d",
        "\\[a[b]: https://e.com\n\n\\[^ a]: https://e.com\n\n[c]: https://e.com\n\\[d]: https://e.com d"
      ],
      // a label that renders to 999 characters stays a definition, one of 1,000 does not
      ["[" + "$".repeat(499) + "]: mailto:x", "[" + "\\$".repeat(499) + "]: mailto:x"],
      ["[" + "$".repeat(500) + "]: mailto:x", "\\[" + "\\$".repeat(500) + "]: mailto:x"],
      // a destination keeps parentheses three deep, not four
      ["[a](https://e.com/(((x))))", "[a](https://e.com/(((x))))"],
      ["[a](https://e.com/((((x)))))", "[a]\\(https://e.com/((((x)))))"]
    ]
    for (const [input, expected] of cases) assert.strictEqual(render(input, { mentions }), expected)
  })

  it("leaves a GFM parser no HTML, image, foreign link, math, spoiler or excess nesting", () => {
    for (
      const input of [
        // a fence may be indented up to three spaces
        " ~~~\nx\n~~~\n[ping](tg://user?id=123) <b>",
        // a heading ends a table
        "| a | b |\n|---|---|\n# heading\n||secret||",
        // a lazy continuation line stays in the containers it does not repeat
        ">".repeat(15) + " x\n" + "_".repeat(14) + "x" + "_".repeat(14),
        "2. <\n x_\n=",
        // a footnote's text is no table
        "[^a]: x|y\n---|---\n||secret||",
        // nor a lone pipe a header
        "|\n-|",
        // a table goes on past a line it does not end at
        "|a|\n|---|\n[a]: mailto:x\nb `<b>|`",
        // a line of U+00A0 is text, so it ends no paragraph
        ">".repeat(15) + " x\n\u00a0\n" + "_".repeat(14) + "x" + "_".repeat(14),
        // a reference may turn the outer link into text, and its destination into Markdown
        "[a][inner](mailto:[pwn](tg://user?id=1))\n\n[inner]: https://safe.com",
        // unbalanced parentheses end no destination
        "[](mailto:$(> )",
        // a code span or an autolink hides no label's end from CommonMark
        "[>\\]: mailto:]:[^a]",
        // indented, a footnote's label is a definition's
        "[a]: mailto:x\n    [^a]: tg://x",
        // nor is an autolink with a control character one
        "<https://e.com|\u0001|>"
      ]
    ) assertInert(input)
    const hostile = fc.string({
      unit: fc.constantFrom(
        ..."<>$=|![]()*_~`#-+.:/\\&;\n \t\"'0a",
        "~~~",
        "```",
        " ~~~",
        "- ",
        "> ",
        "1. ",
        "https://e.com",
        "www.e.co",
        "x@e.co",
        "tg://user?id=1",
        "<b>",
        "](",
        "[^",
        "[^a]: ",
        "|---|",
        "\\]",
        "\\<",
        "\\`",
        "[a]",
        "\n[a]: mailto:x\n",
        // whitespace that is not a blank line to CommonMark
        "\u00a0",
        "\u3000",
        "\v",
        "\f"
      ),
      maxLength: 60
    })
    fc.assert(fc.property(hostile, assertInert), { numRuns: 500 })
  })

  it("keeps output that fills the budget under 500 blocks", () => {
    for (const line of ["- - - a\n", "1. a\n"]) {
      let input = ""
      while (measure(input + line) <= messageLength) input += line
      assertInert(input)
    }
  })

  it("caps the code spans, references and footnote references Telegram refuses past a limit", () => {
    const spans = render("`a` ".repeat(maxInlineNodes + 10))
    assert.strictEqual(spans.match(/(?<!\\)`a(?<!\\)`/g)?.length, maxInlineNodes)
    const shortcuts = "[a] ".repeat(maxInlineNodes + 10) + "\n\n[a]: https://e.com"
    assert.isAtMost(measure(shortcuts), messageLength)
    assert.strictEqual(inspect(render(shortcuts)).inline, maxInlineNodes)
    const references = render(Array.from({ length: 10 }, () => "x[^1]".repeat(100)).join("\n\n") + "\n\n[^1]: n")
    assert.strictEqual(references.match(/(?<!\\)\[\^1\]/g)?.length, maxFootnoteReferences + 1)
  })

  it("escapes the pipes of a table wider than 20 columns", () => {
    const row = (cell: string) => "|" + ` ${cell} |`.repeat(21)
    assert.isFalse(/(^|[^\\])\|/.test(render(row("c") + "\n" + row("-"))))
  })

  it("closes an open fence before the media references", () => {
    assert.strictEqual(render("```\n<b>", { files: 1 }), "```\n<b>\n```\n\n![](tg://document?id=f1)")
  })

  it("never exceeds measure, with the reservation for files", () => {
    const markdown = fc.string({
      unit: fc.oneof(
        fc.constantFrom(
          ..."<>$=|![]()*_~`#-+.:/\\&;\n\r \t0123456789abc",
          "\u0000",
          "é",
          "€",
          "😀",
          "\ud800",
          "tg://",
          "https://"
        ),
        fc.string({ maxLength: 3 })
      ),
      maxLength: 200
    })
    const bytes = (s: string) => new TextEncoder().encode(s).length
    fc.assert(fc.property(markdown, fc.integer({ min: 0, max: 10 }), (input, files) => {
      assert.isAtMost(bytes(render(input)), measure(input))
      assert.isAtMost(bytes(render(input, { files })), measure(input) + reservation)
    }))
  })
})
