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
    ["README.md", "docs"],
    ["tests/README.md", "tests"],
    ["src/Button.stories.tsx", "code"],
    ["benchmarks/render.bench.ts", "code"],
  ] as const)("%s is %s", (path, kind) => {
    expect(classifyChangedFile(path)).toBe(kind);
  });
});

describe("custom diff hide patterns", () => {
  it("ignores blank lines and reports invalid patterns without losing valid ones", () => {
    const result = compileDiffHideFilePatterns(
      "\r\n  \\.stories\\.tsx$  \r\n[\r\n\r\n^(benchmarks|performance)/\r\n(\r\n(?=foo)\r\n(a+)\\1$\r\n",
    );

    expect(result.patterns.map((pattern) => pattern.pattern())).toEqual([
      "\\.stories\\.tsx$",
      "^(benchmarks|performance)/",
    ]);
    expect(result.errors.map((error) => error.line)).toEqual([3, 6, 7, 8]);
    expect(result.errors.every((error) => error.message.length > 0)).toBe(true);
    expect(matchesDiffHideFile("src/Button.stories.tsx", result.patterns)).toBe(true);
    expect(matchesDiffHideFile("benchmarks/render.ts", result.patterns)).toBe(true);
    expect(matchesDiffHideFile("src/Button.stories.tsx", [])).toBe(false);
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
    ["src/Button.stories.tsx", true],
    ["src\\Button.stories.tsx", true],
    ["benchmarks/render.bench.ts", true],
    ["performance/render.ts", true],
    ["src/Button.test.tsx", true],
    ["src/__mocks__/Button.tsx", true],
    ["src/Button.tsx", false],
    ["src/Button.stories.ts", false],
    ["src/Button.STORIES.tsx", false],
    ["src/benchmarks.ts", false],
    ["generated/api.ts", false],
  ] as const)("matches %s: %s", (path, hidden) => {
    const { patterns } = compileDiffHideFilePatterns(
      "\\.stories\\.tsx$\n^(benchmarks|performance)/",
    );
    expect(matchesDiffHideFile(path, patterns)).toBe(hidden);
  });
});
