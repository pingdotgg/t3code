import { describe, expect, it } from "vite-plus/test";

import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import {
  isHtmlPreviewFile,
  isMarkdownPreviewFile,
  prepareHtmlPreviewDocument,
  setMarkdownTaskChecked,
} from "./filePreviewMode";

describe("file comment annotations", () => {
  it("normalizes and formats selected line ranges", () => {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({
      startLine: 7,
      endLine: 16,
    });
    expect(formatFileCommentRange(7, 7)).toBe("L7");
    expect(formatFileCommentRange(7, 16)).toBe("L7 to L16");
  });

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
  });

  it("does not treat other text files as markdown", () => {
    expect(isMarkdownPreviewFile("docs/guide.txt")).toBe(false);
    expect(isMarkdownPreviewFile("docs/markdown.ts")).toBe(false);
  });
});

describe("isHtmlPreviewFile", () => {
  it("recognizes HTML files case-insensitively", () => {
    expect(isHtmlPreviewFile("report.html")).toBe(true);
    expect(isHtmlPreviewFile("artifacts/demo.HTM")).toBe(true);
  });

  it("does not treat other files as HTML", () => {
    expect(isHtmlPreviewFile("report.html.ts")).toBe(false);
    expect(isHtmlPreviewFile("docs/html.md")).toBe(false);
  });
});

describe("prepareHtmlPreviewDocument", () => {
  const assetUrl = "https://example.test/api/assets/signed-token/report.html";

  it("inserts the signed asset directory at the start of an existing head", () => {
    expect(
      prepareHtmlPreviewDocument(
        '<!doctype html><html><head><link href="styles.css"></head><body></body></html>',
        assetUrl,
      ),
    ).toBe(
      '<!doctype html><html><head><base href="https://example.test/api/assets/signed-token/"><link href="styles.css"></head><body></body></html>',
    );
  });

  it("adds a head when the document omits one", () => {
    expect(prepareHtmlPreviewDocument("<!doctype html><main>Report</main>", assetUrl)).toBe(
      '<!doctype html><head><base href="https://example.test/api/assets/signed-token/"></head><main>Report</main>',
    );
  });

  it("resolves an authored relative base against the signed asset directory", () => {
    expect(
      prepareHtmlPreviewDocument(
        '<html><head><base target="_blank" href="assets/"></head></html>',
        assetUrl,
      ),
    ).toBe(
      '<html><head><base target="_blank" href="https://example.test/api/assets/signed-token/assets/"></head></html>',
    );
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
