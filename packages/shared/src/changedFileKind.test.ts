import { describe, expect, it } from "vite-plus/test";

import { classifyChangedFile } from "./changedFileKind.ts";

describe("classifyChangedFile", () => {
  it.each([
    ["src/contest.py", "code"],
    ["test/fixtures/pr.json", "mocks"],
    ["pnpm-lock.yaml", "generated"],
    ["README.md", "docs"],
    ["tests/README.md", "tests"],
  ] as const)("%s is %s", (path, kind) => {
    expect(classifyChangedFile(path)).toBe(kind);
  });
});
