import { describe, expect, it } from "vite-plus/test";

import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "./diffCollapse";

const FILE_KEYS = ["src/app.ts", "src/index.ts"];
const FIRST_FILE_KEY = FILE_KEYS[0]!;

describe("diff collapse controls", () => {
  it("reports whether every rendered file is collapsed", () => {
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set(FILE_KEYS))).toBe(true);
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toBe(false);
    expect(areAllDiffFilesCollapsed([], new Set())).toBe(false);
  });

  it("collapses all files when any rendered file is expanded", () => {
    expect(toggleAllDiffFiles(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toEqual(new Set(FILE_KEYS));
  });

  it("expands all files when every rendered file is collapsed", () => {
    expect(toggleAllDiffFiles(FILE_KEYS, new Set(FILE_KEYS))).toEqual(new Set());
  });
});

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
