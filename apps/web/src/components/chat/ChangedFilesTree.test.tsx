import { TurnId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChangedFilesTree } from "./ChangedFilesTree";

describe("ChangedFilesTree", () => {
  it.each([
    {
      name: "a compacted single-chain directory",
      files: [
        { path: "apps/web/src/index.ts", additions: 2, deletions: 1 },
        { path: "apps/web/src/main.ts", additions: 3, deletions: 0 },
      ],
      visibleLabels: ["apps/web/src"],
      hiddenLabels: ["index.ts", "main.ts"],
    },
    {
      name: "a branch point after a compacted prefix",
      files: [
        { path: "apps/server/src/git/Layers/GitCore.ts", additions: 4, deletions: 3 },
        { path: "apps/server/src/provider/Layers/CodexAdapter.ts", additions: 7, deletions: 2 },
      ],
      visibleLabels: ["apps/server/src"],
      hiddenLabels: ["git", "provider", "GitCore.ts", "CodexAdapter.ts"],
    },
    {
      name: "mixed root files and nested compacted directories",
      files: [
        { path: "README.md", additions: 1, deletions: 0 },
        { path: "packages/shared/src/git.ts", additions: 8, deletions: 2 },
        { path: "packages/contracts/src/orchestration.ts", additions: 13, deletions: 3 },
      ],
      visibleLabels: ["README.md", "packages"],
      hiddenLabels: ["shared/src", "contracts/src", "git.ts", "orchestration.ts"],
    },
  ])(
    "renders $name collapsed on the first render when collapse-all is active",
    ({ files, visibleLabels, hiddenLabels }) => {
      const markup = renderToStaticMarkup(
        <ChangedFilesTree
          turnId={TurnId.make("turn-1")}
          files={files}
          allDirectoriesExpanded={false}
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />,
      );

      for (const label of visibleLabels) {
        expect(markup).toContain(label);
      }
      for (const label of hiddenLabels) {
        expect(markup).not.toContain(label);
      }
    },
  );

  it.each([
    {
      name: "a compacted single-chain directory",
      files: [
        { path: "apps/web/src/index.ts", additions: 2, deletions: 1 },
        { path: "apps/web/src/main.ts", additions: 3, deletions: 0 },
      ],
      visibleLabels: ["apps/web/src", "index.ts", "main.ts"],
    },
    {
      name: "a branch point after a compacted prefix",
      files: [
        { path: "apps/server/src/git/Layers/GitCore.ts", additions: 4, deletions: 3 },
        { path: "apps/server/src/provider/Layers/CodexAdapter.ts", additions: 7, deletions: 2 },
      ],
      visibleLabels: [
        "apps/server/src",
        "git/Layers",
        "provider/Layers",
        "GitCore.ts",
        "CodexAdapter.ts",
      ],
    },
    {
      name: "mixed root files and nested compacted directories",
      files: [
        { path: "README.md", additions: 1, deletions: 0 },
        { path: "packages/shared/src/git.ts", additions: 8, deletions: 2 },
        { path: "packages/contracts/src/orchestration.ts", additions: 13, deletions: 3 },
      ],
      visibleLabels: [
        "README.md",
        "packages",
        "shared/src",
        "contracts/src",
        "git.ts",
        "orchestration.ts",
      ],
    },
  ])(
    "renders $name expanded on the first render when expand-all is active",
    ({ files, visibleLabels }) => {
      const markup = renderToStaticMarkup(
        <ChangedFilesTree
          turnId={TurnId.make("turn-1")}
          files={files}
          allDirectoriesExpanded
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />,
      );

      for (const label of visibleLabels) {
        expect(markup).toContain(label);
      }
    },
  );
});
