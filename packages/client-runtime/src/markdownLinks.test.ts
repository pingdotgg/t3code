import { describe, expect, it } from "vite-plus/test";

import {
  fileBasename,
  inlineCodeFilePathCandidate,
  parseFileUrlHref,
  parseMarkdownFileLink,
  repairMarkdownImageDestinations,
  splitFilePathPosition,
  workspaceRelativeFilePath,
} from "./markdownLinks.ts";

describe("inlineCodeFilePathCandidate", () => {
  it.each([
    ["src\\main.ts", "src/main.ts"],
    ["C:\\Users\\demo\\image.png", "C:\\Users\\demo\\image.png"],
    ["\\\\server\\share\\image.png", "\\\\server\\share\\image.png"],
    ["conf.d/nginx.conf", "conf.d/nginx.conf"],
    ["script.pl:10", "script.pl:10"],
    ["node.meta", null],
    ["Recorded evidence here: /tmp/image.png", null],
    ["origin/main", null],
    ["127.0.0.1:3000", null],
    ["example.com/index.html", null],
    ["example.pl/index.html", null],
  ])("distinguishes file paths from code and hostnames in %s", (source, candidate) => {
    expect(inlineCodeFilePathCandidate(source)).toBe(candidate);
  });
});

describe("parseFileUrlHref", () => {
  it.each([
    ["file:///Users/julius/project/src/main.ts#L42", "/Users/julius/project/src/main.ts", "#L42"],
    [
      "file:///D:/Programme/t3code/OpenInPicker.tsx#L69",
      "D:/Programme/t3code/OpenInPicker.tsx",
      "#L69",
    ],
    ["file://server/share/workspace-image.svg", "\\\\server\\share\\workspace-image.svg", ""],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md", ""],
  ])("parses %s", (href, path, hash) => {
    expect(parseFileUrlHref(href)).toEqual({ path, hash });
  });

  it("keeps percent-encoding so the caller decodes once", () => {
    expect(parseFileUrlHref("file:///Users/julius/project/file%2520name.md")?.path).toBe(
      "/Users/julius/project/file%2520name.md",
    );
    expect(parseFileUrlHref("file:///c%3A/Users/x/shot.png")?.path).toBe("/c%3A/Users/x/shot.png");
  });

  it.each(["https://example.com/a.ts", "file://%", "/Users/julius/a.ts"])("rejects %s", (href) => {
    expect(parseFileUrlHref(href)).toBeNull();
  });
});

describe("splitFilePathPosition", () => {
  it.each([
    ["src/main.ts", "", { path: "src/main.ts" }],
    ["src/main.ts:12", "", { path: "src/main.ts", line: 12 }],
    ["src/main.ts:12:5", "", { path: "src/main.ts", line: 12, column: 5 }],
    ["src/main.ts", "#L18C2", { path: "src/main.ts", line: 18, column: 2 }],
    ["src/main.ts:3", "#L18C2", { path: "src/main.ts", line: 3 }],
    ["src/main.ts:0", "", { path: "src/main.ts" }],
    ["src/main.ts", "#section", { path: "src/main.ts" }],
  ])("splits %s%s", (path, hash, expected) => {
    expect(splitFilePathPosition(path, hash)).toEqual(expected);
  });
});

describe("parseMarkdownFileLink", () => {
  // Both clients consume this table, so a path the web app recognizes is one
  // the mobile app recognizes too.
  it.each([
    ["/Users/julius/project/AGENTS.md", "/Users/julius/project/AGENTS.md"],
    ["/home/me/notes.md", "/home/me/notes.md"],
    ["/usr/local/bin/tool", "/usr/local/bin/tool"],
    ["/workspace/Makefile", "/workspace/Makefile"],
    ["/tmp/favicons/", "/tmp/favicons/"],
    ["C:\\Users\\mike\\project\\src\\main.ts", "C:\\Users\\mike\\project\\src\\main.ts"],
    ["C:%5Crepo%5Cimage.png", "C:\\repo\\image.png"],
    ["\\\\server\\share\\image.png", "\\\\server\\share\\image.png"],
    ["/D:/Programme/t3code/OpenInPicker.tsx", "D:/Programme/t3code/OpenInPicker.tsx"],
    ["</D:/Programme/t3code/ChatMarkdown.tsx:1>", "D:/Programme/t3code/ChatMarkdown.tsx"],
    ["file:///Users/julius/project/file%2520name.md", "/Users/julius/project/file%20name.md"],
    ["file://server/share/workspace-image.svg", "\\\\server\\share\\workspace-image.svg"],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md"],
    ["apps/mobile/src/index.ts:10", "apps/mobile/src/index.ts"],
    ["docs/My%20Folder/checklist.xml", "docs/My Folder/checklist.xml"],
    ["Updated%20cutover%20checklist.md", "Updated cutover checklist.md"],
    ["./scripts/deploy", "./scripts/deploy"],
    ["~/notes/today.md", "~/notes/today.md"],
    ["AGENTS.md", "AGENTS.md"],
    ["script.ts:10", "script.ts"],
    ["/tmp/clip%23one.mp4#t=2", "/tmp/clip#one.mp4"],
  ])("recognizes %s as a file", (href, path) => {
    expect(parseMarkdownFileLink(href)?.path).toBe(path);
  });

  it.each([
    "",
    "#anchor",
    "//cdn.example.com/clip.mp4",
    "https://example.com/docs",
    "mailto:someone@example.com",
    "javascript:alert(1)",
    "/chat/settings",
    "/chat/settings#L3",
    "/app#L1",
    "readme",
    "TODO:12",
  ])("does not treat %s as a file", (href) => {
    expect(parseMarkdownFileLink(href)).toBeNull();
  });

  it("accepts conventional extensionless names with or without a position", () => {
    expect(parseMarkdownFileLink("Makefile")).toEqual({ path: "Makefile" });
    expect(parseMarkdownFileLink("Dockerfile:8")).toEqual({ path: "Dockerfile", line: 8 });
    expect(parseMarkdownFileLink("/srv/app/Makefile")).toEqual({ path: "/srv/app/Makefile" });
  });

  it("reads positions from suffixes and line anchors", () => {
    expect(parseMarkdownFileLink("/Users/julius/project/src/main.ts#L42C7")).toEqual({
      path: "/Users/julius/project/src/main.ts",
      line: 42,
      column: 7,
    });
    expect(parseMarkdownFileLink("file://server/share/src/main.ts#L42C7")).toMatchObject({
      path: "\\\\server\\share\\src\\main.ts",
      line: 42,
      column: 7,
    });
  });
});

describe("fileBasename", () => {
  it.each([
    ["/tmp/favicons/", "favicons"],
    ["C:\\Users\\kelchm\\.claude\\", ".claude"],
    ["/tmp/", "tmp"],
    ["AGENTS.md", "AGENTS.md"],
    ["/", "/"],
  ])("labels %s as %s", (path, basename) => {
    expect(fileBasename(path)).toBe(basename);
  });
});

describe("workspaceRelativeFilePath", () => {
  it.each([
    ["/repo/project/src/main.ts", "/repo/project", "src/main.ts"],
    ["/repo/project/src/main.ts", "/repo/project/", "src/main.ts"],
    ["C:\\Users\\mike\\t3code\\apps\\web\\a.ts", "C:/Users/mike/t3code", "apps/web/a.ts"],
    ["/C:/Users/mike/t3code/apps/web/a.ts", "C:/Users/mike/t3code", "apps/web/a.ts"],
    ["/Repo/Project/src/main.ts", "/repo/project", null],
    ["/tmp/case/project/probe.txt", "/tmp/case/Project", null],
    ["//tmp/case/project/probe.txt", "//tmp/case/Project", null],
    ["/tmp/case/Project/probe.txt", "/tmp/case/Project", "probe.txt"],
    ["C:/USERS/mike/t3code/main.ts", "c:/users/MIKE/t3code", "main.ts"],
    ["/C:/USERS/mike/t3code/main.ts", "/c:/users/MIKE/t3code", "main.ts"],
    ["\\\\server\\share\\PROJECT\\main.ts", "\\\\Server\\Share\\Project", "main.ts"],
    ["/tmp/repo/file.ts", "/", "tmp/repo/file.ts"],
    ["C:/Users/MIKE/main.ts", "c:/", "Users/MIKE/main.ts"],
    ["\\\\server\\SHARE\\file.ts", "\\\\Server\\Share\\", "file.ts"],
    ["/tmp/repo/file.ts ", "/tmp/repo", "file.ts "],
    ["/tmp/report.ts", "/repo/project", null],
    ["/repo/project-two/a.ts", "/repo/project", null],
    ["/repo/project/a.ts", undefined, null],
  ])("relates %s to %s", (path, workspaceRoot, relativePath) => {
    expect(workspaceRelativeFilePath(path, workspaceRoot)).toBe(relativePath);
  });
});

describe("repairMarkdownImageDestinations", () => {
  it("angle-quotes a Windows path with spaces an agent wrote as the destination", () => {
    const markdown = String.raw`![Settings → General](D:\my projects\demo shots\cmp.png)`;
    expect(repairMarkdownImageDestinations(markdown)).toBe(
      String.raw`![Settings → General](<D:\\my projects\\demo shots\\cmp.png>)`,
    );
  });

  it("doubles the backslashes so a path segment starting with punctuation survives", () => {
    // `\.` and `\_` are escapes inside a destination: written once, the parser
    // hands back `D:\shots.cache\a b.png` and the file is never found.
    expect(repairMarkdownImageDestinations(String.raw`![a](D:\shots\.cache\_x\a b.png)`)).toBe(
      String.raw`![a](<D:\\shots\\.cache\\_x\\a b.png>)`,
    );
  });

  it("keeps a UNC path's leading pair of separators", () => {
    expect(repairMarkdownImageDestinations(String.raw`![a](\\server\share\my shots\a b.png)`)).toBe(
      String.raw`![a](<\\\\server\\share\\my shots\\a b.png>)`,
    );
  });

  it("angle-quotes a POSIX path with spaces and keeps its hash", () => {
    expect(repairMarkdownImageDestinations("![chart](/tmp/my charts/growth.png#L2)")).toBe(
      "![chart](</tmp/my charts/growth.png#L2>)",
    );
  });

  it("angle-quotes every image on a line and holds balanced parens in the destination", () => {
    expect(
      repairMarkdownImageDestinations(
        String.raw`![a](C:\pics\Screenshot (1).png) ![b](/tmp/x y.png)`,
      ),
    ).toBe(String.raw`![a](<C:\\pics\\Screenshot (1).png>) ![b](</tmp/x y.png>)`);
  });

  it("keeps a parenthesis escaped inside the destination", () => {
    expect(repairMarkdownImageDestinations(String.raw`![x](C:\dir with spaces\report\).png)`)).toBe(
      String.raw`![x](<C:\\dir with spaces\\report\\).png>)`,
    );
  });

  it("repairs alt text carrying escaped and nested brackets", () => {
    expect(repairMarkdownImageDestinations(String.raw`![see \[this\]](/tmp/a b.png)`)).toBe(
      String.raw`![see \[this\]](</tmp/a b.png>)`,
    );
    expect(repairMarkdownImageDestinations("![a [b] c](/tmp/a b.png)")).toBe(
      "![a [b] c](</tmp/a b.png>)",
    );
  });

  it("leaves destinations that parse on their own as written", () => {
    expect(repairMarkdownImageDestinations("![shot](shots/cmp.png)")).toBe(
      "![shot](shots/cmp.png)",
    );
    expect(repairMarkdownImageDestinations("![shot](<shots/a b.png>)")).toBe(
      "![shot](<shots/a b.png>)",
    );
    expect(repairMarkdownImageDestinations('![shot](shots/a.png "Title")')).toBe(
      '![shot](shots/a.png "Title")',
    );
    expect(repairMarkdownImageDestinations("![shot](shots/'a b'.png)")).toBe(
      "![shot](shots/'a b'.png)",
    );
  });

  it("leaves prose without a path separator as written", () => {
    expect(repairMarkdownImageDestinations("![figure](one and two)")).toBe(
      "![figure](one and two)",
    );
  });

  it("leaves fenced code, inline code, and link syntax alone", () => {
    const markdown = [
      "```text",
      String.raw`![a](C:\dir with spaces\a.png)`,
      "```",
      "`" + String.raw`![b](C:\d e\b.png)` + "`",
      String.raw`[docs](C:\d e\docs.md)`,
    ].join("\n");
    expect(repairMarkdownImageDestinations(markdown)).toBe(markdown);
  });

  it("keeps an unclosed fence inert to the end", () => {
    const markdown = "```text\n" + String.raw`![a](C:\d e\a.png)`;
    expect(repairMarkdownImageDestinations(markdown)).toBe(markdown);
  });

  it("leaves a code span that closes on a later line alone", () => {
    const markdown = ["`literal", String.raw`![x](C:\d e\x.png)`, "text`"].join("\n");
    expect(repairMarkdownImageDestinations(markdown)).toBe(markdown);
  });

  it("repairs past a backtick that never closes, because it is literal text", () => {
    expect(
      repairMarkdownImageDestinations(String.raw`a ` + "`" + String.raw` ![x](/tmp/a b.png)`),
    ).toBe(String.raw`a ` + "`" + String.raw` ![x](</tmp/a b.png>)`);
  });

  it("leaves an escaped image marker alone", () => {
    const markdown = String.raw`\![x](C:\d e\x.png)`;
    expect(repairMarkdownImageDestinations(markdown)).toBe(markdown);
  });

  it("leaves every CommonMark HTML block alone", () => {
    for (const markdown of [
      "<div>\n" + String.raw`![x](/tmp/a b.png)` + "\n</div>",
      String.raw`<!-- ![x](/tmp/a b.png) -->`,
      "<![CDATA[\n" + String.raw`![x](/tmp/a b.png)` + "\n]]>",
      "<table>\n<tr><td>\n" + String.raw`![x](/tmp/a b.png)` + "\n</td></tr>\n</table>",
    ]) {
      expect(repairMarkdownImageDestinations(markdown)).toBe(markdown);
    }
  });

  it("knows a heading ends the paragraph a tag could not interrupt", () => {
    // A standalone tag opens an HTML block only where a block can start, and a
    // heading or thematic break above it ends the line's block.
    for (const before of ["# H", "---", "H\n==="]) {
      const markdown = `${before}\n<x>\n` + String.raw`![x](/tmp/a b.png)`;
      expect(repairMarkdownImageDestinations(markdown)).toBe(markdown);
    }
    // A paragraph or a list item above it is still open, so these are text.
    for (const before of ["text", "- item"]) {
      expect(
        repairMarkdownImageDestinations(`${before}\n<x>\n` + String.raw`![x](/tmp/a b.png)`),
      ).toBe(`${before}\n<x>\n` + String.raw`![x](</tmp/a b.png>)`);
    }
  });

  it("repairs an image inside a heading", () => {
    expect(repairMarkdownImageDestinations(String.raw`# ![x](/tmp/a b.png)`)).toBe(
      String.raw`# ![x](</tmp/a b.png>)`,
    );
  });

  it("repairs a paragraph that opens with an inline tag", () => {
    // `em` is not a block tag and the tag is not alone on the line, so this is
    // a paragraph and the image in it is live Markdown.
    expect(repairMarkdownImageDestinations("<em>hi</em> ![x](/tmp/a b.png)")).toBe(
      "<em>hi</em> ![x](</tmp/a b.png>)",
    );
  });

  it("closes a fence and repairs past it in a CRLF document", () => {
    const markdown = "```text\r\n" + String.raw`![a](C:\d e\a.png)` + "\r\n```\r\n";
    expect(repairMarkdownImageDestinations(markdown + String.raw`![b](/tmp/c d.png)`)).toBe(
      markdown + String.raw`![b](</tmp/c d.png>)`,
    );
  });

  it("leaves a raw HTML block alone", () => {
    const inline = String.raw`<pre>![x](C:\d e\x.png)</pre>`;
    expect(repairMarkdownImageDestinations(inline)).toBe(inline);
    const block = ["<pre>", String.raw`![x](C:\d e\x.png)`, "</pre>"].join("\n");
    expect(repairMarkdownImageDestinations(block)).toBe(block);
  });

  it("ends an indented code block at the first unindented line", () => {
    expect(repairMarkdownImageDestinations("    code\n" + String.raw`![x](/tmp/a b.png)`)).toBe(
      "    code\n" + String.raw`![x](</tmp/a b.png>)`,
    );
  });

  it("leaves an indented code block alone but repairs a paragraph's own lines", () => {
    const code = "text\n\n" + String.raw`    ![x](C:\d e\x.png)`;
    expect(repairMarkdownImageDestinations(code)).toBe(code);
    expect(repairMarkdownImageDestinations("text\n" + String.raw`    ![x](/tmp/a b.png)`)).toBe(
      "text\n" + String.raw`    ![x](</tmp/a b.png>)`,
    );
  });

  it("repairs under a line that only looks like a fence", () => {
    // A backtick fence's info string may not contain a backtick, so the line
    // below opens no fence and the image under it is live Markdown.
    expect(
      repairMarkdownImageDestinations("```js`x\n" + String.raw`![a](/tmp/a b.png)` + "\n```"),
    ).toBe("```js`x\n" + String.raw`![a](</tmp/a b.png>)` + "\n```");
  });
});
