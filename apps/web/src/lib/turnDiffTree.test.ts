import { describe, expect, it } from "vite-plus/test";

import { buildTurnDiffTree } from "./turnDiffTree";

describe("buildTurnDiffTree", () => {
  it("builds nested directory nodes with aggregated stats", () => {
    const tree = buildTurnDiffTree([
      { path: "src/index.ts", kind: "modified", additions: 2, deletions: 1 },
      { path: "src/components/Button.tsx", kind: "modified", additions: 4, deletions: 2 },
      { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "src",
        path: "src",
        stat: { additions: 6, deletions: 3 },
        children: [
          {
            kind: "directory",
            name: "components",
            path: "src/components",
            stat: { additions: 4, deletions: 2 },
            children: [
              {
                kind: "file",
                name: "Button.tsx",
                path: "src/components/Button.tsx",
                stat: { additions: 4, deletions: 2 },
              },
            ],
          },
          {
            kind: "file",
            name: "index.ts",
            path: "src/index.ts",
            stat: { additions: 2, deletions: 1 },
          },
        ],
      },
      {
        kind: "file",
        name: "README.md",
        path: "README.md",
        stat: { additions: 1, deletions: 0 },
      },
    ]);
  });

  it("compacts only single-directory chains and stops at branch points", () => {
    const tree = buildTurnDiffTree([
      { path: "apps/server/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
      { path: "apps/server/main.ts", kind: "modified", additions: 4, deletions: 0 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "apps/server",
        path: "apps/server",
        stat: { additions: 6, deletions: 1 },
        children: [
          {
            kind: "directory",
            name: "src",
            path: "apps/server/src",
            stat: { additions: 2, deletions: 1 },
            children: [
              {
                kind: "file",
                name: "index.ts",
                path: "apps/server/src/index.ts",
                stat: { additions: 2, deletions: 1 },
              },
            ],
          },
          {
            kind: "file",
            name: "main.ts",
            path: "apps/server/main.ts",
            stat: { additions: 4, deletions: 0 },
          },
        ],
      },
    ]);
  });
});
