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
    ["requests/health.bru", "tests"],
    ["requests/health.BRU", "tests"],
    ["requests/health.bru.json", "code"],
    ["bruno/opencollection.yml", "tests"],
    ["api/.bruno/collection/environments/local.yaml", "tests"],
    ["api\\BRUNO\\collection\\setup.js", "tests"],
    ["bruno/bruno.json", "tests"],
    ["api/bruno/collection/package.json", "tests"],
    [".bruno/README.md", "tests"],
    ["api/bruno-backup/request.yml", "code"],
    ["api/.bruno-backup/lib/setup.js", "code"],
    ["api/opencollection.yml", "code"],
    [".bruno/collection/fixtures/payload.yaml", "mocks"],
    ["bruno/fixtures/request.bru", "mocks"],
    ["bruno/fixtures/pnpm-lock.yaml", "generated"],
    ["bruno/lib/client.generated.js", "generated"],
    ["README.md", "docs"],
    ["tests/README.md", "tests"],
  ] as const)("%s is %s", (path, kind) => {
    expect(classifyChangedFile(path)).toBe(kind);
  });
});
