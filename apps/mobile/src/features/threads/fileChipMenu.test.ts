import { describe, expect, it } from "vite-plus/test";

import { fileChipMenu, resolveFileChipTarget } from "./fileChipMenu";

describe("resolveFileChipTarget", () => {
  it("resolves a workspace-relative link to both paths", () => {
    expect(resolveFileChipTarget("src/app.ts:12", "/repo")).toEqual({
      fullPath: "/repo/src/app.ts",
      relativePath: "src/app.ts",
    });
  });

  it("keeps only the full path for a host file outside the workspace", () => {
    expect(resolveFileChipTarget("/tmp/report.md", "/repo")).toEqual({
      fullPath: "/tmp/report.md",
    });
  });

  it("keeps only the relative path when the workspace root is unknown", () => {
    expect(resolveFileChipTarget("src/app.ts", null)).toEqual({ relativePath: "src/app.ts" });
  });

  it("ignores links that are not files or cannot be opened", () => {
    expect(resolveFileChipTarget("https://example.com/app.ts", "/repo")).toBeNull();
    expect(resolveFileChipTarget("~/report.md", "/repo")).toBeNull();
    expect(resolveFileChipTarget("../other/file.ts", "/repo")).toBeNull();
  });
});

describe("fileChipMenu", () => {
  it("offers only the copies the target can satisfy", () => {
    expect(fileChipMenu({ fullPath: "/tmp/report.md" })).toEqual({
      title: "/tmp/report.md",
      actions: [
        { id: "copy-full-path", title: "Copy full path" },
        { id: "open-file", title: "Open in file viewer" },
      ],
    });
    expect(fileChipMenu({ relativePath: "src/app.ts" }).actions.map(({ id }) => id)).toEqual([
      "copy-relative-path",
      "open-file",
    ]);
  });
});
