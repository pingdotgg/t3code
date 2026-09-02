import { describe, expect, it } from "vite-plus/test";

import { buildFileTreePathUpdates } from "./fileTreePathReconciliation";

describe("buildFileTreePathUpdates", () => {
  it("updates only paths that changed", () => {
    expect(
      buildFileTreePathUpdates(
        ["src/", "src/kept.ts", "src/removed.ts"],
        ["src/", "src/kept.ts", "src/added.ts"],
      ),
    ).toEqual([
      { type: "remove", path: "src/removed.ts" },
      { type: "add", path: "src/added.ts" },
    ]);
  });

  it("removes a missing subtree with one recursive update", () => {
    expect(
      buildFileTreePathUpdates(
        ["src/", "src/feature/", "src/feature/index.ts", "src/kept.ts"],
        ["src/", "src/kept.ts"],
      ),
    ).toEqual([{ type: "remove", path: "src/feature/", recursive: true }]);
  });

  it("does nothing when a refresh returns the same tree", () => {
    const paths = ["src/", "src/index.ts"];
    expect(buildFileTreePathUpdates(paths, [...paths])).toEqual([]);
  });
});
