import JSZip from "jszip";
import { openRtf, openNotebook, openDocument, openEpub } from "./extendedDocumentPreview";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ProjectReadFileError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import { remapFileCommentAnnotations } from "./fileCommentAnnotations";
import {
  filePreviewReadErrorMessage,
  isMarkdownPreviewFile,
  resolveFilePreviewPath,
  setMarkdownTaskChecked,
  shouldShowFileExplorer,
  workspaceAssetResource,
} from "./filePreviewMode";

const decodeReadError = Schema.decodeSync(ProjectReadFileError);

describe("file preview read errors", () => {
  // regression: #15628 read errors from servers without attempted paths keep their own message
  it("preserves the public message from older servers", () => {
    const error = decodeReadError({
      _tag: "ProjectReadFileError",
      message: "Legacy file read failure.",
    });
    expect(filePreviewReadErrorMessage(error)).toBe("Legacy file read failure.");
  });
});

describe("file comment annotations", () => {
  it("keeps an annotation range attached when Pierre remaps its anchor line", () => {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 7,
                endLine: 16,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: "comment-1",
              kind: "comment",
              startLine: 11,
              endLine: 20,
              text: "Keep this guarded.",
            },
          ],
        },
      },
    ]);
  });
});

describe("isMarkdownPreviewFile", () => {
  it("recognizes markdown and MDX files case-insensitively", () => {
    expect(isMarkdownPreviewFile("README.md")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.MDX")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.MARKDOWN")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.mdown")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.mkd")).toBe(true);
  });
});

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });
});

describe("resolveFilePreviewPath", () => {
  it.each([
    ["/repo/project", null],
    ["/repo/project/", null],
    [".", null],
    [null, null],
    ["/repo/project/src", "/repo/project/src"],
    ["/repo/project/src/main.ts", "/repo/project/src/main.ts"],
    ["src/main.ts", "src/main.ts"],
    ["/repo/project-other", "/repo/project-other"],
  ])("opens %s in the appropriate workspace surface", (path, expected) => {
    const relativePath = resolveFilePreviewPath(path, "/repo/project");
    expect(relativePath).toBe(expected);
    if (expected === null) {
      expect(
        shouldShowFileExplorer({ relativePath, explorerOpen: false, attachmentOpen: false }),
      ).toBe(true);
    }
  });
});

describe("workspaceAssetResource", () => {
  const input = {
    kind: "workspace-file" as const,
    threadRef: {
      environmentId: "env" as ScopedThreadRef["environmentId"],
      threadId: "thread-1" as ScopedThreadRef["threadId"],
    },
    workspaceRoot: "/repo",
    absolutePath: "/repo/docs/index.html",
  };

  // regression: #21067 images outside the workspace load through the host media resource
  it("serves a file outside the workspace as host media and keeps workspace files on workspace access", () => {
    expect(
      workspaceAssetResource({ ...input, absolutePath: "/tmp/screenshots/shot.png", draft: false }),
    ).toEqual({ _tag: "media-file", threadId: "thread-1", path: "/tmp/screenshots/shot.png" });
    expect(workspaceAssetResource({ ...input, draft: false })).toEqual({
      _tag: "workspace-file",
      threadId: "thread-1",
      path: "/repo/docs/index.html",
    });
  });

  it("names the workspace root for a draft, which the server cannot resolve from a thread", () => {
    expect(workspaceAssetResource({ ...input, draft: true })).toEqual({
      _tag: "draft-workspace-file",
      cwd: "/repo",
      path: "/repo/docs/index.html",
    });
    expect(
      workspaceAssetResource({ ...input, absolutePath: "/tmp/screenshots/shot.png", draft: true }),
    ).toEqual({ _tag: "draft-workspace-file", cwd: "/repo", path: "/tmp/screenshots/shot.png" });
  });
});

describe("document preview contents", () => {
  const bytes = (text: string) => new TextEncoder().encode(text).buffer;

  it.each(["?", String.raw`\'3f`, String.raw`\\`])(
    "consumes skipped rich text Unicode fallback %s",
    (fallback) => {
      const result = openRtf(bytes(String.raw`{\rtf1{\*\unknown\u945` + fallback + "}Hello}"));
      if (result.type !== "document") throw new Error("Expected document");
      expect(result.pages[0]!.html).toBe("<p>Hello</p>");
    },
  );

  it("bounds EPUB markup made entirely of empty allowed elements", async () => {
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      )
      .file(
        "book.opf",
        '<package><manifest><item id="a" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine>' +
          '<itemref idref="a"/>'.repeat(30) +
          "</spine></package>",
      )
      .file("chapter.xhtml", "<html><body>" + "<figcaption/>".repeat(30_000) + "</body></html>");
    await expect(openEpub(archive)).rejects.toThrow("too large");
  });

  it("decodes rich text formatting and Unicode without showing hidden destinations", () => {
    const result = openRtf(
      bytes(
        String.raw`{\rtf1\ansi{\fonttbl{\f0 Hidden font;}}Hello \b bold\b0\par Unicode: \u945?{\*\unknown hidden}{\field{\*\fldinst HYPERLINK "https://example.com"}{\fldrslt visible}}}`,
      ),
    );
    expect(result.type).toBe("document");
    if (result.type !== "document") throw new Error("Expected document");
    const html = result.pages[0]!.html;
    expect(html.replaceAll(/<[^>]*>/g, "")).toBe("Hello boldUnicode: αvisible");
    expect(html).toContain("<strong>");
    expect(html).not.toContain("https:");
  });

  it("preserves rich text page breaks and formatting without splitting hidden destinations", () => {
    const result = openRtf(
      bytes(String.raw`{\rtf1\b First\page Second\b0{\*\unknown \page hidden}\page Third\page}`),
    );
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.navigation).toBe("page");
    expect(result.pages.map((page) => page.html)).toEqual([
      "<p><strong>First</strong></p>",
      "<p><strong>Second</strong></p>",
      "<p>Third</p>",
    ]);
    expect(() => openRtf(bytes(String.raw`{\rtf1 ` + String.raw`\page`.repeat(501) + "}"))).toThrow(
      "500 pages",
    );
  });

  it("decodes declared rich text code pages for raw bytes and escaped byte runs", () => {
    const input = new TextEncoder().encode(
      String.raw`{\rtf1\ansi\ansicpg1251 A \'c0\par\ansicpg932\'82\'a0}`,
    );
    input[input.indexOf(65)] = 0xc0;
    const result = openRtf(input.buffer);
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages[0]!.html).toBe("<p>А А<br>あ</p>");
    expect(() => openRtf(bytes(String.raw`{\rtf1\ansicpg99999 text}`))).toThrow("code page");
  });

  it("resolves scoped ODF namespaces and explicit spreadsheet whitespace", async () => {
    const archive = new JSZip().file(
      "content.xml",
      '<o:document-content xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><o:body><o:spreadsheet><t:table t:name="Accounts &amp; names"><t:table-row><t:table-cell><p xmlns="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:x="urn:oasis:names:tc:opendocument:xmlns:text:1.0">Account<s/>Name<s x:c="3"/>A<tab/>B<line-break/>C</p></t:table-cell></t:table-row></t:table></o:spreadsheet></o:body></o:document-content>',
    );
    const result = await openDocument(archive, "ods");
    if (result.type !== "ods") throw new Error("Expected workbook");
    expect(result.sheets[0]!.name).toBe("Accounts & names");
    expect(result.sheets[0]!.rows[0]).toEqual(["Account Name   A\tB\nC"]);
  });

  it("stops repeated slide images before encoding beyond the output budget", async () => {
    const pixels = new Uint8Array(4 * 1024 * 1024);
    pixels.set(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const archive = new JSZip()
      .file(
        "content.xml",
        '<o:document-content xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:d="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:l="http://www.w3.org/1999/xlink"><o:body>' +
          '<d:page><d:image l:href="picture.png"/></d:page>'.repeat(500) +
          "</o:body></o:document-content>",
      )
      .file("picture.png", pixels);
    const image = archive.file("picture.png")!;
    const read = vi.spyOn(image, "async");
    await expect(openDocument(archive, "odp")).rejects.toThrow("too large");
    expect(read.mock.calls.filter(([type]) => type === "base64")).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("reads saved notebook cells and preferred outputs without executing code", () => {
    const result = openNotebook(
      bytes(
        JSON.stringify({
          nbformat: 4,
          metadata: { language_info: { name: "python" } },
          cells: [
            { cell_type: "markdown", source: ["# Results"] },
            {
              cell_type: "code",
              source: ["print(42)"],
              outputs: [
                { output_type: "stream", text: ["\n  "] },
                { output_type: "display_data", data: {} },
                { data: { "text/html": [""] } },
                { data: { "text/html": [], "text/plain": "array fallback" } },
                { data: { "text/html": "", "text/plain": "string fallback" } },
                { data: { "text/html": "  ", "text/plain": "space fallback" } },
                { output_type: "stream", text: ["42\n"] },
                { data: { "text/html": ["<b>Results</b>"], "text/plain": ["Results"] } },
              ],
            },
          ],
        }),
      ),
    );
    expect(result).toEqual({
      type: "notebook",
      language: "python",
      cells: [
        { kind: "markdown", source: "# Results", outputs: [] },
        {
          kind: "code",
          source: "print(42)",
          outputs: [
            { kind: "text", text: "array fallback" },
            { kind: "text", text: "string fallback" },
            { kind: "text", text: "space fallback" },
            { kind: "text", text: "42\n" },
            { kind: "html", text: "<b>Results</b>" },
          ],
        },
      ],
    });
    expect(() => openNotebook(bytes('{"nbformat":3,"cells":[]}'))).toThrow("version 4");
    expect(() =>
      openNotebook(
        bytes(JSON.stringify({ nbformat: 4, cells: Array.from({ length: 501 }, () => ({})) })),
      ),
    ).toThrow("500 cells");
  });

  it("bounds repeated OpenDocument spreadsheet cells and keeps sheet names and values", async () => {
    const archive = new JSZip().file(
      "content.xml",
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Budget"><table:table-row table:number-rows-repeated="999999999"><table:table-cell table:number-columns-repeated="999999999"><text:p>Research &amp; design</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>',
    );
    const result = await openDocument(archive, "ods");
    expect(result.type).toBe("ods");
    if (result.type !== "ods") throw new Error("Expected workbook");
    expect(result.sheets[0]!.name).toBe("Budget");
    expect(result.sheets[0]!.truncated).toBe(true);
    expect(result.sheets[0]!.rows).toHaveLength(500);
    expect(result.sheets[0]!.rows[0]).toHaveLength(50);
    expect(result.sheets[0]!.rows[0]![0]).toBe("Research & design");
  });

  it.each([1, 500])("ignores styled ODS filler after %s populated rows", async (count) => {
    const archive = new JSZip().file(
      "content.xml",
      `<office:document><table:table><table:table-row table:number-rows-repeated="${count}"><table:table-cell><text:p>North</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1024"/></table:table-row><table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row></table:table></office:document>`,
    );
    const result = await openDocument(archive, "ods");
    if (result.type !== "ods") throw new Error("Expected workbook");
    expect(result.sheets[0]).toMatchObject({ rowCount: count, columns: 1, truncated: false });
    expect(result.sheets[0]!.rows).toEqual(Array.from({ length: count }, () => ["North"]));
  });

  it.each([2, 999999])(
    "preserves internal ODS gaps of %s rows and reports real overflow",
    async (gap) => {
      const archive = new JSZip().file(
        "content.xml",
        `<office:document><table:table><table:table-row><table:table-cell><text:p>First</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="${gap}"><table:table-cell/></table:table-row><table:table-row><table:table-cell table:number-columns-repeated="2"/><table:table-cell><text:p>Last</text:p></table:table-cell></table:table-row></table:table></office:document>`,
      );
      const result = await openDocument(archive, "ods");
      if (result.type !== "ods") throw new Error("Expected workbook");
      expect(result.sheets[0]).toMatchObject({
        rowCount: Math.min(gap + 2, 500),
        columns: gap === 2 ? 3 : 1,
        truncated: gap !== 2,
      });
      expect(result.sheets[0]!.rows[1]).toEqual([]);
      if (gap === 2) expect(result.sheets[0]!.rows[3]).toEqual(["", "", "Last"]);
    },
  );

  it.each(["odt", "odp"] as const)("reads %s text and rejects XML entities", async (kind) => {
    const archive = new JSZip().file(
      "content.xml",
      `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body>${kind === "odt" ? "<office:text><text:p>Field notes</text:p></office:text>" : '<draw:page draw:name="Overview"><text:h>Launch plan</text:h></draw:page>'}</office:body></office:document-content>`,
    );
    const result = await openDocument(archive, kind);
    expect(result.type).toBe("document");
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages[0]!.html).toContain(kind === "odt" ? "Field notes" : "Launch plan");
    archive.file(
      "content.xml",
      '<!DOCTYPE x [<!ENTITY external SYSTEM "file:///etc/passwd">]><x>&external;</x>',
    );
    await expect(openDocument(archive, kind)).rejects.toThrow("unsupported XML");
  });

  it("reads EPUB chapters in spine order and removes active and remote content", async () => {
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="Book/book.opf"/></rootfiles></container>',
      )
      .file(
        "Book/book.opf",
        '<package><manifest><item id="a" href="one.xhtml" media-type="application/xhtml+xml"/><item id="b" href="two&amp;&#x26;&#38;.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>',
      )
      .file(
        "Book/one.xhtml",
        '<html><head><title>First</title></head><body><h1>First chapter</h1><img src="cover.png" alt="Cover"/><img src="https://example.com/tracker.png"/><script>alert(1)</script><style>@import "https://example.com/style.css";</style></body></html>',
      )
      .file(
        "Book/two&&&.xhtml",
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><head><title>Second</title></head><body><h1>Second chapter</h1><p>A&nbsp;B &copy; &mdash; &NotEqualTilde; &amp;lt;</p><img src="cover.png" alt="&copy; &NotEqualTilde;"/></body></html>',
      )
      .file(
        "Book/cover.png",
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
    const result = await openEpub(archive);
    expect(result.type).toBe("document");
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages.map((page) => page.title)).toEqual(["Second", "First"]);
    expect(result.pages[0]!.html).toContain("A\u00a0B © — ≂̸ &amp;lt;");
    expect(result.pages[0]!.html).toContain('alt="© ≂̸"');
    expect(result.pages[1]!.html).toContain('src="data:image/png;base64,');
    expect(result.pages[1]!.html).not.toMatch(/https:|script|alert/);
  });
});
