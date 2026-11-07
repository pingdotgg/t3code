import { describe, expect, it } from "vite-plus/test";

import {
  classifyChangedFile,
  isDocumentationChangedFile,
  isTestChangedFile,
} from "./changedFileKind.ts";

describe("classifyChangedFile", () => {
  it.each([
    ["src/contest.py", "code"],
    ["test/fixtures/pr.json", "mocks"],
    ["pnpm-lock.yaml", "generated"],
    ["convex/_generated/api.d.ts", "generated"],
    ["src/agent.eval.ts", "tests"],
    ["evals/title-generation.ts", "tests"],
    ["README.md", "docs"],
    ["tests/README.md", "tests"],
  ] as const)("%s is %s", (path, kind) => {
    expect(classifyChangedFile(path)).toBe(kind);
  });
});

describe("changed file kind helpers", () => {
  it.each([
    ["src/app.test.ts", true, false],
    ["src/__mocks__/client.ts", true, false],
    ["README.md", false, true],
    ["docs/guide.mdx", false, true],
    ["tests/README.md", true, false],
    ["src/app.ts", false, false],
    ["requirements.txt", false, false],
  ] as const)("%s", (path, test, docs) => {
    expect(isTestChangedFile(path)).toBe(test);
    expect(isDocumentationChangedFile(path)).toBe(docs);
  });
});
