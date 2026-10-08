import { describe, expect, it } from "vite-plus/test";

import { isBrowserPreviewFile } from "~/browser/openFileInPreview";
import { resolveMarkdownFileLinkMeta } from "~/markdown-links";

import { isPdfPreviewFile } from "./BrowserDocumentFrame";

describe("browser document file paths", () => {
  it("recognizes a decoded chat link without treating the filename as a URL again", () => {
    const link = resolveMarkdownFileLinkMeta("F:/Reports/report%23final.html#L12", "F:/Reports");
    expect(link).toMatchObject({
      filePath: "F:/Reports/report#final.html",
      workspaceRelativePath: "report#final.html",
      line: 12,
    });
    expect(isBrowserPreviewFile(link!.filePath)).toBe(true);
  });

  it("opens an encoded relative HTML link from rendered markdown", () => {
    const link = resolveMarkdownFileLinkMeta("report%23final.html", "/workspace");
    expect(link).toMatchObject({
      filePath: "/workspace/report#final.html",
      workspaceRelativePath: "report#final.html",
    });
    expect(isBrowserPreviewFile(link!.filePath)).toBe(true);
  });

  it.each(["html", "pdf"])("opens a bare Unicode .%s link as a browser document", (extension) => {
    const path = `線性代數/期中 報告.${extension}`;
    const link = resolveMarkdownFileLinkMeta(encodeURI(path), "/workspace");
    expect(link).toMatchObject({
      filePath: `/workspace/${path}`,
      workspaceRelativePath: path,
    });
    expect(isBrowserPreviewFile(link!.filePath)).toBe(true);
    expect(isPdfPreviewFile(link!.filePath)).toBe(extension === "pdf");
  });

  it.each([
    "reports/report.html",
    "reports/report#final.html",
    "reports/report?final.HTM",
    "F:/Reports/#review/report.html",
    "C:\\Reports\\#review\\report.htm",
  ])("renders the HTML file at the literal path %s", (path) => {
    expect(isBrowserPreviewFile(path)).toBe(true);
    expect(isPdfPreviewFile(path)).toBe(false);
  });

  it.each([
    "reports/report#final.pdf",
    "reports/report?final.PDF",
    "F:/Reports/#review/report.pdf",
  ])("uses the PDF viewer for the literal path %s", (path) => {
    expect(isBrowserPreviewFile(path)).toBe(true);
    expect(isPdfPreviewFile(path)).toBe(true);
  });

  it.each(["reports/report.html#notes.txt", "reports/report.pdf?notes.txt"])(
    "keeps the non-document file %s in source view",
    (path) => {
      expect(isBrowserPreviewFile(path)).toBe(false);
      expect(isPdfPreviewFile(path)).toBe(false);
    },
  );
});
