import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { splitPullRequestBody, type PullRequestBodySegment } from "./pullRequestMarkdown.ts";
import {
  changeRequestReferenceAutolinker,
  resolveChangeRequestMediaUrl,
} from "./pullRequestReferences.ts";

const definitionParser = unified().use(remarkParse).use(remarkGfm);

// The finder a client passes: each first definition, joined onto one line out of its quote.
const split = (body: string) =>
  splitPullRequestBody(body, (markdown) => {
    const definitions = new Map<string, string>();
    const visit = (node: Root | RootContent, quotes: number) => {
      if (node.type === "definition" && !definitions.has(node.identifier)) {
        const wrap = new RegExp(`(?:\\r\\n|\\r|\\n)(?:[ \\t]*>){0,${quotes}}[ \\t]*`, "gu");
        const source = markdown.slice(node.position?.start.offset, node.position?.end.offset);
        definitions.set(node.identifier, source.replace(wrap, " "));
      }
      if ("children" in node) {
        for (const child of node.children)
          visit(child, quotes + (node.type === "blockquote" ? 1 : 0));
      }
    };
    visit(definitionParser.parse(markdown), 0);
    return [...definitions.values()];
  });

describe("pull request body segmentation", () => {
  // GitHub writes a dropped image into the body as an `<img>` tag, so a bare attachment link on
  // its own line is the shape it uses for a video — every one sampled in the wild was one.
  it("lifts a dropped video out and keeps the prose around it", () => {
    expect(
      split(
        "Before\n\nhttps://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456\n\nAfter",
      ),
    ).toEqual([
      { id: "markdown:0", kind: "markdown", text: "Before", sourceOffset: 0 },
      {
        id: "attachment:1",
        kind: "attachment",
        url: "https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456",
        media: "video",
      },
      { id: "markdown:2", kind: "markdown", text: "After", sourceOffset: 89 },
    ]);
  });

  it("places each prose run at its offset in the body, including inside a media table", () => {
    const body =
      '\n\n- [ ] Before\r\n\nhttps://example.com/shot.png\n\n\n<video controls>\n  <source src="https://example.com/a.mp4">\n</video>\n    - [ ] code\n- [x] After\n\r\n<table>\r\n<tr><td>\r\n\r\n- [ ] In a cell\r\n\r\n</td><td>\r\n\r\nhttps://example.com/b.mp4\r\n\r\n</td></tr>\r\n</table>\r\n- [ ] Last\n';
    type Prose = Extract<PullRequestBodySegment, { kind: "markdown" }>;
    const prose = (segments: ReadonlyArray<PullRequestBodySegment>): Prose[] =>
      segments.flatMap((segment) =>
        segment.kind === "markdown"
          ? [segment]
          : segment.kind === "table"
            ? segment.rows.flat().flatMap((cell) => prose(cell.segments))
            : [],
      );
    const runs = prose(split(body));
    expect(runs.map((segment) => segment.text)).toEqual([
      "- [ ] Before",
      "    - [ ] code\n- [x] After",
      "- [ ] In a cell",
      "- [ ] Last",
    ]);
    for (const segment of runs) {
      expect(body.slice(segment.sourceOffset, segment.sourceOffset + segment.text.length)).toBe(
        segment.text,
      );
    }
  });

  it("reads the source out of a video tag, including a multi-line one", () => {
    expect(
      split('<video controls>\n  <source src="https://example.com/a.webm">\n</video>'),
    ).toEqual([
      {
        id: "attachment:0",
        kind: "attachment",
        url: "https://example.com/a.webm",
        media: "video",
      },
    ]);
  });

  it("leaves the img tag GitHub writes for a dropped image as markdown", () => {
    const body =
      '<img width="1414" alt="image" src="https://github.com/user-attachments/assets/7195f963-51a9-4331-be74-3e06be760422" />';
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body, sourceOffset: 0 },
    ]);
  });

  it("leaves an ordinary link alone, whether it is bare or written as markdown", () => {
    const body = "https://example.com/page\n\n[the docs](https://example.com/docs)";
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body, sourceOffset: 0 },
    ]);
  });

  it("never lifts a link inside fenced code out of it", () => {
    const body = "```\nhttps://example.com/demo.mp4\n```";
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body, sourceOffset: 0 },
    ]);
  });

  // GitHub keeps CRLF in a body written in its web editor.
  it("recognizes fences in a body with CRLF line endings", () => {
    const body = "```\r\nhttps://example.com/demo.mp4\r\n```";
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body, sourceOffset: 0 },
    ]);
  });

  it("closes a CRLF fence, so a video after it still lifts out", () => {
    const code = '```html\r\n<video src="https://example.com/example.mp4"></video>\r\n```';
    expect(split(`${code}\r\n\r\nhttps://example.com/demo.mp4\r\n`)).toEqual([
      { id: "markdown:0", kind: "markdown", text: code, sourceOffset: 0 },
      {
        id: "attachment:1",
        kind: "attachment",
        url: "https://example.com/demo.mp4",
        media: "video",
      },
    ]);
  });

  it("does not let a different fence marker close an open fence", () => {
    const body = "```\n~~~\nhttps://example.com/demo.mp4\n```";
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body, sourceOffset: 0 },
    ]);
  });

  it("does not close a fence opened at the margin on a tab-indented marker", () => {
    const code = "```\n\t```\nhttps://example.com/sample.mp4\n```";
    expect(split(`${code}\n\nhttps://example.com/demo.mp4`)).toEqual([
      { id: "markdown:0", kind: "markdown", text: code, sourceOffset: 0 },
      {
        id: "attachment:1",
        kind: "attachment",
        url: "https://example.com/demo.mp4",
        media: "video",
      },
    ]);
    const listCode = "- List\n\n\t```md\n  https://example.com/sample.mp4\n\t```";
    expect(split(`${listCode}\n\nhttps://example.com/demo.mp4`)).toEqual([
      { id: "markdown:0", kind: "markdown", text: listCode, sourceOffset: 0 },
      {
        id: "attachment:1",
        kind: "attachment",
        url: "https://example.com/demo.mp4",
        media: "video",
      },
    ]);
  });

  it("keeps a video tag that shares its line with prose as markdown", () => {
    const body = 'Before <video src="https://example.com/a.mp4"></video> after';
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body, sourceOffset: 0 },
    ]);
    const captioned = '<video src="https://example.com/a.mp4"></video> Before the fix\n\nIt opens.';
    expect(split(`${captioned}\n\n<video src="https://example.com/b.mp4"></video>`)).toEqual([
      { id: "markdown:0", kind: "markdown", text: captioned, sourceOffset: 0 },
      { id: "attachment:1", kind: "attachment", url: "https://example.com/b.mp4", media: "video" },
    ]);
  });

  it("treats an info-string fence as a nested opener, not a close", () => {
    const body = "```\n```javascript\nhttps://example.com/demo.mp4\n```";
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body, sourceOffset: 0 },
    ]);
  });

  it("does not open a fence on a line of inline triple-backtick code", () => {
    const code = "```\nhttps://example.com/b.png\n```";
    expect(
      split(`\`\`\`npm test\`\`\` passes.\n\nhttps://example.com/demo.mp4\n\n${code}`),
    ).toEqual([
      { id: "markdown:0", kind: "markdown", text: "```npm test``` passes.", sourceOffset: 0 },
      {
        id: "attachment:1",
        kind: "attachment",
        url: "https://example.com/demo.mp4",
        media: "video",
      },
      { id: "markdown:2", kind: "markdown", text: code, sourceOffset: 54 },
    ]);
    const multilineSpan = "```foo`\nhttps://example.com/demo.mp4\nbar```";
    expect(split(multilineSpan)).toEqual([
      { id: "markdown:0", kind: "markdown", text: multilineSpan, sourceOffset: 0 },
    ]);
  });

  it("leaves an indented code line alone even when it is only a video link", () => {
    const body = "    https://example.com/demo.mp4";
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body, sourceOffset: 0 },
    ]);
  });

  it("leaves an unclosed video tag as prose without eating the rest of the body", () => {
    const body = ['<video src="https://example.com/a.mp4">', "still prose", "more prose"].join(
      "\n",
    );
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body, sourceOffset: 0 },
    ]);
  });

  it.each([
    ["a whitespace run inside a line", `a${" ".repeat(1_000_000)}b`],
    ["a run of unclosed video tags", `${"<video ".repeat(150_000)}</video>`],
    ["a run of backticks before a line separator", `${"`".repeat(100_000)}\u2028x`],
  ])("splits %s in one pass", (_case, body) => {
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body, sourceOffset: 0 },
    ]);
  });

  it("refuses a non-http source rather than making a link out of it", () => {
    const body = '<video src="javascript:alert(1)"></video>';
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body, sourceOffset: 0 },
    ]);
  });
});

describe("reference links around lifted media", () => {
  const recording =
    "https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456";
  const parser = unified().use(remarkParse).use(remarkGfm);
  const prose = (segments: ReadonlyArray<PullRequestBodySegment>): string[] =>
    segments.flatMap((segment) =>
      segment.kind === "markdown"
        ? [segment.text]
        : segment.kind === "table"
          ? segment.rows.flat().flatMap((cell) => prose(cell.segments))
          : [],
    );
  // Each segment renders as its own document; the first definition of a label wins, as in mdast-util-to-hast.
  const referenceLinks = (body: string) =>
    prose(split(body)).flatMap((text) => {
      const definitions = new Map<string, string>();
      const references: Array<{ identifier: string; text: string }> = [];
      const visit = (node: Root | RootContent) => {
        if (node.type === "definition" && !definitions.has(node.identifier)) {
          definitions.set(node.identifier, node.url);
        }
        if (node.type === "linkReference") {
          references.push({
            identifier: node.identifier,
            text: node.children.map((child) => ("value" in child ? child.value : "")).join(""),
          });
        }
        if ("children" in node) node.children.forEach(visit);
      };
      visit(parser.parse(text));
      return references.map((reference) => [reference.text, definitions.get(reference.identifier)]);
    });

  it.each([
    [
      "use, then media, then definition",
      `See [the docs][guide].\n\n${recording}\n\n[guide]: https://example.com/docs`,
    ],
    [
      "definition, then media, then use",
      `[guide]: https://example.com/docs\n\n${recording}\n\nSee [the docs][guide].`,
    ],
    ...["\n", "\r\n", "\r"].map((lineEnding) => [
      `a definition wrapped over quoted lines with ${JSON.stringify(lineEnding)}`,
      `> [guide]:${lineEnding}> https://example.com/docs${lineEnding}> "The guide"\n\n${recording}\n\nSee [the docs][guide].`,
    ]),
    [
      "a use inside a media table cell",
      `<table><tr><td>\n\nSee [the docs][guide].\n\n</td><td>\n\n${recording}\n\n</td></tr></table>\n\n[guide]: https://example.com/docs`,
    ],
  ])("resolves a reference defined across a video: %s", (_case, body) => {
    expect(referenceLinks(body)).toEqual([["the docs", "https://example.com/docs"]]);
  });

  it("keeps the body's first definition of a label, wherever the media falls", () => {
    expect(
      referenceLinks(
        `[guide]: https://example.com/first\n\n${recording}\n\nSee [the docs][guide].\n\n[GUIDE]: https://example.com/second`,
      ),
    ).toEqual([["the docs", "https://example.com/first"]]);
  });

  it("renders the body whole when its definitions would be repeated past the budget", () => {
    const definitions = Array.from(
      { length: 400 },
      (_, index) => `[d${index}]: https://example.com/${"x".repeat(60)}${index}`,
    ).join("\n");
    const uses = Array.from({ length: 1200 }, () => `[use][d1]\n${recording}`).join("\n");
    const body = `\n${definitions}\n\n${uses}\n`;
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body.trim(), sourceOffset: 1 },
    ]);
  });

  it("leaves a definition shown in code as code", () => {
    expect(
      referenceLinks(
        `\`\`\`md\n[guide]: https://example.com/docs\n\`\`\`\n\n${recording}\n\nSee [the docs][guide].`,
      ),
    ).toEqual([]);
  });

  it("still writes a task tick back to its place in the body", () => {
    const body = `[guide]: https://example.com/docs\n\n${recording}\n\n- [ ] Read [the docs][guide]`;
    const segment = split(body).at(-1)!;
    if (segment.kind !== "markdown") throw new Error("expected prose last");
    const marker = segment.text.indexOf("[ ]");
    expect(body.slice(segment.sourceOffset + marker)).toBe("[ ] Read [the docs][guide]");
  });

  it.each([
    ["\uFEFF", "", 0],
    ["intro\n\n\uFEFF", "intro\n\n\uFEFF", 0],
    [`${recording}\n\n\uFEFF`, "\uFEFF", 1],
  ])("preserves BOM meaning and task offsets after prefix %j", (prefix, kept, pick) => {
    const definition = "[guide]: https://example.com/docs";
    const task = "- [ ] Read [guide]";
    const body = `${prefix}${task}\n\n${recording}\n\n${definition}`;
    const segment = splitPullRequestBody(body, () => [definition])[pick]!;
    if (segment.kind !== "markdown") throw new Error("expected prose");
    expect(segment.text).toBe(`${definition}\n\n${kept}${task}`);
    expect(segment.sourceOffset + segment.text.indexOf("[ ]")).toBe(body.indexOf("[ ]"));
  });
});

describe("media on custom hosts", () => {
  it.each([
    ["https://drop.example.com/capture.PNG?token=abc#preview", "image"],
    ["[Recording](https://drop.example.com/recording.mov)", "video"],
    ["<https://drop.example.com/shot.webp>", "image"],
  ])("recognizes %s without a request", (body, media) => {
    expect(split(body)).toEqual([expect.objectContaining({ kind: "attachment", media })]);
  });

  it("keeps inline links and media examples in code as prose", () => {
    const body =
      "See [recording](https://drop.example.com/a.mp4) for context.\n\n```md\nhttps://drop.example.com/a.png\n```";
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body, sourceOffset: 0 },
    ]);
  });
});

describe("media tables", () => {
  const before = "https://github.com/user-attachments/assets/c69c7c1c-ef2f-47dd-97e8-fe42e40712eb";
  const after = "https://github.com/user-attachments/assets/1867b6ec-4f88-4248-b2df-6b0f9808105b";
  const video = "https://example.com/a.mp4";

  it("keeps GitHub's before/after video table together, splitting each cell on its own", () => {
    const segments = split(
      `Intro\n\n<table>\n<tr><th>Before</th><th>After</th></tr>\n<tr>\n<td>\n\n${before}\n\n</td>\n<td>\n\n${after}\n\n</td>\n</tr>\n</table>\n\nOutro`,
    );
    expect(segments.map((segment) => segment.kind)).toEqual(["markdown", "table", "markdown"]);
    expect(segments[0]).toMatchObject({ text: "Intro" });
    expect(segments[2]).toMatchObject({ text: "Outro" });
    const table = segments[1]!;
    if (table.kind !== "table") throw new Error("expected a table segment");
    expect(
      table.rows.map((row) =>
        row.map((cell) =>
          cell.segments.map((segment) =>
            segment.kind === "attachment" ? `attachment:${segment.url}` : segment,
          ),
        ),
      ),
    ).toEqual([
      [
        [{ id: "markdown:0", kind: "markdown", text: "Before", sourceOffset: 23 }],
        [{ id: "markdown:0", kind: "markdown", text: "After", sourceOffset: 38 }],
      ],
      [[`attachment:${before}`], [`attachment:${after}`]],
    ]);
  });

  it("keeps a quoted `>` inside a cell's attributes out of its text", () => {
    const [table] = split(
      `<table>\n<tr><td title="Before > after">Caption</td><td>\n\n${video}\n\n</td></tr>\n</table>`,
    );
    expect(table).toMatchObject({
      kind: "table",
      rows: [[{ segments: [{ kind: "markdown", text: "Caption" }] }, {}]],
    });
  });

  it("leaves a table without media links as markdown", () => {
    const body = "<table>\n<tr><td>a</td><td>b</td></tr>\n</table>";
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: body, sourceOffset: 0 },
    ]);
  });

  it.each([
    ["a caption", "<table>\n<caption>Before upgrading</caption>\n<tr><td>", "</td></tr>\n</table>"],
    ["text outside cells", "<table>\nBefore upgrading\n<tr><td>", "</td></tr>\n</table>"],
    [
      "text inside a row but outside cells",
      "<table>\n<tr>Before upgrading<td>",
      "</td></tr>\n</table>",
    ],
    [
      "a table nested in another",
      "<table>\n<tr><td>\n<table>\n<tr><td>",
      "</td></tr>\n</table>\n</td></tr>\n</table>",
    ],
    ["an unclosed table", "<table>\n<tr><td>", ""],
    ["a spanning cell", '<table>\n<tr><td colspan="2">', "</td></tr>\n</table>"],
    [
      "an indented cell",
      "<table>\n  <tr>\n    <th>\n      Before\n    </th>\n  </tr>\n  <tr><td>",
      "</td></tr>\n</table>",
    ],
    [
      "a cell indented by a space and a tab",
      "<table>\n<tr><td>\n \tBefore\n</td><td>",
      "</td></tr>\n</table>",
    ],
  ])("splits a media table with %s line by line, as before", (_name, open, close) => {
    const body = `${open}\n\n${video}\n\n${close}`;
    expect(split(body)).toEqual([
      { id: "markdown:0", kind: "markdown", text: open, sourceOffset: 0 },
      { id: "attachment:1", kind: "attachment", url: video, media: "video" },
      ...(close
        ? [
            {
              id: "markdown:2",
              kind: "markdown",
              text: close,
              sourceOffset: body.length - close.length,
            },
          ]
        : []),
    ]);
  });
});

describe("change request reference autolinks", () => {
  const urls = (provider: string, url: string, text: string) =>
    changeRequestReferenceAutolinker({ provider, url })?.(text).map((link) => link.url) ?? null;

  it("links references against the change request's own repository", () => {
    expect(urls("github", "https://ghe.example.com/acme/web/pull/7", "Fixes #5")).toEqual([
      "https://ghe.example.com/acme/web/issues/5",
    ]);
  });

  // regression: the mobile review guide linked every host's `#5` with GitHub's grammar
  it("links nothing on a host whose grammar is not applied", () => {
    expect(urls("forgejo", "https://codeberg.org/acme/web/pulls/7", "#5")).toBeNull();
  });
});

describe("change request media urls", () => {
  // regression: GitCafe's `/api/attachments/<id>` uploads rendered as missing local files
  it.each([
    ["/api/attachments/attach_1", "https://git.cafe/api/attachments/attach_1"],
    ["//cdn.example.com/a.png", "//cdn.example.com/a.png"],
    ["/\\evil.example.com/a.png", "/\\evil.example.com/a.png"],
    ["https://example.com/a.png", "https://example.com/a.png"],
    ["docs/a.png", "docs/a.png"],
  ])("resolves %s against the forge", (url, expected) => {
    expect(resolveChangeRequestMediaUrl(url, "https://git.cafe/pingdotgg/t3code/pulls/31251")).toBe(
      expected,
    );
  });
});
