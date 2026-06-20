import { describe, expect, it } from "vite-plus/test";
import type { VcsRef } from "@t3tools/contracts";
import { buildBaseRefChoices, filterBaseRefChoices } from "./baseRefChoices";

function ref(name: string, remoteName?: string): VcsRef {
  return {
    name,
    current: false,
    isDefault: false,
    isRemote: remoteName !== undefined,
    ...(remoteName ? { remoteName } : {}),
    worktreePath: null,
  };
}

describe("buildBaseRefChoices", () => {
  it("pairs matching local and remote branches and prefers origin", () => {
    const choices = buildBaseRefChoices(
      [ref("main")],
      [ref("upstream/main", "upstream"), ref("origin/main", "origin")],
    );

    expect(choices).toEqual([
      expect.objectContaining({
        label: "main",
        local: expect.objectContaining({ name: "main" }),
        remote: expect.objectContaining({ name: "origin/main" }),
      }),
      expect.objectContaining({
        label: "upstream/main",
        local: null,
        remote: expect.objectContaining({ name: "upstream/main" }),
      }),
    ]);
  });
});

describe("filterBaseRefChoices", () => {
  it("filters stale server results against the current query", () => {
    const choices = buildBaseRefChoices(
      [ref("main"), ref("feature/search")],
      [ref("origin/main", "origin"), ref("origin/feature/search", "origin")],
    );

    expect(filterBaseRefChoices(choices, "SEARCH").map((choice) => choice.label)).toEqual([
      "feature/search",
    ]);
    expect(filterBaseRefChoices(choices, "origin/main").map((choice) => choice.label)).toEqual([
      "main",
    ]);
  });
});
