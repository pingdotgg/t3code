import { describe, expect, it } from "vitest";

import { buildTurnDiffTree, summarizeTurnDiffStats } from "./turnDiffTree";

describe("summarizeTurnDiffStats", () => {
  it("sums only files with numeric additions/deletions", () => {
    const stat = summarizeTurnDiffStats([
      { path: "README.md", additions: 3, deletions: 1 },
      { path: "docs/notes.md" },
      { path: "src/index.ts", additions: 5, deletions: 2 },
    ]);

    expect(stat).toEqual({ additions: 8, deletions: 3 });
  });
});

describe("buildTurnDiffTree", () => {
  it("builds nested directory nodes with aggregated stats", () => {
    const tree = buildTurnDiffTree([
      { path: "src/index.ts", additions: 2, deletions: 1 },
      { path: "src/components/Button.tsx", additions: 4, deletions: 2 },
      { path: "README.md", additions: 1, deletions: 0 },
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

  it("keeps files without stat values and excludes them from directory totals", () => {
    const tree = buildTurnDiffTree([
      { path: "docs/notes.md" },
      { path: "docs/todo.md", additions: 1, deletions: 1 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "docs",
        path: "docs",
        stat: { additions: 1, deletions: 1 },
        children: [
          {
            kind: "file",
            name: "notes.md",
            path: "docs/notes.md",
            stat: null,
          },
          {
            kind: "file",
            name: "todo.md",
            path: "docs/todo.md",
            stat: { additions: 1, deletions: 1 },
          },
        ],
      },
    ]);
  });

  it("normalizes file paths with windows separators", () => {
    const tree = buildTurnDiffTree([{ path: "apps\\web\\src\\index.ts", additions: 2, deletions: 1 }]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "apps/web/src",
        path: "apps/web/src",
        stat: { additions: 2, deletions: 1 },
        children: [
          {
            kind: "file",
            name: "index.ts",
            path: "apps/web/src/index.ts",
            stat: { additions: 2, deletions: 1 },
          },
        ],
      },
    ]);
  });

  it("compacts only single-directory chains and stops at branch points", () => {
    const tree = buildTurnDiffTree([
      { path: "apps/server/src/index.ts", additions: 2, deletions: 1 },
      { path: "apps/server/main.ts", additions: 4, deletions: 0 },
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
