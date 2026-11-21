import { describe, expect, it } from "vite-plus/test";

import {
  classifyChangedFile,
  compileDiffHideFilePatterns,
  matchesDiffHideFile,
} from "./changedFileKind.ts";

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

describe("custom diff hide patterns", () => {
  it("ignores blank lines and reports invalid patterns without losing valid ones", () => {
    const result = compileDiffHideFilePatterns(
      "\r\n  \\.bench\\.ts$  \r\n[\r\n\r\n^(benchmarks|performance)/\r\n(\r\n(?=foo)\r\n(a+)\\1$\r\n",
    );

    expect(result.patterns.map((pattern) => pattern.pattern())).toEqual([
      "\\.bench\\.ts$",
      "^(benchmarks|performance)/",
    ]);
    expect(result.errors.map((error) => error.line)).toEqual([3, 6, 7, 8]);
    expect(result.errors.every((error) => error.message.length > 0)).toBe(true);
    expect(matchesDiffHideFile("src/render.bench.ts", result.patterns)).toBe(true);
    expect(matchesDiffHideFile("benchmarks/render.ts", result.patterns)).toBe(true);
    expect(matchesDiffHideFile("src/render.bench.ts", [])).toBe(false);
  });

  it.each(["^(a+)+$", "^(a|aa)+$"])(
    "matches %s against long paths without backtracking",
    (source) => {
      const { patterns, errors } = compileDiffHideFilePatterns(source);
      expect(errors).toEqual([]);
      const path = "a".repeat(10_000);
      expect(matchesDiffHideFile(path, patterns)).toBe(true);
      expect(matchesDiffHideFile(`${path}b`, patterns)).toBe(false);
    },
  );

  it.each([
    ["src\\render.bench.ts", true],
    ["src/Button.test.tsx", true],
    ["src/render.BENCH.ts", false],
    ["src/benchmarks.ts", false],
  ] as const)("matches %s: %s", (path, hidden) => {
    const { patterns } = compileDiffHideFilePatterns("\\.bench\\.ts$\n^benchmarks/");
    expect(matchesDiffHideFile(path, patterns)).toBe(hidden);
  });
});
