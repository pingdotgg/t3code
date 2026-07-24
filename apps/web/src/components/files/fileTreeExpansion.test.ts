import { describe, expect, it, vi } from "@effect/vitest";
import { FileTree } from "@pierre/trees";
import type { ProjectEntry } from "@t3tools/contracts";

import {
  COLLAPSE_ALL_FOLDERS_LABEL,
  directoryTreePaths,
  EXPAND_ALL_FOLDERS_LABEL,
  getFileTreeExpansionToggle,
  getFileTreeExpansionSnapshot,
  initiallyExpandedDirectoryPaths,
  setAllDirectoriesExpanded,
  TOGGLE_ALL_FOLDERS_LABEL,
} from "./fileTreeExpansion.ts";

function makeModel(expansionByPath: Record<string, boolean>, searching = false) {
  const state = new Map(Object.entries(expansionByPath));
  const expand = vi.fn((path: string) => state.set(path, true));
  const collapse = vi.fn((path: string) => state.set(path, false));
  const resetPaths = vi.fn(
    (_paths: readonly string[], options: { initialExpandedPaths: readonly string[] }) => {
      const expandedPaths = new Set(options.initialExpandedPaths);
      for (const path of state.keys()) state.set(path, expandedPaths.has(path));
    },
  );
  return {
    collapse,
    expand,
    model: {
      getItem: (path: string) =>
        state.has(path)
          ? {
              collapse: () => collapse(path),
              expand: () => expand(path),
              isDirectory: () => true as const,
              isExpanded: () => state.get(path) ?? false,
            }
          : null,
      isSearchOpen: () => searching,
      resetPaths,
    },
    resetPaths,
    state,
  };
}

describe("file tree expansion controls", () => {
  it("collects unique nested directory paths in parent-first order for flattened trees", () => {
    const entries: ProjectEntry[] = [
      { kind: "file", path: "src/ui/index.ts" },
      { kind: "directory", path: "src/ui" },
      { kind: "directory", path: "src" },
      { kind: "directory", path: "src/ui/" },
    ];

    expect(directoryTreePaths(entries)).toEqual(["src/", "src/ui/"]);
    expect(initiallyExpandedDirectoryPaths(["src/", "src/ui/", "docs/"])).toEqual([
      "src/",
      "docs/",
    ]);
  });

  it("expands and collapses every directory in a flattened tree model", () => {
    const modelPaths = ["src/", "src/ui/", "src/ui/components/", "src/ui/components/Button.tsx"];
    const model = new FileTree({
      flattenEmptyDirectories: true,
      initialExpansion: "closed",
      paths: modelPaths,
    });
    const directoryPaths = ["src/", "src/ui/", "src/ui/components/"];

    try {
      setAllDirectoriesExpanded(model, modelPaths, directoryPaths, true);
      expect(getFileTreeExpansionSnapshot(model, directoryPaths)).toBe("expanded");

      setAllDirectoriesExpanded(model, modelPaths, directoryPaths, false);
      expect(getFileTreeExpansionSnapshot(model, directoryPaths)).toBe("collapsed");
    } finally {
      model.cleanUp();
    }
  });

  it("preserves the previous depth-one initial expansion", () => {
    const modelPaths = ["docs/", "docs/guide/", "docs/guide/start.md", "src/", "src/index.ts"];
    const directoryPaths = ["docs/", "src/", "docs/guide/"];
    const previousModel = new FileTree({
      flattenEmptyDirectories: true,
      initialExpansion: 1,
      paths: modelPaths,
    });
    const batchedModel = new FileTree({
      flattenEmptyDirectories: true,
      initialExpandedPaths: initiallyExpandedDirectoryPaths(directoryPaths),
      initialExpansion: "closed",
      paths: modelPaths,
    });

    try {
      expect(
        directoryPaths.map((path) => getFileTreeExpansionSnapshot(previousModel, [path])),
      ).toEqual(directoryPaths.map((path) => getFileTreeExpansionSnapshot(batchedModel, [path])));
    } finally {
      previousModel.cleanUp();
      batchedModel.cleanUp();
    }
  });

  it("reports an empty tree and gives the toggle an explicit accessible label", () => {
    const { model } = makeModel({});

    expect(getFileTreeExpansionSnapshot(model, [])).toBe("empty");
    expect(getFileTreeExpansionToggle("empty")).toEqual({
      expanded: false,
      label: TOGGLE_ALL_FOLDERS_LABEL,
    });
    expect(getFileTreeExpansionToggle("searching")).toEqual({
      expanded: false,
      label: TOGGLE_ALL_FOLDERS_LABEL,
    });
  });

  it("toggles toward the opposite uniform expansion state", () => {
    expect(getFileTreeExpansionToggle("collapsed")).toEqual({
      expanded: true,
      label: EXPAND_ALL_FOLDERS_LABEL,
    });
    expect(getFileTreeExpansionToggle("expanded")).toEqual({
      expanded: false,
      label: COLLAPSE_ALL_FOLDERS_LABEL,
    });
    expect(getFileTreeExpansionToggle("mixed")).toEqual({
      expanded: false,
      label: COLLAPSE_ALL_FOLDERS_LABEL,
    });
  });

  it("expands only collapsed directories", () => {
    const { expand, model, resetPaths, state } = makeModel({
      "docs/": true,
      "src/": false,
      "src/ui/": false,
    });

    expect(getFileTreeExpansionSnapshot(model, [...state.keys()])).toBe("mixed");
    const paths = [...state.keys()];
    setAllDirectoriesExpanded(model, paths, paths, true);

    expect(resetPaths).toHaveBeenCalledOnce();
    expect(resetPaths).toHaveBeenCalledWith(paths, { initialExpandedPaths: paths });
    expect(expand).not.toHaveBeenCalled();
    expect(getFileTreeExpansionSnapshot(model, [...state.keys()])).toBe("expanded");

    setAllDirectoriesExpanded(model, paths, paths, true);
    expect(resetPaths).toHaveBeenCalledOnce();
  });

  it("collapses only expanded directories", () => {
    const { collapse, model, resetPaths, state } = makeModel({
      "docs/": false,
      "src/": true,
      "src/ui/": true,
    });

    const paths = [...state.keys()];
    setAllDirectoriesExpanded(model, paths, paths, false);

    expect(resetPaths).toHaveBeenCalledOnce();
    expect(resetPaths).toHaveBeenCalledWith(paths, { initialExpandedPaths: [] });
    expect(collapse).not.toHaveBeenCalled();
    expect(getFileTreeExpansionSnapshot(model, [...state.keys()])).toBe("collapsed");
  });

  it("emits and recomputes subscribed state only once for a large tree", () => {
    const directoryPaths = Array.from({ length: 2_000 }, (_, index) => `folder-${index}/`);
    const model = new FileTree({ initialExpansion: "closed", paths: directoryPaths });
    const originalGetItem = model.getItem.bind(model);
    let itemReads = 0;
    const countedModel = {
      getItem: (path: string) => {
        itemReads += 1;
        return originalGetItem(path);
      },
      isSearchOpen: () => model.isSearchOpen(),
      resetPaths: (
        paths: readonly string[],
        options: { initialExpandedPaths: readonly string[] },
      ) => model.resetPaths(paths, options),
    };
    let subscriptionEmissions = 0;
    const unsubscribe = model.subscribe(() => {
      subscriptionEmissions += 1;
      getFileTreeExpansionSnapshot(countedModel, directoryPaths);
    });
    const emissionsBeforeExpansion = subscriptionEmissions;
    itemReads = 0;

    try {
      setAllDirectoriesExpanded(countedModel, directoryPaths, directoryPaths, true);

      expect(subscriptionEmissions - emissionsBeforeExpansion).toBe(1);
      expect(itemReads).toBeLessThanOrEqual(directoryPaths.length * 2);
      expect(getFileTreeExpansionSnapshot(model, directoryPaths)).toBe("expanded");
    } finally {
      unsubscribe();
      model.cleanUp();
    }
  });

  it("does not change temporary expansion while search is open", () => {
    const { collapse, expand, model, resetPaths } = makeModel({ "src/": true }, true);

    expect(getFileTreeExpansionSnapshot(model, ["src/"])).toBe("searching");
    setAllDirectoriesExpanded(model, ["src/"], ["src/"], false);
    setAllDirectoriesExpanded(model, ["src/"], ["src/"], true);

    expect(collapse).not.toHaveBeenCalled();
    expect(expand).not.toHaveBeenCalled();
    expect(resetPaths).not.toHaveBeenCalled();
  });
});
