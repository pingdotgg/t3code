import JSZip from "jszip";
import { openRtf, openNotebook, openDocument } from "./extendedDocumentPreview";
import { openEpub } from "./epubPreview";
import { parseXml } from "./documentPreviewXml";
import { unlockOpenDocument } from "./openDocumentEncryption";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ProjectReadFileError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import { promptFileCommentEntries, remapFileCommentAnnotations } from "./fileCommentAnnotations";
import {
  filePreviewReadErrorMessage,
  isMarkdownPreviewFile,
  resolveFilePreviewPath,
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

  it("shows only drafts and comments still in the prompt", () => {
    const entry = (id: string, kind: "draft" | "comment") => ({
      id,
      kind,
      startLine: 3,
      endLine: 3,
      text: "",
    });
    expect(
      promptFileCommentEntries(
        [entry("sent", "comment"), entry("new", "draft"), entry("kept", "comment")],
        new Set(["kept"]),
      ),
    ).toEqual([entry("new", "draft"), entry("kept", "comment")]);
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

  it.each([
    ["control symbols", String.raw`{\rtf1 Jean\_Luc\-X\~Y}`, "Jean\u2011Luc\u00adX\u00a0Y"],
    [
      "named spaces, joiners and direction marks",
      String.raw`{\rtf1 A\tab B\emspace C\enspace D\qmspace E\zwj F\zwnj G\zwbo H\ltrmark I\rtlmark J}`,
      "A\tB\u2003C\u2002D\u2005E\u200dF\u200cG\u200bH\u200eI\u200fJ",
    ],
    ["a Unicode fallback", String.raw`{\rtf1 Jean\u8209\_Luc}`, "Jean\u2011Luc"],
    [
      "visible text around hidden character formatting",
      String.raw`{\rtf1 A{\v hidden{\v0 B}hidden}C\v hidden\v0 D\v hidden\plain E}`,
      "ABCDE",
    ],
    ["a tracked replacement", String.raw`{\rtf1 aaa{\deleted bbb}{\revised BBB}ccc}`, "aaaBBBccc"],
    [
      "text after a deletion reset",
      String.raw`{\rtf1 A\deleted old\deleted0 B\deleted old\plain C}`,
      "ABC",
    ],
    [
      "text around a deleted Unicode span",
      String.raw`{\rtf1 A{\deleted\uc1\u945\deleted0 old}B}`,
      "AB",
    ],
    [
      "nested table cells",
      String.raw`{\rtf1\ansi\trowd\cellx3000\pard\intbl\itap2 Inner A\nestcell\pard\intbl\itap2 Inner B\nestcell{\*\nesttableprops\trowd\cellx1500\cellx3000\nestrow}\pard\intbl\itap1\cell\row}`,
      "Inner A\tInner B\t\t",
    ],
  ])("keeps the text of %s", (_name, source, expected) => {
    const result = openRtf(bytes(source));
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages[0]!.html.replaceAll(/<[^>]*>/g, "")).toBe(expected);
  });

  it.each(["?", String.raw`\'3f`, String.raw`\\`])(
    "consumes skipped rich text Unicode fallback %s",
    (fallback) => {
      const result = openRtf(bytes(String.raw`{\rtf1{\*\unknown\u945` + fallback + "}Hello}"));
      if (result.type !== "document") throw new Error("Expected document");
      expect(result.pages[0]!.html).toBe("<p data-rtf-whitespace>Hello</p>");
    },
  );

  it("reads EPUB chapters independently of the total rendered size", async () => {
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
    const book = await openEpub(archive);
    expect(book.chapters).toHaveLength(30);
    expect((await book.page(29)).html).toBe("<figcaption></figcaption>".repeat(30_000));
  });

  it("skips broken EPUB encryption metadata and reports declared DRM", async () => {
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      )
      .file(
        "book.opf",
        '<package><manifest><item id="a" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>',
      )
      .file("chapter.xhtml", "<html><body><p>Hello</p></body></html>");
    const namespace = 'xmlns="http://www.w3.org/2001/04/xmlenc#"';
    for (const metadata of ["<encryption>", `<EncryptedData ${namespace}/>`]) {
      archive.file("META-INF/encryption.xml", metadata);
      expect((await (await openEpub(archive)).page(0)).html).toBe("<p>Hello</p>");
    }
    archive.file(
      "META-INF/encryption.xml",
      `<EncryptedData ${namespace}><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/></EncryptedData>`,
    );
    await expect(openEpub(archive)).rejects.toMatchObject({ code: "epub-drm" });
  });

  it("reports the aggregate OpenDocument decryption limit for supported encryption", async () => {
    const parts = Array.from(
      { length: 3 },
      (_, index) => `<m:file-entry m:full-path="part-${index}.xml" m:size="1">
        <m:encryption-data m:checksum-type="SHA1/1K" m:checksum="AA==">
          <m:algorithm m:algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" m:initialisation-vector="AA=="/>
          <m:key-derivation m:key-derivation-name="PBKDF2" m:iteration-count="1000000" m:salt="AA=="/>
        </m:encryption-data>
      </m:file-entry>`,
    );
    const archive = new JSZip().file(
      "META-INF/manifest.xml",
      `<m:manifest xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">${parts.join("")}</m:manifest>`,
    );
    await expect(unlockOpenDocument(archive, "open me")).rejects.toMatchObject({
      code: "office-decryption-limit",
    });
  });

  it("decodes rich text formatting and Unicode without showing hidden destinations", () => {
    const result = openRtf(
      bytes(
        String.raw`{\rtf1\ansi{\fonttbl{\f0 Hidden font;}}Hello \b bold\b0\par Unicode: \u945?{\*\unknown hidden\_\emspace\zwj}{\field{\*\fldinst HYPERLINK "https://example.com"}{\fldrslt visible}}}`,
      ),
    );
    expect(result.type).toBe("document");
    if (result.type !== "document") throw new Error("Expected document");
    const html = result.pages[0]!.html;
    expect(html.replaceAll(/<[^>]*>/g, "")).toBe("Hello boldUnicode: αvisible");
    expect(html).toContain("<strong>");
    expect(html).not.toContain("https:");
    const styled = openRtf(
      bytes(
        "{\\rtf1\\ansi\\b \\uc0\\u55357 \\u56960  Launch\\b0  \\i\\uc1\\u-10187?\\u-8904?\\i0}",
      ),
    );
    if (styled.type !== "document") throw new Error("Expected document");
    expect(styled.pages[0]!.html).toBe(
      "<p data-rtf-whitespace><strong>🚀 Launch</strong> <em>𝔸</em></p>",
    );
    const fallbacks = openRtf(bytes("{\\rtf1\\b\\uc1\\u-10179\\_\\uc0\\u-8576 }"));
    if (fallbacks.type !== "document") throw new Error("Expected document");
    expect(fallbacks.pages[0]!.html).toBe("<p data-rtf-whitespace><strong>🚀</strong></p>");
    const escapedBreak = openRtf(bytes("{\\rtf1\\b A\\u66\\\nC\\par D}"));
    if (escapedBreak.type !== "document") throw new Error("Expected document");
    expect(escapedBreak.pages[0]!.html).toBe(
      "<p data-rtf-whitespace><strong>ABC</strong><br><strong>D</strong></p>",
    );
    const underlines = openRtf(
      bytes(
        String.raw`{\rtf1\ansi{\ul single} {\uldb double\uldb0  plain} {\ulw words} {\uld dotted} {\ulwave wave} {\ulc1 color}}`,
      ),
    );
    if (underlines.type !== "document") throw new Error("Expected document");
    expect(underlines.pages[0]!.html).toBe(
      "<p data-rtf-whitespace><u>single</u> <u>double</u> plain <u>words</u> <u>dotted</u> <u>wave</u> color</p>",
    );
  });

  it("breaks lines at the paragraph and line breaks TextEdit writes", () => {
    const html = (rtf: string) => {
      const result = openRtf(bytes(rtf));
      if (result.type !== "document") throw new Error("Expected document");
      return result.pages.map((page) => page.html);
    };
    const textEdit = String.raw`{\rtf1\ansi{\fonttbl\f0\fswiss Helvetica;}
\pard\f0\fs24 \cf0 First\
Second\
\
Third}`;
    const expected = html(
      String.raw`{\rtf1\ansi{\fonttbl\f0\fswiss Helvetica;}\pard\f0\fs24 \cf0 First\par Second\par \par Third}`,
    );
    expect(html(textEdit)).toEqual(expected);
    expect(html(textEdit.replaceAll("\n", "\r\n"))).toEqual(expected);
    const lineBreak = html(String.raw`{\rtf1\ansi First line\line Second line}`);
    expect(lineBreak).toEqual(["<p data-rtf-whitespace>First line<br>Second line</p>"]);
    expect(html(String.raw`{\rtf1\ansi{\v\line\line\line}First line\line Second line}`)).toEqual(
      lineBreak,
    );
    expect(html(String.raw`{\rtf1\ansi First line\uc0\u8232 Second line}`)).toEqual(lineBreak);
    expect(html(String.raw`{\rtf1\ansi First line\u8232?Second line{\deleted\u8232?}}`)).toEqual(
      lineBreak,
    );
  });

  it.each([
    ["LibreOffice", ""],
    // Word adds a drawing that repeats the box for older readers.
    [
      "Word",
      String.raw`{\shprslt{\*\do\dobxcolumn{\dptxbx{\dptxbxtext\pard Trucks leave at noon\par}}}}`,
    ],
    ["a plain fallback", String.raw`{\shprslt\pard Trucks leave at noon\par}`],
  ])("shows the text of a %s rich text box once, without shape properties", (_writer, result) => {
    const html = openRtf(
      bytes(
        String.raw`{\rtf1\ansi Before\par{\shp{\*\shpinst\shpleft0{\sp{\sn shapeType}{\sv 202}}{\shptxt\pard Trucks leave at noon\par}}` +
          result +
          String.raw`}After\par}`,
      ),
    );
    if (html.type !== "document") throw new Error("Expected document");
    expect(html.pages[0]!.html).toBe(
      "<p data-rtf-whitespace>Before<br>Trucks leave at noon<br>After<br></p>",
    );
  });

  it("preserves rich text page breaks and formatting without splitting hidden destinations", () => {
    const result = openRtf(
      bytes(String.raw`{\rtf1\b First\page Second\b0{\*\unknown \page hidden}\page Third\page}`),
    );
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.navigation).toBe("page");
    expect(result.pages.map((page) => page.html)).toEqual([
      "<p data-rtf-whitespace><strong>First</strong></p>",
      "<p data-rtf-whitespace><strong>Second</strong></p>",
      "<p data-rtf-whitespace>Third</p>",
    ]);
    expect(() => openRtf(bytes(String.raw`{\rtf1 ` + String.raw`\page`.repeat(501) + "}"))).toThrow(
      expect.objectContaining({ code: "rtf-too-many-pages" }),
    );
  });

  it("starts a new line at rich text section and column breaks", () => {
    const result = openRtf(
      bytes(
        String.raw`{\rtf1\ansi\sectd\cols2\pard North quota: 120\column South quota: 240\page East quota: 360\sect\sectd\pard West quota: 480\par}`,
      ),
    );
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages.map((page) => page.html)).toEqual([
      "<p data-rtf-whitespace>North quota: 120<br>South quota: 240</p>",
      "<p data-rtf-whitespace>East quota: 360<br>West quota: 480<br></p>",
    ]);
    const written = openRtf(
      bytes(String.raw`{\rtf1\ansi First\par\sect\sectd Second\par\column Third\page\sect Fourth}`),
    );
    if (written.type !== "document") throw new Error("Expected document");
    expect(written.pages.map((page) => page.html)).toEqual([
      "<p data-rtf-whitespace>First<br>Second<br>Third</p>",
      "<p data-rtf-whitespace>Fourth</p>",
    ]);
  });

  it("decodes declared rich text code pages for raw bytes and escaped byte runs", () => {
    const input = new TextEncoder().encode(
      String.raw`{\rtf1\ansi\ansicpg1251 A \'c0\par\ansicpg932\'82\'a0}`,
    );
    input[input.indexOf(65)] = 0xc0;
    const result = openRtf(input.buffer);
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages[0]!.html).toBe("<p data-rtf-whitespace>А А<br>あ</p>");
    for (const header of [String.raw`\mac`, String.raw`\mac\ansicpg10000`]) {
      const mac = openRtf(bytes(String.raw`{\rtf1` + header + String.raw` Caf\'8e Cr\'8fme}`));
      if (mac.type !== "document") throw new Error("Expected document");
      expect(mac.pages[0]!.html).toBe("<p data-rtf-whitespace>Café Crème</p>");
    }
    for (const [rtf, expected] of [
      [String.raw`{\rtf1\ansi\ansicpg0 Caf\'e9}`, "<p data-rtf-whitespace>Café</p>"],
      [
        String.raw`{\rtf1\ansi\ansicpg866 \'8f\'e0\'a8\'a2\'a5\'e2}`,
        "<p data-rtf-whitespace>Привет</p>",
      ],
      [
        String.raw`{\rtf1\ansi\ansicpg1251{\fonttbl\f0\froman\fcharset0 Times-Roman;}\f0 \'805 caf\'e9}`,
        "<p data-rtf-whitespace>€5 café</p>",
      ],
      [
        String.raw`{\rtf1\mac\ansicpg10000{\fonttbl\f0\fnil\fcharset0 LucidaGrande;}\f0 pridr\'9eana}`,
        "<p data-rtf-whitespace>pridržana</p>",
      ],
      [
        String.raw`{\rtf1\ansi\ansicpg1251{\fonttbl{\f0\fnil\fcharset0\cpg1251 Arial;}{\f1\fnil\fcharset204 Arial{\*\fontfile\cpg1252 arial.ttf};}}\f0 \'cf\'f0\'e8\f1\'e2\'e5\'f2}`,
        "<p data-rtf-whitespace>Привет</p>",
      ],
      [
        String.raw`{\rtf1\ansi\ansicpg54936 Quarterly notes: \'d6\'d0\'ce\'c4 \'95\'32\'82\'36 \'82\'35\'8f\'33 \uc2\u20320\'c4\'e3 done\par}`,
        "<p data-rtf-whitespace>Quarterly notes: 中文 𠀀 龦 你 done<br></p>",
      ],
      [
        String.raw`{\rtf1\ansi{\fonttbl{\f0\fnil\fcharset0\cpg54936 SimSun;}}\f0 \'d6\'d0\'ce\'c4}`,
        "<p data-rtf-whitespace>中文</p>",
      ],
    ] as const) {
      const decoded = openRtf(bytes(rtf));
      if (decoded.type !== "document") throw new Error("Expected document");
      expect(decoded.pages[0]!.html).toBe(expected);
    }
    expect(() => openRtf(bytes(String.raw`{\rtf1\ansicpg99999 text}`))).toThrow(
      expect.objectContaining({ code: "rtf-code-page" }),
    );
  });

  it("resolves scoped ODF namespaces and explicit spreadsheet whitespace", async () => {
    const archive = new JSZip().file(
      "content.xml",
      '<o:document-content xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><o:body><o:spreadsheet><t:table t:name="Accounts &amp; names"><t:table-row><t:table-cell><p xmlns="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:x="urn:oasis:names:tc:opendocument:xmlns:text:1.0">Account<s/>Name<s x:c="3"/>A<tab/>B<line-break/>C &amp; <![CDATA[&amp;]]></p></t:table-cell></t:table-row></t:table></o:spreadsheet></o:body></o:document-content>',
    );
    const result = await openDocument(archive, "ods");
    if (result.type !== "ods") throw new Error("Expected workbook");
    expect(result.sheets[0]!.name).toBe("Accounts & names");
    expect(result.sheets[0]!.rows[0]).toEqual(["Account Name   A\tB\nC & &amp;"]);
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
    await expect(openDocument(archive, "odp")).rejects.toMatchObject({
      code: "rendered-too-large",
    });
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
                { data: { "text/html": "", "text/plain": "\u001b[1mstring fallback\u001b[0m" } },
                { data: { "text/html": "  ", "text/plain": "space fallback" } },
                { output_type: "stream", text: ["\u001b[", "32m42\u001b[0m\n"] },
                {
                  output_type: "stream",
                  name: "stderr",
                  text: ["\r 10%|#         |", "\r100%|##########|\n", "done\r\n", "🚀 ready\rX\n"],
                },
                { data: { "text/html": ["<b>Results</b>"], "text/plain": ["Results"] } },
                { output_type: "display_data", data: { "text/markdown": ["| a |\n", "|---|"] } },
                { data: { "text/plain": "plain wins", "text/markdown": "**markdown**" } },
                { output_type: "stream", name: "stdout", text: "Status: 10%" },
                { output_type: "stream", name: "stdout", text: ["\r", "Status: Done\n"] },
                { output_type: "stream", name: "stderr", text: "\rDiagnostic" },
                { output_type: "stream", name: "stdout", text: "Keep this" },
                { output_type: "display_data", data: { "text/plain": "Saved result" } },
                { output_type: "stream", name: "stdout", text: "\rNext" },
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
            { kind: "text", text: "100%|##########|\ndone\nX  ready\n" },
            { kind: "html", text: "<b>Results</b>" },
            { kind: "text", text: "| a |\n|---|" },
            { kind: "text", text: "plain wins" },
            { kind: "text", text: "Status: Done\n" },
            { kind: "text", text: "Diagnostic" },
            { kind: "text", text: "Keep this" },
            { kind: "text", text: "Saved result" },
            { kind: "text", text: "Next" },
          ],
        },
      ],
    });
    for (const name of ["", "Питон"]) {
      const blank = { nbformat: 4, metadata: { language_info: { name } }, cells: [] };
      expect(openNotebook(bytes(JSON.stringify(blank)))).toMatchObject({ language: "text" });
    }
    const kernelspec = { name: "python3", display_name: "Python 3", language: "python" };
    for (const [metadata, language] of [
      [{ kernelspec }, "python"],
      [{ language_info: { name: "" }, kernelspec }, "python"],
      [{ language_info: { name: "python" }, kernelspec: { language: "r" } }, "python"],
    ] as const) {
      expect(
        openNotebook(bytes(JSON.stringify({ nbformat: 4, metadata, cells: [] }))),
      ).toMatchObject({ language });
    }
    // IPython traceback frames can omit trailing newlines or place ANSI resets after them.
    const failed = openNotebook(
      bytes(
        JSON.stringify({
          nbformat: 4,
          cells: [
            {
              cell_type: "code",
              source: "fail()",
              outputs: [
                {
                  output_type: "error",
                  traceback: [
                    "-----",
                    "ValueError    Traceback (most recent call last)",
                    "Cell In[1], line 4\n----> 4 fail()\n",
                    "Cell In[1], line 2, in fail()\n----> 2     raise ValueError()\n",
                    "ValueError: preview proof",
                  ],
                },
                {
                  output_type: "error",
                  traceback: [
                    "Traceback (most recent call last):\n",
                    "  Cell In[2], line 5\n    fail()\n",
                    "ValueError: preview proof\n",
                  ],
                },
                {
                  output_type: "error",
                  traceback: [
                    "\u001b[31mTraceback (most recent call last):\n\u001b[0m",
                    "\u001b[38:2::255:0:0mCell In[3], line 1\n----> 1 fail()\n\u001b[0m\u001b[39m",
                    "\u001b[31mValueError: preview proof\u001b[0m",
                    "final entry",
                  ],
                },
                {
                  output_type: "error",
                  ename: "ZeroDivisionError",
                  evalue: "division by zero",
                  traceback: [],
                },
                {
                  output_type: "error",
                  evalue: "\u001b[31mbad input\u001b[0m",
                  traceback: [],
                },
                {
                  output_type: "error",
                  ename: "RuntimeError",
                  evalue: "kernel reset",
                  traceback: ["\u001b[31m\u001b[0m", "  \n"],
                },
              ],
            },
          ],
        }),
      ),
    );
    if (failed.type !== "notebook") throw new Error("Expected notebook");
    expect(failed.cells[0]!.outputs).toEqual([
      {
        kind: "text",
        text: "-----\nValueError    Traceback (most recent call last)\nCell In[1], line 4\n----> 4 fail()\nCell In[1], line 2, in fail()\n----> 2     raise ValueError()\nValueError: preview proof",
      },
      {
        kind: "text",
        text: "Traceback (most recent call last):\n  Cell In[2], line 5\n    fail()\nValueError: preview proof\n",
      },
      {
        kind: "text",
        text: "Traceback (most recent call last):\nCell In[3], line 1\n----> 1 fail()\nValueError: preview proof\nfinal entry",
      },
      { kind: "text", text: "ZeroDivisionError: division by zero" },
      { kind: "text", text: "bad input" },
      { kind: "text", text: "RuntimeError: kernel reset" },
    ]);
    expect(() => openNotebook(bytes('{"nbformat":3,"cells":[]}'))).toThrow(
      expect.objectContaining({ code: "notebook-unsupported" }),
    );
    expect(() =>
      openNotebook(
        bytes(JSON.stringify({ nbformat: 4, cells: Array.from({ length: 501 }, () => ({})) })),
      ),
    ).toThrow(expect.objectContaining({ code: "notebook-unsupported" }));
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

  it("hides ODS values kept in cells a merge covers", async () => {
    const archive = new JSZip().file(
      "content.xml",
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Merged">' +
        '<table:table-row><table:table-cell table:number-columns-spanned="4" table:number-rows-spanned="2"><text:p>Total</text:p></table:table-cell><table:covered-table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:covered-table-cell><table:covered-table-cell table:number-columns-repeated="2"/><table:table-cell><text:p>Lead</text:p></table:table-cell></table:table-row>' +
        '<table:table-row><table:covered-table-cell office:value-type="string" office:string-value="Below"/><table:covered-table-cell table:number-columns-repeated="3"/><table:table-cell><text:p>Q2</text:p></table:table-cell></table:table-row>' +
        "</table:table></office:spreadsheet></office:body></office:document-content>",
    );
    const result = await openDocument(archive, "ods");
    if (result.type !== "ods") throw new Error("Expected workbook");
    expect(result.sheets[0]!.rows).toEqual([
      ["Total", "", "", "", "Lead"],
      ["", "", "", "", "Q2"],
    ]);
  });

  it("reads an ODS time cell that has no display paragraph", async () => {
    const archive = new JSZip().file(
      "content.xml",
      `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:spreadsheet><table:table table:name="Values"><table:table-row><table:table-cell office:value-type="time" office:time-value="PT03H30M00S"></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
    );
    const result = await openDocument(archive, "ods");
    if (result.type !== "ods") throw new Error("Expected workbook");
    expect(result.sheets[0]!.rows).toEqual([["PT03H30M00S"]]);
  });

  it("reports zero columns for an empty ODS sheet", async () => {
    const archive = new JSZip().file(
      "content.xml",
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet>' +
        '<table:table table:name="Empty"><table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="1024"/></table:table-row></table:table>' +
        '<table:table table:name="Data"><table:table-row><table:table-cell><text:p>A</text:p></table:table-cell><table:table-cell><text:p>B</text:p></table:table-cell><table:table-cell><text:p>C</text:p></table:table-cell></table:table-row></table:table>' +
        '<table:table table:name="Late"><table:table-row table:number-rows-repeated="500"><table:table-cell/></table:table-row><table:table-row><table:table-cell><text:p>Z</text:p></table:table-cell></table:table-row></table:table>' +
        "</office:spreadsheet></office:body></office:document-content>",
    );
    const result = await openDocument(archive, "ods");
    if (result.type !== "ods") throw new Error("Expected workbook");
    expect(result.sheets[0]).toMatchObject({ rowCount: 0, columns: 0 });
    expect(result.sheets[1]).toMatchObject({ rowCount: 1, columns: 3 });
    expect(result.sheets[2]).toMatchObject({ rowCount: 500, columns: 1, truncated: true });
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

  const approved = "<text:p>Approved <text:span>now</text:span></text:p>";
  const approvedRow = `<tr>${"<td><p>Approved <span>now</span></p></td>".repeat(2)}</tr>`;
  it.each([
    [
      "expands",
      `<table:table-row>${`<table:table-cell>${approved}</table:table-cell>`.repeat(2)}</table:table-row><table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2">${approved}</table:table-cell></table:table-row>`,
      approvedRow.repeat(3),
    ],
    [
      "bounds",
      '<table:table-row table:number-rows-repeated="999999999"><table:table-cell table:number-columns-repeated="999999999"><text:p>x</text:p></table:table-cell></table:table-row>',
      `<tr>${"<td><p>x</p></td>".repeat(50)}</tr>`.repeat(500),
    ],
  ])("%s repeated ODT table rows and cells", async (_, rows, html) => {
    const archive = new JSZip().file(
      "content.xml",
      `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><table:table><table:table-column table:number-columns-repeated="2"/>${rows}</table:table></office:text></office:body></office:document-content>`,
    );
    const result = await openDocument(archive, "odt");
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages[0]!.html).toBe(`<table>${html}</table>`);
  });

  it("preserves ODT table colspan and rowspan on merged cells", async () => {
    const archive = new JSZip().file(
      "content.xml",
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><table:table><table:table-column table:number-columns-repeated="3"/>' +
        '<table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>Quarter</text:p></table:table-cell><table:covered-table-cell/><table:table-cell><text:p>Lead</text:p></table:table-cell></table:table-row>' +
        '<table:table-row><table:table-cell table:number-rows-spanned="2"><text:p>North</text:p></table:table-cell><table:table-cell><text:p>Q1</text:p></table:table-cell><table:table-cell><text:p>Lead A</text:p></table:table-cell></table:table-row>' +
        "<table:table-row><table:covered-table-cell><text:p>Hidden</text:p></table:covered-table-cell><table:table-cell><text:p>Q2</text:p></table:table-cell><table:table-cell><text:p>Lead B</text:p></table:table-cell></table:table-row>" +
        '<table:table-row><table:table-cell table:number-columns-spanned="9999" table:number-rows-spanned="0"><text:p>Total</text:p></table:table-cell><table:table-cell table:number-columns-spanned="Infinity" table:number-rows-spanned="50.5"/></table:table-row>' +
        '<table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="2"><table:table><table:table-row><table:table-cell table:number-rows-spanned="2"/></table:table-row></table:table></table:table-cell><table:table-cell table:number-columns-repeated="2" table:number-columns-spanned="2"/></table:table-row>' +
        "</table:table></office:text></office:body></office:document-content>",
    );
    const result = await openDocument(archive, "odt");
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages[0]!.html).toBe(
      `<table><tr><td colspan="2"><p>Quarter</p></td><td><p>Lead</p></td></tr><tr><td rowspan="2"><p>North</p></td><td><p>Q1</p></td><td><p>Lead A</p></td></tr><tr><td><p>Q2</p></td><td><p>Lead B</p></td></tr><tr><td colspan="50"><p>Total</p></td><td></td></tr>${'<tr><td colspan="2"><table><tr><td rowspan="2"></td></tr></table></td><td></td><td></td></tr>'.repeat(2)}</table>`,
    );
  });

  it("omits hidden ODT sections", async () => {
    const xml =
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>Visible intro.</text:p><text:section text:style-name="Sect1" text:name="Internal" text:display="none"><text:p>Internal margin 42%.</text:p></text:section><text:section text:name="Shown" text:display="true"><text:p>Shown section.</text:p></text:section><text:p>Visible end.</text:p></office:text></office:body></office:document-content>';
    const result = await openDocument(new JSZip().file("content.xml", xml), "odt");
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages[0]!.html).toBe(
      "<p>Visible intro.</p><p>Shown section.</p><p>Visible end.</p>",
    );
  });

  it("maps ODT heading outline levels to HTML heading tags", async () => {
    const xml =
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h text:outline-level="1">1</text:h><text:h text:outline-level="2">2</text:h><text:h text:outline-level="3">3</text:h><text:h text:outline-level="6">6</text:h><text:h text:outline-level="10">10</text:h><text:h text:outline-level="0">0</text:h><text:h text:outline-level="1.5">1.5</text:h><text:h text:outline-level="abc">abc</text:h><text:h>none</text:h></office:text></office:body></office:document-content>';
    const result = await openDocument(new JSZip().file("content.xml", xml), "odt");
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages[0]!.html).toBe(
      "<h1>1</h1><h2>2</h2><h3>3</h3><h6>6</h6><h6>10</h6><h2>0</h2><h2>1.5</h2><h2>abc</h2><h2>none</h2>",
    );
  });

  it("maps ODT numbered list styles to ordered lists and preserves nested levels", async () => {
    const ns =
      'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"';
    const content =
      `<office:document-content ${ns}>` +
      '<office:automatic-styles><text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="1"/><text:list-level-style-bullet text:level="2"/></text:list-style><text:list-style style:name="L2"><text:list-level-style-bullet text:level="1"/></text:list-style><text:list-style style:name="L3"><text:list-level-style-number text:level="1" style:num-format=""/><text:list-level-style-number text:level="2"/></text:list-style><text:list-style><text:list-level-style-number text:level="1" style:num-format="1"/></text:list-style></office:automatic-styles>' +
      '<office:body><office:text><text:list text:style-name="L1"><text:list-item><text:p>One</text:p><text:list><text:list-item><text:p>Sub</text:p></text:list-item></text:list></text:list-item><text:list-item><text:p><draw:frame><draw:text-box><text:list text:style-name="L1"><text:list-item><text:p>Boxed</text:p></text:list-item></text:list></draw:text-box></draw:frame></text:p></text:list-item></text:list><text:list text:style-name="L2"><text:list-item><text:p>Bullet</text:p></text:list-item></text:list><text:list text:style-name="M1"><text:list-item><text:p>Header style</text:p></text:list-item></text:list><text:list text:style-name="Numbering_20_123"><text:list-item><text:p>First</text:p><text:list><text:list-item><text:p>Nested</text:p></text:list-item></text:list></text:list-item></text:list><text:list text:style-name="Numbering_20_123"><text:list-header><text:list><text:list-item><text:p>Under header</text:p></text:list-item></text:list></text:list-header></text:list><text:list text:style-name="L3"><text:list-item><text:p>No number</text:p><text:list><text:list-item><text:p>No format</text:p></text:list-item></text:list></text:list-item></text:list><text:list><text:list-item><text:p>Plain</text:p></text:list-item></text:list></office:text></office:body></office:document-content>';
    const styles = `<office:document-styles ${ns}><office:styles><text:list-style style:name="L2"><text:list-level-style-number text:level="1" style:num-format="1"/></text:list-style><text:list-style style:name="Numbering_20_123"><text:list-level-style-number text:level="1" style:num-format="1"/><text:list-level-style-number text:level="2" style:num-format="1"/></text:list-style></office:styles><office:automatic-styles><text:list-style style:name="M1"><text:list-level-style-number text:level="1" style:num-format="1"/></text:list-style></office:automatic-styles></office:document-styles>`;
    const html = async (styles: string) => {
      const result = await openDocument(
        new JSZip().file("content.xml", content).file("styles.xml", styles),
        "odt",
      );
      if (result.type !== "document") throw new Error("Expected document");
      return result.pages[0]!.html;
    };
    expect(await html(styles)).toBe(
      "<ol><li><p>One</p><ul><li><p>Sub</p></li></ul></li><li><p><ol><li><p>Boxed</p></li></ol></p></li></ol><ul><li><p>Bullet</p></li></ul><ul><li><p>Header style</p></li></ul><ol><li><p>First</p><ol><li><p>Nested</p></li></ol></li></ol><ol><ol><li><p>Under header</p></li></ol></ol><ul><li><p>No number</p><ul><li><p>No format</p></li></ul></li></ul><ul><li><p>Plain</p></li></ul>",
    );
    expect(await html("<office:document-styles>")).toBe(
      "<ol><li><p>One</p><ul><li><p>Sub</p></li></ul></li><li><p><ol><li><p>Boxed</p></li></ol></p></li></ol><ul><li><p>Bullet</p></li></ul><ul><li><p>Header style</p></li></ul><ul><li><p>First</p><ul><li><p>Nested</p></li></ul></li></ul><ul><ul><li><p>Under header</p></li></ul></ul><ul><li><p>No number</p><ul><li><p>No format</p></li></ul></li></ul><ul><li><p>Plain</p></li></ul>",
    );
  });

  it.each([
    { styleStart: "5", itemStart: undefined, expected: '<ol start="5"><li>' },
    { styleStart: "0", itemStart: "4", expected: '<ol start="0"><li value="4">' },
    { styleStart: "7", itemStart: "1.5", expected: '<ol start="7"><li>' },
    { styleStart: "3", itemStart: undefined, format: "I", expected: '<ol start="3" type="I"><li>' },
    { styleStart: "1", itemStart: undefined, format: "a", expected: '<ol start="1" type="a"><li>' },
  ])(
    "keeps ODT list numbers for style start $styleStart and item start $itemStart",
    async ({ styleStart, itemStart, format = "1", expected }) => {
      const item = itemStart === undefined ? "" : ` text:start-value="${itemStart}"`;
      const content =
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">' +
        `<office:automatic-styles><text:list-style style:name="Steps"><text:list-level-style-number text:level="1" style:num-format="${format}" text:start-value="${styleStart}"/></text:list-style></office:automatic-styles>` +
        `<office:body><office:text><text:list text:style-name="Steps"><text:list-item${item}><text:p>Review</text:p></text:list-item><text:list-item><text:p>Send</text:p></text:list-item></text:list></office:text></office:body></office:document-content>`;
      const result = await openDocument(new JSZip().file("content.xml", content), "odt");
      if (result.type !== "document") throw new Error("Expected document");
      expect(result.pages[0]!.html).toBe(`${expected}<p>Review</p></li><li><p>Send</p></li></ol>`);
    },
  );

  it.each([
    { continued: 'text:continue-numbering="true"', expected: '<ol start="3">' },
    { continued: 'text:continue-list="list1"', expected: '<ol start="3">' },
    { continued: "", expected: "<ol>" },
  ])(
    "numbers a continued ODT list after the paragraph that splits it ($continued)",
    async ({ continued, expected }) => {
      // LibreOffice splits a numbered list around a plain paragraph and marks the second part as continued.
      const list = (id: string, items: string[], attrs = "") =>
        `<text:list xml:id="${id}" ${attrs} text:style-name="Steps">${items.map((item) => `<text:list-item><text:p>${item}</text:p></text:list-item>`).join("")}</text:list>`;
      const content =
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xml="http://www.w3.org/XML/1998/namespace">' +
        '<office:automatic-styles><text:list-style style:name="Steps"><text:list-level-style-number text:level="1" style:num-format="1"/></text:list-style></office:automatic-styles>' +
        `<office:body><office:text>${list("list1", ["Review", "Send"])}<text:p>Wait for a reply.</text:p>${list("list2", ["Merge", "Deploy"], continued)}</office:text></office:body></office:document-content>`;
      const result = await openDocument(new JSZip().file("content.xml", content), "odt");
      if (result.type !== "document") throw new Error("Expected document");
      expect(result.pages[0]!.html).toBe(
        `<ol><li><p>Review</p></li><li><p>Send</p></li></ol><p>Wait for a reply.</p>${expected}<li><p>Merge</p></li><li><p>Deploy</p></li></ol>`,
      );
    },
  );

  // LibreOffice writes every index as the templates it was built from, then the built index.
  const indexes = [
    "table-of-content",
    "illustration-index",
    "table-index",
    "object-index",
    "user-index",
    "alphabetical-index",
    "bibliography",
  ].map(
    (name) =>
      `<text:${name}><text:${name}-source><text:index-title-template>Index</text:index-title-template><text:${name}-entry-template><text:index-entry-text/><text:index-entry-span>: </text:index-entry-span><text:index-entry-page-number/></text:${name}-entry-template></text:${name}-source><text:index-body><text:index-title><text:p>Index</text:p></text:index-title><text:p>Field notes: 1</text:p></text:index-body></text:${name}>`,
  );
  it.each(["odt", "odp"] as const)("reads %s text and rejects unsupported XML", async (kind) => {
    const archive = new JSZip().file(
      "content.xml",
      `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"><office:body>${kind === "odt" ? `<office:text><text:p>Field notes<text:note text:id="ftn1" text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body>\n  <text:p>Sourced on site</text:p></text:note-body></text:note> today<text:note text:id="edn1" text:note-class="endnote"><text:note-citation>i</text:note-citation><text:note-body><text:h>Appendix</text:h></text:note-body></text:note></text:p>${indexes.join("")}</office:text>` : '<draw:page draw:name="Overview"><text:h>Launch plan</text:h><presentation:notes><draw:frame><draw:text-box><text:p>Speaker only</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>'}</office:body></office:document-content>`,
    );
    const result = await openDocument(archive, kind);
    expect(result.type).toBe("document");
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages[0]!.html).toContain(kind === "odt" ? "Field notes" : "Launch plan");
    expect(result.pages[0]!.html).not.toContain("Speaker only");
    if (kind === "odt")
      expect(result.pages[0]!.html).toBe(
        `<p>Field notes<sup>1</sup> today<sup>i</sup></p>${"<p>Index</p><p>Field notes: 1</p>".repeat(indexes.length)}<hr><p><sup>1</sup>Sourced on site</p><p><sup>i</sup></p><h2>Appendix</h2>`,
      );
    for (const source of [
      '<!DOCTYPE x [<!ENTITY external SYSTEM "file:///etc/passwd">]><x>&external;</x>',
      '<html><body><p title="<!--">x</p><!DOCTYPE x [<!ENTITY e "boom">]><b title="-->">&e;</b></body></html>',
      '<html><body><p title="<![CDATA[">x</p><!DOCTYPE x [<!ENTITY e "boom">]><b title="]]>">&e;</b></body></html>',
      '<!DOC<!DOCTYPE a>TYPE x [<!EN<!DOCTYPE a>TITY e "boom">]><x>&e;</x>',
      '<?test <![CDATA[ ?><!DOCTYPE html [<!ENTITY e "boom">]><html><body><pre><![CDATA[x]]></pre></body></html>',
      '<?test <!-- ?><!DOCTYPE html [<!ENTITY e "boom">]><html><body><!-- x --></body></html>',
      "<html><body>" + "<!--".repeat(80_000) + "</body></html>",
      "<html><body>" + "<![CDATA[".repeat(80_000) + "</body></html>",
    ]) {
      archive.file("content.xml", source);
      await expect(openDocument(archive, kind)).rejects.toMatchObject({ code: "xml-invalid" });
    }
  });

  it("counts ODT footnote marks against the preview size limit", async () => {
    const archive = new JSZip().file(
      "content.xml",
      `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>Lead<text:note text:id="ftn1" text:note-class="footnote"><text:note-citation>${'"'.repeat(1_450_000)}</text:note-citation><text:note-body><text:p>Body</text:p></text:note-body></text:note></text:p></office:text></office:body></office:document-content>`,
    );
    await expect(openDocument(archive, "odt")).rejects.toMatchObject({
      code: "rendered-too-large",
    });
  });

  it("keeps OpenDocument image descriptions in image alt text", async () => {
    const archive = new JSZip()
      .file(
        "content.xml",
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:l="http://www.w3.org/1999/xlink" xmlns:s="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0">' +
          '<office:body><office:text><text:p><draw:frame><draw:image l:href="picture.png"/><s:title>Logo</s:title><s:desc>Research &amp; &quot;Design&quot;</s:desc></draw:frame>Visible caption</text:p></office:text></office:body></office:document-content>',
      )
      .file(
        "picture.png",
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        { base64: true },
      );

    const result = await openDocument(archive, "odt");
    if (result.type !== "document") throw new Error("Expected document");
    expect(result.pages[0]!.html).toMatch(
      /^<p><img src="data:image\/png;base64,[^"]+" alt="Logo Research &amp; &quot;Design&quot;">Visible caption<\/p>$/,
    );
  });

  it("reads EPUB chapters in spine order and removes active and remote content", async () => {
    const metadata = Buffer.alloc(65_537);
    metadata.set([0xff, 0xe2, 0xff, 0xff]);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      ...Array.from({ length: 5 }, () => metadata),
      Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 35, 0, 33]),
    ]);
    const archive = new JSZip()
      .file("Book/logo.jpg", jpeg)
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
        `<html><head><title>${"a".repeat(119)}🚀</title></head><body><h1>First chapter</h1><img src="cover.png" alt="Cover"/><img src="logo.jpg" alt="Logo"/><img src="https://example.com/tracker.png"/><script>alert(1)</script><style>@import "https://example.com/style.css";</style></body></html>`,
      )
      .file(
        "Book/two&&&.xhtml",
        '<?xml-stylesheet href="a<b.css"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><head><title>Second</title></head><body><h1>Second chapter</h1><p>A&nbsp;B &copy; &mdash; &NotEqualTilde; &amp;lt;</p><p>Run <tt>make install</tt> with <acronym title="GNU Compiler Collection">GCC</acronym>.</p><pre><![CDATA[Use &amp; and &lt; literally]]></pre><pre><![CDATA[<!DOCTYPE html><!ENTITY author "Ada">]]></pre><!-- <!ENTITY note "x"> --><img src="cover.png" alt="&lt; &copy; &NotEqualTilde;"/></body></html>',
      )
      .file(
        "Book/cover.png",
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
    const book = await openEpub(archive);
    const first = await book.page(0);
    const second = await book.page(1);
    expect([first.title, second.title]).toEqual(["Second", "a".repeat(119)]);
    expect(first.html).toContain("A\u00a0B © — ≂̸ &amp;lt;");
    expect(first.html).toContain(
      '<p>Run <tt>make install</tt> with <acronym title="GNU Compiler Collection">GCC</acronym>.</p>',
    );
    expect(first.html).toContain("<pre>Use &amp;amp; and &amp;lt; literally</pre>");
    expect(first.html).toContain(
      "<pre>&lt;!DOCTYPE html&gt;&lt;!ENTITY author &quot;Ada&quot;&gt;</pre>",
    );
    expect(first.html).toContain('alt="&lt; © ≂̸"');
    expect(second.html).toContain(`src="${second.assets[0]}"`);
    expect(second.html).toContain(`alt="Logo" src="${second.assets[1]}"`);
    const image = await fetch(second.assets[0]!);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    for (const url of [...first.assets, ...second.assets]) URL.revokeObjectURL(url);
    expect(second.html).not.toMatch(/https:|script|alert/);
  });

  it("resolves shared EPUB spine fallbacks and skips unreadable optional navigation", async () => {
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      )
      .file(
        "book.opf",
        `<package><manifest>
          <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
          <item id="cover" fallback="shared"/>
          <item id="chapter" fallback="shared"/>
          <item id="shared" fallback="text"/>
          <item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>
          <item id="cycle-a" fallback="cycle-b"/>
          <item id="cycle-b" fallback="cycle-a"/>
        </manifest><spine toc="ncx">
          <itemref idref="cover" linear="no"/>
          <itemref idref="cycle-a"/>
          <itemref idref="cycle-b"/>
          <itemref idref="chapter"/>
        </spine></package>`,
      )
      .file("toc.ncx", '<?xml version="1.0" encoding="unknown-encoding"?><ncx/>')
      .file("text.xhtml", "<html><body><h1>Readable chapter</h1></body></html>");
    const book = await openEpub(archive);
    expect(book.contents).toEqual([]);
    expect(book.first).toBe(1);
    expect(book.chapters.map(({ linear }) => linear)).toEqual([false, true]);
    expect((await book.page(1)).title).toBe("Readable chapter");
  });

  it("reports excessive document nesting through the preview error code", () => {
    expect(() => parseXml("<section>".repeat(104) + "text" + "</section>".repeat(104))).toThrow(
      expect.objectContaining({ code: "xml-too-deep" }),
    );
  });

  it("loads local EPUB captions and the narration cues for the current chapter", async () => {
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      )
      .file(
        "book.opf",
        `<package><manifest>
          <item id="chapter" href="book/chapter.xhtml" media-type="application/xhtml+xml" media-overlay="read"/>
          <item id="read" href="overlays/chapter.smil" media-type="application/smil+xml"/>
          <item id="captions" href="captions.xml" media-type="application/ttml+xml"/>
          <item id="clip" href="clip.mp4" media-type="video/mp4"/>
        </manifest><spine><itemref idref="chapter"/></spine></package>`,
      )
      .file(
        "book/chapter.xhtml",
        `<html><body><p id="line-1">First line</p>
          <video autoplay=""><track kind="captions" srclang="en" label="English" src="../captions.xml" default=""/>
          <track kind="captions" src="https://example.test/remote.vtt"/>
          <source src="../clip.mp4#t=00:01:00,00:02:00"/><source src="../clip.mp4#t=,120"/>
          <source src="../clip.mp4#t=npt:2.5,4.25"/></video>
        </body></html>`,
      )
      .file(
        "captions.xml",
        `<tt xmlns="http://www.w3.org/ns/ttml"><body><div begin="1s" timeContainer="seq">
          <div><p begin="500ms" dur="2s">Tea &amp; coffee<br/>served.</p></div>
          <p begin="500ms" end="2s">Thanks.</p>
        </div></body></tt>`,
      )
      .file(
        "overlays/chapter.smil",
        `<smil xmlns="http://www.w3.org/ns/SMIL"><body><seq>
          <par><text src="../book/chapter.xhtml#line%2D1"/><audio src="../read.mp3" clipBegin="npt=2s" clipEnd="00:03.250"/></par>
          <par><text src="../book/other.xhtml#skip"/><audio src="../read.mp3"/></par>
          <par><text src="../book/chapter.xhtml#line-1"/><audio src="https://example.test/remote.mp3"/></par>
        </seq></body></smil>`,
      )
      .file("read.mp3", new Uint8Array([255, 251, 16, 0]))
      .file("clip.mp4", new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
    const page = await (await openEpub(archive)).page(0);
    try {
      const tracks = page.html.match(/<track [^>]*>/g);
      expect(tracks).toHaveLength(1);
      expect(tracks?.[0]).toContain('kind="captions" srclang="en" label="English" default');
      expect(page.html).toContain("<video controls playsinline>");
      const caption = await fetch(tracks?.[0]?.match(/src="([^"]+)"/)?.[1] ?? "");
      expect(caption.headers.get("Content-Type")).toBe("text/vtt");
      expect(await caption.text()).toBe(
        "WEBVTT\n\n00:00:01.500 --> 00:00:03.500\nTea &amp; coffee\nserved.\n\n00:00:04.000 --> 00:00:05.500\nThanks.\n",
      );
      expect(page.html.match(/#t=[\d.,]+(?=")/g)).toEqual(["#t=60,120", "#t=0,120", "#t=2.5,4.25"]);
      expect(page.narration).toEqual([
        { src: page.assets.at(-1), begin: 2, end: 3.25, anchor: "line-1" },
      ]);
    } finally {
      for (const url of page.assets) URL.revokeObjectURL(url);
    }
  });

  it("preserves the SVG filters used by EPUB artwork", async () => {
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      )
      .file(
        "book.opf",
        '<package><manifest><item id="a" href="poster.svg" media-type="image/svg+xml"/><item id="b" href="fallback.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
      )
      .file(
        "poster.svg",
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <filter id="tint"><feColorMatrix type="saturate" values="0.5" color-interpolation-filters="sRGB"/></filter>
          <filter id="shadow">
            <feOffset dx="4" dy="4"/>
            <feComponentTransfer><feFuncA type="linear" slope="0.5"/></feComponentTransfer>
            <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="drop"><feDropShadow dx="2" dy="2" flood-color="gray" flood-opacity="0.5"/></filter>
          <filter id="tone"><feFlood flood-color="red"/><feBlend mode="multiply" in="SourceGraphic"/><feImage href="art.png"/></filter>
          <rect width="80" height="80" fill="orange" filter="url(#tint)"/>
        </svg>`,
      )
      .file(
        "fallback.xhtml",
        '<html><body><p><br></p><svg><filter id="d"><feDropShadow dx="2"/></filter></svg></body></html>',
      );
    const book = await openEpub(archive);
    const { html } = await book.page(0);
    expect(html).toContain("<feColorMatrix ");
    expect(html).toContain('color-interpolation-filters="sRGB"');
    expect(html).toContain('values="0.5"');
    expect(html).toContain('<feOffset dx="4" dy="4">');
    expect(html).toContain("<feComponentTransfer><feFuncA ");
    expect(html).toContain('slope="0.5"');
    expect(html).toContain('<feMerge><feMergeNode></feMergeNode><feMergeNode in="SourceGraphic">');
    expect(html).toContain('<feDropShadow dx="2" dy="2" flood-color="gray" flood-opacity="0.5">');
    expect(html).toContain('<feFlood flood-color="red">');
    expect(html).toContain('<feBlend in="SourceGraphic" mode="multiply">');
    expect(html).not.toContain("feImage");
    expect(html).toContain('filter="url(#tint)"');
    expect((await book.page(1)).html).toContain('<feDropShadow dx="2">');
  });

  it("keeps the RGB channel adjustments in EPUB SVG artwork", async () => {
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      )
      .file(
        "book.opf",
        '<package><manifest><item id="poster" href="poster.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="poster"/></spine></package>',
      )
      .file(
        "poster.svg",
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <filter id="tint"><feComponentTransfer>
            <feFuncR type="linear" slope="0.5"/>
            <feFuncG type="discrete" tableValues="0 0.5 1"/>
            <feFuncB type="gamma" amplitude="2" exponent="3"/>
          </feComponentTransfer></filter>
          <rect width="80" height="80" fill="orange" filter="url(#tint)"/>
        </svg>`,
      );
    const book = await openEpub(archive);
    const { html } = await book.page(0);
    expect(html.match(/<feFunc[RGB][^>]*>/g) ?? []).toEqual([
      '<feFuncR type="linear" slope="0.5">',
      '<feFuncG type="discrete" tableValues="0 0.5 1">',
      '<feFuncB type="gamma" amplitude="2" exponent="3">',
    ]);
  });

  it("keeps the lighting and arithmetic composite of EPUB SVG bevels", async () => {
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      )
      .file(
        "book.opf",
        '<package><manifest><item id="badge" href="badge.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="badge"/></spine></package>',
      )
      .file(
        "badge.svg",
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <filter id="bevel">
            <feGaussianBlur in="SourceAlpha" stdDeviation="2" result="blur"/>
            <feSpecularLighting in="blur" surfaceScale="5" specularConstant="0.75" specularExponent="20" result="shine">
              <fePointLight x="-5000" y="-10000" z="20000"/>
            </feSpecularLighting>
            <feDiffuseLighting in="blur" diffuseConstant="1" result="light">
              <feSpotLight x="10" y="10" z="50" pointsAtX="50" pointsAtY="50" pointsAtZ="0" limitingConeAngle="30"/>
            </feDiffuseLighting>
            <feComposite in="SourceGraphic" in2="shine" operator="arithmetic" k1="0" k2="1" k3="1" k4="0"/>
          </filter>
          <rect width="80" height="80" fill="orange" filter="url(#bevel)"/>
        </svg>`,
      );
    const book = await openEpub(archive);
    const { html } = await book.page(0);
    expect(html).toContain('<fePointLight x="-5000" y="-10000" z="20000">');
    expect(html).toContain("<feDiffuseLighting ");
    expect(html).toContain('diffuseConstant="1"');
    expect(html).toContain("<feSpotLight ");
    expect(html).toContain('pointsAtX="50" pointsAtY="50" pointsAtZ="0" limitingConeAngle="30"');
    expect(html).toContain('operator="arithmetic" k1="0" k2="1" k3="1" k4="0"');
  });

  it("keeps embedded raster images in EPUB SVG artwork", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      )
      .file(
        "book.opf",
        '<package><manifest><item id="a" href="poster.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="a"/></spine></package>',
      )
      .file(
        "poster.svg",
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">
          <image width="100" height="100" xlink:href="data:;base64,${png}"/>
          <image width="100" height="100" href="data:image/gif;base64,${png}"/>
          <image width="100" height="100" href="data:image/svg+xml;base64,PHN2Zy8+"/>
        </svg>`,
      );
    const { html, assets } = await (await openEpub(archive)).page(0);
    expect(assets).toHaveLength(1);
    const url = assets[0]!;
    try {
      expect(html).toContain(`href="${url}"`);
      expect((await fetch(url)).headers.get("Content-Type")).toBe("image/png");
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  it("keeps line-continued fonts in EPUB SVG stylesheets", async () => {
    const font = Buffer.concat([Buffer.from("OTTO"), Buffer.alloc(8)]).toString("base64");
    const continued = `${font.slice(0, 8)}\\\n${font.slice(8)}`;
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      )
      .file(
        "book.opf",
        '<package><manifest><item id="a" href="poster.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="a"/></spine></package>',
      )
      .file(
        "poster.svg",
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>
          @font-face { font-family: A; src: url("data:;base64,${continued}"); }
          @font-face { font-family: B; src: url("data:font/woff;base64,${font}"); }
        </style></svg>`,
      );
    const { styles } = await (await openEpub(archive)).page(0);
    expect(styles?.[0]?.css).toContain(`font-family: A; src: url("data:font/otf;base64,${font}")`);
    expect(styles?.[0]?.css).toContain("font-family: B; src: url(about:blank)");
  });

  it("preserves MathML table frames and elementary arithmetic in EPUB chapters", async () => {
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      )
      .file(
        "book.opf",
        '<package><manifest><item id="a" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>',
      )
      .file(
        "one.xhtml",
        `<html><body><math xmlns="http://www.w3.org/1998/Math/MathML">
          <mtable frame="dashed"><mtr><mtd><mn>1</mn></mtd></mtr></mtable>
          <mlongdiv longdivstyle="lefttop"><mn>3</mn><mn>4</mn><mn>12</mn>
            <msgroup position="2" shift="-1"><mn>12</mn><msline length="2"/></msgroup>
          </mlongdiv>
          <mstack><mscarries crossout="verticalstrike"><mscarry><mn>2</mn></mscarry></mscarries>
            <msrow><mo>-</mo><mn>1</mn></msrow>
          </mstack>
        </math></body></html>`,
      );
    const { html } = await (await openEpub(archive)).page(0);
    expect(html).toContain('<mtable frame="dashed">');
    expect(html).toContain('<mlongdiv longdivstyle="lefttop">');
    expect(html).toContain('<msgroup position="2" shift="-1"><mn>12</mn><msline length="2">');
    expect(html).toContain('<mstack><mscarries crossout="verticalstrike"><mscarry>');
    expect(html).toContain("<msrow><mo>-</mo><mn>1</mn></msrow>");
  });

  it.each([
    ["percent-encoded", "My%20Book/book%201.opf", "My Book/book 1.opf", "My Book/one.xhtml"],
    ["literal percent", "My%20Book/book.opf", "My%20Book/book.opf", "My%20Book/one.xhtml"],
    ["malformed percent", "Book%ZZ/book.opf", "Book%ZZ/book.opf", "Book%ZZ/one.xhtml"],
  ])(
    "reads EPUB packages with %s rootfile paths",
    async (_label, fullPath, packagePath, chapterPath) => {
      const archive = new JSZip()
        .file(
          "META-INF/container.xml",
          `<container><rootfiles><rootfile full-path="${fullPath}"/></rootfiles></container>`,
        )
        .file(
          packagePath,
          '<package><manifest><item id="a" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>',
        )
        .file(
          chapterPath,
          "<html><head><title>First</title></head><body><p>Hello</p></body></html>",
        );
      const book = await openEpub(archive);
      expect(await book.page(0)).toMatchObject({ title: "First", html: "<p>Hello</p>" });
    },
  );

  it.each([
    ["a blank title", "<title> \n </title>", "<h1>Prologue</h1>", "Prologue"],
    ["an empty first heading", "", "<h1></h1><h1>Prologue</h1>", "Prologue"],
    ["malformed XHTML", "", "<p><em>Legacy</p><h1>Prologue</h1>", "Prologue"],
    ["only blank headings", "<title> </title>", "<h1></h1><p>Body</p>", undefined],
  ])("titles EPUB chapters with %s", async (_label, head, body, title) => {
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      )
      .file(
        "book.opf",
        '<package><manifest><item id="a" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>',
      )
      .file("one.xhtml", `<html><head>${head}</head><body>${body}</body></html>`);
    const book = await openEpub(archive);
    expect((await book.page(0)).title).toBe(title);
  });
});
