import { describe, expect, it } from "vitest";

import {
  buildFileDiffRenderKey,
  expandCollapsedDiffFileForPath,
  resetCollapsedDiffFiles,
  toggleCollapsedDiffFile,
} from "./diffPanelCollapse";

describe("diffPanelCollapse", () => {
  const firstFile = {
    name: "src/app.ts",
    cacheKey: "file-1",
  };
  const secondFile = {
    name: "src/routes.ts",
    cacheKey: "file-2",
  };

  it("defaults files to expanded", () => {
    const collapsed = resetCollapsedDiffFiles();

    expect(collapsed.has(buildFileDiffRenderKey(firstFile))).toBe(false);
  });

  it("toggles one file without affecting others", () => {
    const collapsedFirst = toggleCollapsedDiffFile(
      resetCollapsedDiffFiles(),
      buildFileDiffRenderKey(firstFile),
    );

    expect(collapsedFirst.has(buildFileDiffRenderKey(firstFile))).toBe(true);
    expect(collapsedFirst.has(buildFileDiffRenderKey(secondFile))).toBe(false);
  });

  it("resets all collapsed files for a new patch selection", () => {
    const collapsed = toggleCollapsedDiffFile(
      resetCollapsedDiffFiles(),
      buildFileDiffRenderKey(firstFile),
    );

    expect(collapsed.size).toBe(1);
    expect(resetCollapsedDiffFiles().size).toBe(0);
  });

  it("auto-expands the selected file path when it was collapsed", () => {
    const renamedFile = {
      name: "b/src/new-name.ts",
      prevName: "a/src/old-name.ts",
      cacheKey: "file-rename",
    };
    const collapsed = toggleCollapsedDiffFile(
      resetCollapsedDiffFiles(),
      buildFileDiffRenderKey(renamedFile),
    );

    const expanded = expandCollapsedDiffFileForPath(collapsed, [renamedFile], "src/new-name.ts");

    expect(expanded.has(buildFileDiffRenderKey(renamedFile))).toBe(false);
  });
});
