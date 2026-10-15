import { describe, expect, it } from "vite-plus/test";

import { formatFilePathForClipboard } from "./mediaActions.ts";

describe("formatFilePathForClipboard", () => {
  it.each([
    ["C:/repo/report.csv", "C:/repo/report.csv", String.raw`C:\repo\report.csv`],
    [
      "reports/report.csv:12:3",
      "C:/repo/reports/report.csv:12:3",
      String.raw`reports\report.csv:12:3`,
    ],
    [
      "reports/report.csv",
      String.raw`\\server\share\repo\reports\report.csv`,
      String.raw`reports\report.csv`,
    ],
    [String.raw`/repo/a\b/report.csv`, "/repo", String.raw`/repo/a\b/report.csv`],
    ["//repo/report.csv", "//repo/report.csv", "//repo/report.csv"],
  ])("formats %s using host %s", (path, hostPath, expected) => {
    expect(formatFilePathForClipboard(path, hostPath)).toBe(expected);
  });

  it("uses the copied path when the host path is unknown", () => {
    expect(formatFilePathForClipboard("src/app.ts")).toBe("src/app.ts");
    expect(formatFilePathForClipboard("C:/repo/app.ts")).toBe(String.raw`C:\repo\app.ts`);
  });
});
