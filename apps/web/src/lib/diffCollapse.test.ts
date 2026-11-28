import { describe, expect, it } from "vite-plus/test";

import { toggleAllDiffFiles } from "./diffCollapse";

describe("toggleAllDiffFiles", () => {
  it.each([
    { action: "expanding", collapsed: ["a", "b", "hidden"], expected: ["hidden"] },
    { action: "collapsing", collapsed: ["a", "hidden"], expected: ["a", "b", "hidden"] },
  ])(
    "keeps a folded file outside the given ones folded when $action",
    ({ collapsed, expected }) => {
      expect([...toggleAllDiffFiles(["a", "b"], new Set(collapsed))].toSorted()).toEqual(expected);
    },
  );
});
