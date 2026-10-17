import { RunId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { TurnDiffFileChange } from "../../types";
import { ChangedFilesCard, ChangedFilesTree } from "./ChangedFilesTree";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

function file(path: string, additions = 1, deletions = 0): TurnDiffFileChange {
  return { path, kind: "modified", additions, deletions };
}

const text = () => container.textContent ?? "";

function buttonWithText(label: string) {
  const button = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(label),
  );
  expect(button, `button ${label}`).toBeDefined();
  return button!;
}

describe("ChangedFilesCard", () => {
  it("summarizes a single file with a singular label", async () => {
    await render(
      <ChangedFilesCard
        runId={RunId.make("run-1")}
        files={[file("README.md", 2, 1)]}
        allDirectoriesExpanded
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(text()).toContain("1 changed file");
    expect(text()).not.toContain("1 changed files");
  });

  it("shows collapsed folders and root files together, and opens a folder on click", async () => {
    const onOpenTurnDiff = vi.fn();
    await render(
      <ChangedFilesCard
        runId={RunId.make("run-1")}
        files={[
          file("apps/web/src/App.tsx", 120, 20),
          file("apps/web/src/App.test.tsx", 30, 2),
          file("packages/shared/src/git.ts", 15, 4),
          file("README.md", 3),
        ]}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={onOpenTurnDiff}
      />,
    );

    expect(text()).toContain("apps/web/src");
    expect(text()).toContain("packages/shared/src");
    expect(text()).toContain("README.md");
    expect(text()).not.toContain("App.tsx");
    expect(text()).not.toContain("git.ts");

    await act(async () => buttonWithText("apps/web/src").click());
    expect(text()).toContain("App.tsx");
    expect(text()).toContain("App.test.tsx");
    expect(text()).not.toContain("git.ts");

    await act(async () => buttonWithText("App.test.tsx").click());
    expect(onOpenTurnDiff).toHaveBeenCalledWith(RunId.make("run-1"), "apps/web/src/App.test.tsx");
  });
});

describe("ChangedFilesTree", () => {
  const cases = [
    {
      name: "a compacted single-chain directory",
      files: [file("apps/web/src/index.ts"), file("apps/web/src/main.ts")],
      collapsed: ["apps/web/src"],
      expanded: ["apps/web/src", "index.ts", "main.ts"],
    },
    {
      name: "a branch point after a compacted prefix",
      files: [
        file("apps/server/src/git/Layers/GitCore.ts"),
        file("apps/server/src/provider/Layers/CodexAdapter.ts"),
      ],
      collapsed: ["apps/server/src"],
      expanded: [
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
        file("README.md"),
        file("packages/shared/src/git.ts"),
        file("packages/contracts/src/orchestration.ts"),
      ],
      collapsed: ["README.md", "packages"],
      expanded: [
        "README.md",
        "packages",
        "shared/src",
        "contracts/src",
        "git.ts",
        "orchestration.ts",
      ],
    },
  ];

  it.each(cases)(
    "follows collapse-all and expand-all for $name",
    async ({ files, collapsed, expanded }) => {
      const tree = (allDirectoriesExpanded: boolean) => (
        <ChangedFilesTree
          runId={RunId.make("turn-1")}
          files={files}
          allDirectoriesExpanded={allDirectoriesExpanded}
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />
      );
      await render(tree(false));
      const visibleWhenCollapsed = [...container.querySelectorAll("button")].map((button) =>
        button.textContent?.trim(),
      );
      for (const label of expanded) {
        expect(visibleWhenCollapsed.some((value) => value?.startsWith(label))).toBe(
          collapsed.includes(label),
        );
      }

      await render(tree(true));
      for (const label of expanded) expect(text()).toContain(label);
    },
  );
});
