import { describe, expect, it } from "vite-plus/test";

import { isPdfFile } from "./filePreview";

describe("PDF preview detection", () => {
  it.each([
    [{ name: "download", mimeType: "application/pdf" }, true],
    [{ name: "download", mimeType: "APPLICATION/PDF; charset=binary" }, true],
    [{ name: "Report.PDF", mimeType: "application/octet-stream" }, true],
    [{ name: "https://example.com/report.pdf?signature=abc#page=2" }, true],
    [{ name: "report.pdf", mimeType: "text/plain" }, false],
    [{ name: "report.pdf.exe" }, false],
    [{ name: "https://example.com/page?download=report.pdf" }, false],
  ])("classifies %j as %s", (file, expected) => {
    expect(isPdfFile(file)).toBe(expected);
  });
});
