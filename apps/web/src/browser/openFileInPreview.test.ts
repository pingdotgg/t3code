import { describe, expect, it } from "vite-plus/test";

import { isHtmlFile } from "./openFileInPreview";

describe("isHtmlFile", () => {
  it("checks the full decoded filesystem path without splitting on query or fragment characters", () => {
    expect(isHtmlFile("/tmp/report.html")).toBe(true);
    expect(isHtmlFile("/tmp/report.HTM")).toBe(true);
    expect(isHtmlFile("/tmp/draft#v2.html")).toBe(true);
    expect(isHtmlFile("/tmp/report?draft.htm")).toBe(true);
    expect(isHtmlFile("/tmp/report.html#.txt")).toBe(false);
    expect(isHtmlFile("/tmp/report.html?download=1")).toBe(false);
  });
});
