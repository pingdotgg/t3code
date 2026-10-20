import { describe, expect, it } from "vite-plus/test";

import { toChangeBreakdown } from "./pullRequestChangeBreakdown.ts";

describe("toChangeBreakdown", () => {
  it("sums line counts per kind", () => {
    expect(
      toChangeBreakdown({
        truncated: false,
        files: [
          { path: "src/a.ts", additions: 10, deletions: 2 },
          { path: "src/b.ts", additions: 5, deletions: 1 },
          { path: "src/a.test.ts", additions: 40, deletions: 0 },
          { path: "pnpm-lock.yaml", additions: 300, deletions: 120 },
        ],
      }),
    ).toEqual({
      code: { additions: 15, deletions: 3 },
      tests: { additions: 40, deletions: 0 },
      mocks: { additions: 0, deletions: 0 },
      generated: { additions: 300, deletions: 120 },
    });
  });

  it("gives no breakdown for a partial file list", () => {
    expect(
      toChangeBreakdown({
        truncated: true,
        files: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
      }),
    ).toBeNull();
  });
});
