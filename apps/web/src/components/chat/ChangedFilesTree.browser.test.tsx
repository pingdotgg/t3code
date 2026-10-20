import "~/index.css";

import { RunId } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { TurnDiffFileChange } from "../../types";
import { ChangedFilesCard, ChangedFilesTree } from "./ChangedFilesTree";

function file(path: string, additions = 1, deletions = 0): TurnDiffFileChange {
  return { path, kind: "modified", additions, deletions };
}

const text = (container: HTMLElement) => container.textContent ?? "";

function buttonWithText(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(label),
  );
  expect(button, `button ${label}`).toBeDefined();
  return button!;
}

async function scrollTo(element: HTMLElement, top: number) {
  await act(async () => {
    element.scrollTop = top;
    element.dispatchEvent(new Event("scroll"));
    await new Promise(requestAnimationFrame);
  });
}

describe("ChangedFilesCard", () => {
  it("summarizes a single file with a singular label", async () => {
    await using screen = await render(
      <ChangedFilesCard
        runId={RunId.make("run-1")}
        files={[file("README.md", 2, 1)]}
        allDirectoriesExpanded
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );
    const { container } = screen;

    expect(text(container)).toContain("1 changed file");
    expect(text(container)).not.toContain("1 changed files");
  });

  it("shows collapsed folders and root files together, and opens a folder on click", async () => {
    const onOpenTurnDiff = vi.fn();
    await using screen = await render(
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
    const { container } = screen;

    expect(text(container)).toContain("apps/web/src");
    expect(text(container)).toContain("packages/shared/src");
    expect(text(container)).toContain("README.md");
    expect(text(container)).not.toContain("App.tsx");
    expect(text(container)).not.toContain("git.ts");

    await act(async () => buttonWithText(container, "apps/web/src").click());
    expect(text(container)).toContain("App.tsx");
    expect(text(container)).toContain("App.test.tsx");
    expect(text(container)).not.toContain("git.ts");

    await act(async () => buttonWithText(container, "App.test.tsx").click());
    expect(onOpenTurnDiff).toHaveBeenCalledWith(RunId.make("run-1"), "apps/web/src/App.test.tsx");
  });
});

describe("ChangedFilesTree", () => {
  const manyFiles = Array.from({ length: 16_185 }, (_, index) =>
    file(`src/file-${index.toString().padStart(5, "0")}.ts`),
  );

  it("virtualizes above 250 visible rows and disables it when folders collapse below that count", async () => {
    await using screen = await render(
      <div style={{ height: 280, overflowY: "auto" }}>
        <ChangedFilesTree
          runId={RunId.make("run-1")}
          files={[...manyFiles.slice(0, 248), file("extra/overflow.ts")]}
          allDirectoriesExpanded={false}
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />
      </div>,
    );
    const { container } = screen;
    expect(container.querySelectorAll("button").length).toBe(2);

    await act(async () => buttonWithText(container, "src").click());
    expect(container.querySelectorAll("button").length).toBe(250);
    expect(text(container)).toContain("file-00247.ts");
    expect(text(container)).not.toContain("overflow.ts");

    await act(async () => buttonWithText(container, "extra").click());
    expect(container.querySelectorAll("button").length).toBeLessThan(60);
    expect(text(container)).not.toContain("file-00247.ts");

    await act(async () => buttonWithText(container, "extra").click());
    expect(container.querySelectorAll("button").length).toBe(250);
    expect(text(container)).toContain("file-00247.ts");
    expect(text(container)).not.toContain("overflow.ts");
  });

  it("keeps 1,000 collapsed folders virtualized and reachable after scrolling", async () => {
    const files = Array.from({ length: 1_000 }, (_, index) =>
      file(`folder-${index.toString().padStart(4, "0")}/index.ts`),
    );
    const content = (expanded: boolean) => (
      <div style={{ height: 280, overflowY: "auto" }}>
        <ChangedFilesTree
          runId={RunId.make("run-1")}
          files={files}
          allDirectoriesExpanded={expanded}
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />
      </div>
    );
    await using screen = await render(content(true));
    const { container } = screen;
    expect(container.querySelectorAll("button").length).toBeLessThan(60);

    await screen.rerender(content(false));
    expect(container.querySelectorAll("button").length).toBeLessThan(60);
    expect(text(container)).toContain("folder-0000");
    expect(text(container)).not.toContain("index.ts");
    expect(text(container)).not.toContain("folder-0999");

    const viewport = container.firstElementChild as HTMLElement;
    await scrollTo(viewport, viewport.scrollHeight);
    expect(text(container)).toContain("folder-0999");
    expect(container.querySelectorAll("button").length).toBeLessThan(60);
    await act(async () => buttonWithText(container, "folder-0999").click());
    expect(text(container)).toContain("index.ts");
  });

  it("keeps expand-all bounded and opens files after scrolling the surrounding viewport", async () => {
    const onOpenTurnDiff = vi.fn();
    const onFileContextMenu = vi.fn();
    function Card() {
      const [expanded, setExpanded] = useState(false);
      return (
        <ChangedFilesCard
          runId={RunId.make("run-1")}
          files={manyFiles}
          allDirectoriesExpanded={expanded}
          resolvedTheme="light"
          onToggleAllDirectories={() => setExpanded(!expanded)}
          onOpenTurnDiff={onOpenTurnDiff}
          onFileContextMenu={onFileContextMenu}
        />
      );
    }
    await using screen = await render(
      <div style={{ height: 280, overflowY: "auto" }}>
        <div style={{ height: 420 }} />
        <Card />
      </div>,
    );
    const { container } = screen;
    const viewport = container.firstElementChild as HTMLElement;
    await scrollTo(viewport, 420);
    const collapsedHeight = viewport.scrollHeight;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Expand all folders"]')!.click(),
    );

    expect(container.querySelectorAll("button").length).toBeLessThan(60);
    expect(viewport.scrollHeight).toBeGreaterThan(collapsedHeight + 400_000);
    expect(text(container)).toContain("file-00000.ts");
    expect(text(container)).not.toContain("file-08000.ts");

    await scrollTo(viewport, 420 + 8_001 * 28);
    expect(text(container)).toContain("file-08000.ts");
    expect(text(container)).not.toContain("file-00000.ts");
    expect(container.querySelectorAll("button").length).toBeLessThan(60);

    await scrollTo(viewport, viewport.scrollHeight);
    expect(text(container)).toContain("file-16184.ts");
    await act(async () => buttonWithText(container, "file-16184.ts").click());
    expect(onOpenTurnDiff).toHaveBeenCalledWith(RunId.make("run-1"), "src/file-16184.ts");
    await act(async () =>
      buttonWithText(container, "file-16184.ts").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      ),
    );
    expect(onFileContextMenu).toHaveBeenCalledWith("src/file-16184.ts", expect.anything());

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Collapse all folders"]')!.click(),
    );
    expect(viewport.scrollHeight).toBe(collapsedHeight);
    expect(text(container)).not.toContain("file-16184.ts");
  });

  it("virtualizes a single expanded folder inside a LegendList timeline item", async () => {
    await using screen = await render(
      <LegendList
        data={["message", "files"]}
        keyExtractor={(item) => item}
        estimatedItemSize={280}
        style={{ height: 280 }}
        renderItem={({ item }) =>
          item === "message" ? (
            <div style={{ height: 420 }}>Earlier message</div>
          ) : (
            <ChangedFilesTree
              runId={RunId.make("run-1")}
              files={manyFiles}
              allDirectoriesExpanded={false}
              resolvedTheme="light"
              onOpenTurnDiff={() => {}}
            />
          )
        }
      />,
    );
    const { container } = screen;
    const viewport = container.firstElementChild as HTMLElement;
    await scrollTo(viewport, 420);
    await act(async () => buttonWithText(container, "src").click());
    expect(container.querySelectorAll("button").length).toBeLessThan(60);

    await scrollTo(viewport, 420 + 8_001 * 28);
    expect(text(container)).toContain("file-08000.ts");
    expect(container.querySelectorAll("button").length).toBeLessThan(60);

    await scrollTo(viewport, viewport.scrollHeight);
    expect(text(container)).toContain("file-16184.ts");
    await scrollTo(viewport, 420);
    await act(async () => buttonWithText(container, "src").click());
    expect(text(container)).not.toContain("file-00000.ts");
    expect(container.querySelectorAll("button").length).toBe(1);
  });

  it("keeps a focused file mounted when scrolling it out of view", async () => {
    await using screen = await render(
      <div style={{ height: 280, overflowY: "auto" }}>
        <ChangedFilesTree
          runId={RunId.make("run-1")}
          files={manyFiles}
          allDirectoriesExpanded
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />
      </div>,
    );
    const { container } = screen;
    const viewport = container.firstElementChild as HTMLElement;
    const focusedFile = buttonWithText(container, "file-00000.ts");
    await act(async () => focusedFile.focus());
    await scrollTo(viewport, 8_001 * 28);
    expect(text(container)).toContain("file-08000.ts");
    expect(document.activeElement).toBe(focusedFile);
    expect(container.querySelectorAll("button").length).toBeLessThan(60);

    await act(async () => focusedFile.blur());
    expect(text(container)).not.toContain("file-00000.ts");
  });

  it("remeasures the visible rows when the viewport or preceding content resizes", async () => {
    const content = (height: number, precedingHeight: number) => (
      <div style={{ height, overflowY: "auto" }}>
        <div>
          <div style={{ height: precedingHeight }} />
          <ChangedFilesTree
            runId={RunId.make("run-1")}
            files={manyFiles}
            allDirectoriesExpanded
            resolvedTheme="light"
            onOpenTurnDiff={() => {}}
          />
        </div>
      </div>
    );
    await using screen = await render(content(140, 0));
    const { container } = screen;
    const viewport = container.firstElementChild as HTMLElement;
    await scrollTo(viewport, 8_001 * 28);
    const beforeResize = container.querySelectorAll("button").length;
    await screen.rerender(content(560, 560));
    await expect
      .poll(() => container.querySelectorAll("button").length)
      .toBeGreaterThan(beforeResize);
    expect(text(container)).toContain("file-07980.ts");
    expect(container.querySelectorAll("button").length).toBeLessThan(60);
  });

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
      await using screen = await render(tree(false));
      const { container } = screen;
      const visibleWhenCollapsed = [...container.querySelectorAll("button")].map((button) =>
        button.textContent?.trim(),
      );
      for (const label of expanded) {
        expect(visibleWhenCollapsed.some((value) => value?.startsWith(label))).toBe(
          collapsed.includes(label),
        );
      }

      await screen.rerender(tree(true));
      for (const label of expanded) expect(text(container)).toContain(label);
    },
  );
});
