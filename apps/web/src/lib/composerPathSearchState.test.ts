import { describe, expect, it } from "vite-plus/test";

import { composerPathSearchEntryDescription } from "./composerPathSearchState";

describe("composer path-search targets", () => {
  it("uses collision-safe root labels in mention descriptions", () => {
    const entry = {
      path: "src/index.ts",
      kind: "file" as const,
      parentPath: "src",
      root: "/clients/a/app",
    };
    expect(composerPathSearchEntryDescription(entry, "a/app")).toBe("a/app/src");
  });
});
