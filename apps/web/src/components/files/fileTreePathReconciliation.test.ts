import { describe, expect, it } from "vite-plus/test";

import { buildFileTreePathUpdates } from "./fileTreePathReconciliation";

describe("buildFileTreePathUpdates", () => {
  it("removes a folder once and skips the paths inside it", () => {
    expect(
      buildFileTreePathUpdates(["src/", "src/a/", "src/a/b/", "src/a/c.ts"], ["src/"]),
    ).toEqual([{ type: "remove", path: "src/a/", recursive: true }]);
  });

  it("does not treat a sibling that shares a name prefix as inside a removed folder", () => {
    expect(buildFileTreePathUpdates(["src/a/", "src/ab/", "src/a.ts"], [])).toEqual([
      { type: "remove", path: "src/a/", recursive: true },
      { type: "remove", path: "src/ab/", recursive: true },
      { type: "remove", path: "src/a.ts" },
    ]);
  });
});
