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
