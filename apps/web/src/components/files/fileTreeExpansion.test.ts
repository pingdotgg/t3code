import { describe, expect, it, vi } from "@effect/vitest";

import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";

function makeModel(expanded: Record<string, boolean>) {
  return {
    getItem: (path: string) => ({
      isDirectory: () => true as const,
      isExpanded: () => expanded[path] ?? false,
      expand: () => {
        expanded[path] = true;
      },
      collapse: () => {
        expanded[path] = false;
      },
    }),
  };
}

describe("file tree expansion", () => {
  it("requires at least one directory and detects whether all are expanded", () => {
    const model = makeModel({ "src/": true, "test/": true });
    expect(areAllDirectoriesExpanded(model, [])).toBe(false);
    expect(areAllDirectoriesExpanded(model, ["src/", "test/"])).toBe(true);
    expect(
      areAllDirectoriesExpanded(makeModel({ "src/": true, "test/": false }), ["src/", "test/"]),
    ).toBe(false);
  });

  it("expands and collapses every directory", () => {
    const expanded = { "src/": true, "test/": false };
    const model = makeModel(expanded);
    setAllDirectoriesExpanded(model, ["src/", "test/"], true);
    expect(expanded).toEqual({ "src/": true, "test/": true });
    setAllDirectoriesExpanded(model, ["src/", "test/"], false);
    expect(expanded).toEqual({ "src/": false, "test/": false });
  });

  it("skips directories already at the requested state", () => {
    const model = makeModel({ "src/": true });
    const item = model.getItem("src/");
    const collapse = vi.spyOn(item, "collapse");
    setAllDirectoriesExpanded(model, ["src/"], true);
    expect(collapse).not.toHaveBeenCalled();
  });
});
