import { fits, render } from "@effect/chat-whatsapp/internal/text"
import { assert, describe, it } from "@effect/vitest"
import * as fc from "fast-check"

const cases: ReadonlyArray<readonly [string, string]> = [
  ["**b** and __b__", "*b* and *b*"],
  ["*i* and _i_", "_i_ and _i_"],
  ["~~s~~ and ~s~", "~s~ and ~s~"],
  ["**a *b* c**", "*a _b_ c*"],
  ["[label](https://e.com \"title\")", "label (https://e.com)"],
  ["![alt](https://e.com/a.png)", "alt (https://e.com/a.png)"],
  ["[](https://e.com)", "https://e.com"],
  ["<https://e.com>", "https://e.com"],
  ["# Title #", "*Title*"],
  ["Title\n===\n", "*Title*\n"],
  ["#", "#"],
  ["| a | b |\n|---|---|\n| 1 | 2 |", "| a | b |\n| 1 | 2 |"],
  ["~~~ts\n**x**\n~~~\n", "```\n**x**\n```\n"],
  ["&amp; &lt; &#233; &#x1F600;", "& < \u00e9 \u{1F600}"],
  ["&nGt; &nLt; &ast; &#42;", "&nGt; &nLt; &ast; &#42;"],
  ["[a][r] and [r]\n\n[r]: https://e.com", "[a][r] and [r]\n\n[r]: https://e.com"],
  ["`**x**` ``a`` \\*x\\* <b>**x**</b>", "`**x**` ``a`` \\*x\\* <b>*x*</b>"],
  ["a_b_c and 2*3*4", "a_b_c and 2_3_4"],
  ["    **indented**", "    **indented**"],
  ["- **item**\n> **quote**", "- *item*\n> *quote*"],
  ["[**x**] and ![**y**]\n\n[**x**]: https://e.com", "[**x**] and ![**y**]\n\n[**x**]: https://e.com"],
  ["[r]:\n  <https://e.com>\n  \"**t**\"\n\n**x**", "[r]:\n  <https://e.com>\n  \"**t**\"\n\n*x*"],
  ["> ~~~js\n> **x**\n> ~~~\n\n**y**", "> ~~~js\n> **x**\n> ~~~\n\n*y*"],
  ["- ```\n  **x**\n  ```", "- ```\n  **x**\n  ```"],
  ["> ~~~js\n> > ~~~\n> **x**\n> ~~~\n\n**y**", "> ~~~js\n> > ~~~\n> **x**\n> ~~~\n\n*y*"],
  ["- > ~~~\n  >       ~~~\n  > **x**\n  > ~~~", "- > ~~~\n  >       ~~~\n  > **x**\n  > ~~~"],
  ["> ~~~\n> **x**\n\n**y**", "> ~~~\n> **x**\n\n*y*"],
  ["[r]: /url\n~~~js\n\n**x**\n~~~", "[r]: /url\n```\n\n**x**\n```"],
  ["| a |\n|---|\n~~~\n\n**x**\n~~~", "| a |\n```\n\n**x**\n```"],
  ["- ~~~js\n\t  ~~~\n  **x**\n  ~~~", "- ~~~js\n\t  ~~~\n  **x**\n  ~~~"],
  [">\t  ~~~\n>\t  **x**\n>\t  ~~~", ">\t  ~~~\n>\t  **x**\n>\t  ~~~"]
]

const longer = (input: string) => {
  const output = render(input)
  return fits(output, input) ? undefined : output
}

describe("render", () => {
  it("renders each construct", () => {
    for (const [input, expected] of cases) assert.strictEqual(render(input), expected, input)
  })

  it("never grows Markdown, in code points, UTF-16 units or UTF-8 bytes", () => {
    const token = fc.constantFrom(
      "*",
      "**",
      "_",
      "__",
      "~",
      "~~",
      "`",
      "```",
      "#",
      "# ",
      "[",
      "]",
      "(",
      ")",
      "![",
      "<",
      ">",
      "&",
      ";",
      "\\",
      "|",
      "|---|",
      "-",
      "=",
      "\n",
      " ",
      "a",
      "\u00e9",
      "\u{1F600}",
      "https://e.com",
      "&amp;",
      "&#",
      "&nGt;",
      "~~~",
      "x",
      "> ",
      "- ",
      "  ",
      "[r]: u"
    )
    fc.assert(fc.property(fc.array(token, { maxLength: 40 }), (tokens) => longer(tokens.join("")) === undefined))
  })

  it("never grows a character reference", () => {
    const numbers = [0, 1, 0x2a, 0x7f, 0x80, 0x7ff, 0x800, 0xd800, 0xffff, 0x10000, 0x10ffff, 0x110000]
    const references = [
      ...["amp", "lt", "nbsp", "hellip", "mdash", "frac34", "iquest", "nGt", "ast"].map((name) => "&" + name),
      ...numbers.flatMap((n) => ["&#" + n, "&#x" + n.toString(16)])
    ]
    for (const reference of references) {
      for (const input of [reference, reference + ";"]) assert.strictEqual(longer(input), undefined, input)
    }
  })
})
