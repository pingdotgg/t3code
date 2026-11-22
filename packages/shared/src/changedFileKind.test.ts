import { describe, expect, it } from "vite-plus/test";

import { classifyChangedFile } from "./changedFileKind.ts";

describe("classifyChangedFile", () => {
  it.each([
    ["src/contest.py", "code"],
    ["test/fixtures/pr.json", "mocks"],
    ["pnpm-lock.yaml", "generated"],
    ["convex/_generated/api.d.ts", "generated"],
    ["src/agent.eval.ts", "tests"],
    ["evals/title-generation.ts", "tests"],
    ["src/Button.stories.tsx", "tests"],
    ["src/Button.stories.ts", "tests"],
    ["src/Button.stories.js", "tests"],
    ["src/Button.stories.jsx", "tests"],
    ["src/Button.stories.mjs", "tests"],
    ["src/Button.stories.svelte", "tests"],
    ["src/Button.stories.mdx", "tests"],
    ["src\\Button.STORIES.TSX", "tests"],
    ["src/Button.stories.generated.ts", "generated"],
    ["__mocks__/Button.stories.tsx", "mocks"],
    ["src/stories.ts", "code"],
    ["src/stories/Button.tsx", "code"],
    [".storybook/main.ts", "code"],
    ["README.md", "docs"],
    ["tests/README.md", "tests"],
  ] as const)("%s is %s", (path, kind) => {
    expect(classifyChangedFile(path)).toBe(kind);
  });
});
