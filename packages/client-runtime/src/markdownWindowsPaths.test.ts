import { describe, expect, it } from "vite-plus/test";

import { normalizeWindowsMarkdownDestinations } from "./markdownWindowsPaths.js";

describe("normalizeWindowsMarkdownDestinations", () => {
  it.each([
    [
      String.raw`![Breeze](C:\Users\dara\.t3\worktrees\app\build\breeze_attack_0.png)`,
      "![Breeze](C:/Users/dara/.t3/worktrees/app/build/breeze_attack_0.png)",
    ],
    [
      String.raw`See [notes](C:\Users\dara\.claude\notes.md) and [build](D:\_out\-x\report.html).`,
      "See [notes](C:/Users/dara/.claude/notes.md) and [build](D:/_out/-x/report.html).",
    ],
    [
      String.raw`![shot](<C:\Users\dara\my dir\.t3\shot.png>)`,
      "![shot](<C:/Users/dara/my dir/.t3/shot.png>)",
    ],
    // Parentheses need no escaping inside angle brackets.
    [String.raw`![shot](<C:\repo\(old)\.t3\shot.png>)`, "![shot](<C:/repo/(old)/.t3/shot.png>)"],
    // A forward-slash root with a backslash suffix still needs the suffix fixed.
    [String.raw`![shot](C:/repo\.t3\shot.png)`, "![shot](C:/repo/.t3/shot.png)"],
    [
      String.raw`![shot](C:\Users\dara\.t3\shot.png "Title")`,
      '![shot](C:/Users/dara/.t3/shot.png "Title")',
    ],
    [
      String.raw`[![shot](c:\a\.b\shot.png)](c:\a\.b\shot.png)`,
      "[![shot](c:/a/.b/shot.png)](c:/a/.b/shot.png)",
    ],
  ])("rewrites Windows drive destinations to forward slashes: %s", (markdown, expected) => {
    const normalized = normalizeWindowsMarkdownDestinations(markdown);
    expect(normalized).toBe(expected);
    expect(normalized).toHaveLength(markdown.length);
  });

  it.each([
    "![shot](C:/Users/dara/.t3/shot.png)",
    "![shot](/home/dara/.t3/shot.png)",
    "![shot](https://example.com/C:\\not\\a\\path.png)",
    String.raw`Run C:\Users\dara\.t3\bin\t3.exe to start.`,
    "Path is `C:\\Users\\dara\\.t3` on disk.",
    String.raw`![shot](\\server\share\.t3\shot.png)`,
    "plain text without any destinations",
  ])("leaves %s unchanged", (markdown) => {
    expect(normalizeWindowsMarkdownDestinations(markdown)).toBe(markdown);
  });

  it("leaves inline code and fenced code blocks as written", () => {
    const markdown = [
      "Use `![x](C:\\a\\.b\\x.png)` for images.",
      "",
      "```md",
      String.raw`![x](C:\a\.b\x.png)`,
      "```",
      "",
      String.raw`![y](C:\a\.b\y.png)`,
      "",
      "~~~",
      String.raw`[z](C:\a\.b\z.md)`,
      "~~~",
    ].join("\n");

    expect(normalizeWindowsMarkdownDestinations(markdown)).toBe(
      [
        "Use `![x](C:\\a\\.b\\x.png)` for images.",
        "",
        "```md",
        String.raw`![x](C:\a\.b\x.png)`,
        "```",
        "",
        "![y](C:/a/.b/y.png)",
        "",
        "~~~",
        String.raw`[z](C:\a\.b\z.md)`,
        "~~~",
      ].join("\n"),
    );
  });

  it.each([
    // Not a link as written: the parser reads `\(` as an escape and stops at `)`.
    // Reading every backslash as a separator repairs it.
    [
      String.raw`[x](C:\repo\(old)\.t3\shot.png) and [y](C:\a\(b)(c)\.d\e.md)`,
      "[x](C:/repo/(old)/.t3/shot.png) and [y](C:/a/(b)(c)/.d/e.md)",
    ],
    [String.raw`[x](C:\a\.b\x.md)) trailing`, "[x](C:/a/.b/x.md)) trailing"],
    // A path ending in a parenthesized segment closes right before the link's own `)`.
    [String.raw`[x](C:\repo\(old))`, "[x](C:/repo/(old))"],
    // A link as written keeps its escaped parenthesis so it still parses.
    [
      String.raw`[x](C:\a\(foo.png) and [y](C:\a\.b\)x.md "t")`,
      String.raw`[x](C:/a\(foo.png) and [y](C:/a/.b\)x.md "t")`,
    ],
  ])("honors balanced parentheses in bare destinations: %s", (markdown, expected) => {
    expect(normalizeWindowsMarkdownDestinations(markdown)).toBe(expected);
  });

  it("does not treat mismatched or escaped backtick runs as code spans", () => {
    expect(normalizeWindowsMarkdownDestinations("`a [x](C:\\a\\.b\\x.md) ``")).toBe(
      "`a [x](C:/a/.b/x.md) ``",
    );
    expect(normalizeWindowsMarkdownDestinations("\\`not code [x](C:\\a\\.b\\x.md)\\`")).toBe(
      "\\`not code [x](C:/a/.b/x.md)\\`",
    );
    expect(normalizeWindowsMarkdownDestinations("``a ` b [x](C:\\a\\.b\\x.md)``")).toBe(
      "``a ` b [x](C:\\a\\.b\\x.md)``",
    );
    // Two backslashes are an escaped backslash, so the backtick after them still opens a span.
    expect(
      normalizeWindowsMarkdownDestinations("\\\\`[x](C:\\a\\.b\\x.md)` and [y](C:\\a\\.b\\y.md)"),
    ).toBe("\\\\`[x](C:\\a\\.b\\x.md)` and [y](C:/a/.b/y.md)");
    // Escapes are inert inside a code span, so a backslash before the closer still closes it.
    expect(
      normalizeWindowsMarkdownDestinations("`[x](C:\\a\\.b\\x.md)\\` and [y](C:\\a\\.b\\y.md)"),
    ).toBe("`[x](C:\\a\\.b\\x.md)\\` and [y](C:/a/.b/y.md)");
  });

  it("rewrites reference-style link and image definitions", () => {
    const markdown = [
      "![shot][asset] and [notes][n]",
      "",
      String.raw`[asset]: C:\repo\.t3\shot.png "Shot"`,
      String.raw`   [n]: <C:\repo\.claude\notes.md>`,
      String.raw`[a\]]:`,
      String.raw`C:\repo\.t3\x.png`,
      String.raw`> [q]: C:\repo\.t3\q.png`,
      String.raw`>[r]: C:\repo\.t3\r.png`,
      String.raw`- [l]: C:\repo\.t3\l.png`,
      String.raw`not a definition [n]: C:\repo\.claude\x.md`,
    ].join("\n");
    expect(normalizeWindowsMarkdownDestinations(markdown)).toBe(
      [
        "![shot][asset] and [notes][n]",
        "",
        '[asset]: C:/repo/.t3/shot.png "Shot"',
        "   [n]: <C:/repo/.claude/notes.md>",
        String.raw`[a\]]:`,
        "C:/repo/.t3/x.png",
        "> [q]: C:/repo/.t3/q.png",
        ">[r]: C:/repo/.t3/r.png",
        "- [l]: C:/repo/.t3/l.png",
        String.raw`not a definition [n]: C:\repo\.claude\x.md`,
      ].join("\n"),
    );
  });

  it("leaves fenced code nested in block quotes and list items as written", () => {
    const markdown = [
      "> ```",
      String.raw`> [x](C:\a\.b\x.md)`,
      "> ```",
      "",
      "- item",
      "",
      "  ```",
      String.raw`  [y](C:\a\.b\y.md)`,
      "  ```",
      "",
      String.raw`[z](C:\a\.b\z.md)`,
    ].join("\n");
    expect(normalizeWindowsMarkdownDestinations(markdown)).toBe(
      markdown.replace(String.raw`[z](C:\a\.b\z.md)`, "[z](C:/a/.b/z.md)"),
    );
  });

  it("does not open a backtick fence whose info string holds a backtick", () => {
    const markdown = ["```js`x", String.raw`[x](C:\a\.b\x.md)`].join("\n");
    expect(normalizeWindowsMarkdownDestinations(markdown)).toBe(
      ["```js`x", "[x](C:/a/.b/x.md)"].join("\n"),
    );
    const tilde = ["~~~js`x", String.raw`[x](C:\a\.b\x.md)`].join("\n");
    expect(normalizeWindowsMarkdownDestinations(tilde)).toBe(tilde);
  });

  it("leaves a fence indented under a nested list item as written", () => {
    const markdown = [
      "- item",
      "  - example",
      "",
      "      ~~~markdown",
      String.raw`      ![shot](C:\Users\dara\.t3\shot.png)`,
      "      ~~~",
      "",
      String.raw`![y](C:\a\.b\y.md)`,
    ].join("\n");
    expect(normalizeWindowsMarkdownDestinations(markdown)).toBe(
      markdown.replace(String.raw`[y](C:\a\.b\y.md)`, "[y](C:/a/.b/y.md)"),
    );
  });

  it("ends an indented fence-looking block where its indentation ends", () => {
    const markdown = [
      "    ~~~",
      "",
      String.raw`![shot](C:\Users\dara\.t3\shot.png)`,
      "",
      "- [ ] Review",
    ].join("\n");
    expect(normalizeWindowsMarkdownDestinations(markdown)).toBe(
      markdown.replace(String.raw`(C:\Users\dara\.t3\shot.png)`, "(C:/Users/dara/.t3/shot.png)"),
    );
  });

  it("keeps a slightly indented top-level fence open over unindented content", () => {
    const markdown = ["  ```", String.raw`[x](C:\a\.b\x.md)`, "  ```"].join("\n");
    expect(normalizeWindowsMarkdownDestinations(markdown)).toBe(markdown);
  });

  it("closes an unterminated fence when its list item ends", () => {
    const markdown = [
      "- ```markdown",
      "  example",
      "",
      String.raw`![shot](C:\Users\dara\.t3\shot.png)`,
    ].join("\n");
    expect(normalizeWindowsMarkdownDestinations(markdown)).toBe(
      markdown.replace(String.raw`(C:\Users\dara\.t3\shot.png)`, "(C:/Users/dara/.t3/shot.png)"),
    );
  });

  it("does not let a code span cross a blank line", () => {
    const markdown = [
      "An unmatched ` here.",
      "",
      String.raw`![shot](C:\Users\dara\.t3\shot.png)`,
      "",
      "Another ` here.",
    ].join("\n");
    expect(normalizeWindowsMarkdownDestinations(markdown)).toBe(
      markdown.replace(String.raw`(C:\Users\dara\.t3\shot.png)`, "(C:/Users/dara/.t3/shot.png)"),
    );
  });

  it("closes an unterminated fence when its block quote ends", () => {
    const markdown = [
      "> ```",
      String.raw`> [x](C:\a\.b\x.md)`,
      "",
      String.raw`[y](C:\a\.b\y.md)`,
    ].join("\n");
    expect(normalizeWindowsMarkdownDestinations(markdown)).toBe(
      ["> ```", String.raw`> [x](C:\a\.b\x.md)`, "", "[y](C:/a/.b/y.md)"].join("\n"),
    );
  });

  it("keeps rewriting after an unterminated fence ends the document", () => {
    const markdown = [String.raw`![a](C:\a\.b\a.png)`, "```", String.raw`![b](C:\a\.b\b.png)`].join(
      "\n",
    );
    expect(normalizeWindowsMarkdownDestinations(markdown)).toBe(
      ["![a](C:/a/.b/a.png)", "```", String.raw`![b](C:\a\.b\b.png)`].join("\n"),
    );
  });

  it("is idempotent", () => {
    const markdown = String.raw`![shot](C:\Users\dara\.t3\shot.png)`;
    const once = normalizeWindowsMarkdownDestinations(markdown);
    expect(normalizeWindowsMarkdownDestinations(once)).toBe(once);
  });
});
