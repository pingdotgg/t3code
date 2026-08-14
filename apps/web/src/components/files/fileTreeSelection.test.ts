import { describe, expect, it } from "vite-plus/test";

import { resolveFileTreeSelectionPath } from "./fileTreeSelection";

const entries = [
  { treePath: "a/app/src/index.ts", relativePath: "src/index.ts", root: "/clients/a/app" },
  { treePath: "b/app/src/index.ts", relativePath: "src/index.ts", root: "/clients/b/app" },
];

describe("resolveFileTreeSelectionPath", () => {
  it("uses the owning root to select same-named files", () => {
    expect(
      resolveFileTreeSelectionPath(entries, {
        relativePath: "src/index.ts",
        root: "/clients/b/app",
        primaryRoot: "/clients/a/app",
      }),
    ).toBe("b/app/src/index.ts");
  });

  it("falls back to the primary root for legacy unqualified selections", () => {
    expect(
      resolveFileTreeSelectionPath(entries, {
        relativePath: "src/index.ts",
        root: null,
        primaryRoot: "/clients/a/app",
      }),
    ).toBe("a/app/src/index.ts");
  });
});
