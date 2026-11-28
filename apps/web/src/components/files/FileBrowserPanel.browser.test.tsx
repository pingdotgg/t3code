import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { RightPanelSheet } from "~/components/RightPanelSheet";
import { dismissContextMenu } from "~/contextMenuFallback";
import { isMacPlatform } from "~/lib/utils";
import { act, render } from "../../../test/render";
import FileBrowserPanel from "./FileBrowserPanel";
import { dispatchPreviewAction } from "../preview/previewActionBus";
import { writeExpandedDirectories } from "./fileTreeExpansion";
import { FULL_TEXT_MAX_BYTES } from "./largeTextProtocol";

const entries: readonly ProjectEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
];
const loadingDirectories: ReadonlySet<string> = new Set();
const directory: {
  entries: readonly ProjectEntry[];
  load: () => Promise<void>;
  refresh: () => void;
  revalidate: (directoryPath: string) => void;
  ready: boolean;
  error: null;
  isPending: boolean;
  loadingDirectories: ReadonlySet<string>;
} = {
  entries,
  load: () => Promise.resolve(),
  refresh: () => {},
  revalidate: () => {},
  ready: true,
  error: null,
  isPending: false,
  loadingDirectories,
};
const pathSearch = {
  entries: [],
  isPending: false,
  error: null,
  truncated: false,
  refresh: () => {},
};

vi.mock("./useDirectoryEntries", () => ({ useDirectoryEntries: () => directory }));
vi.mock("~/state/queries", () => ({ useProjectPathSearch: () => pathSearch }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: () => Promise.resolve() }),
}));
const downloadFile = vi.fn();
vi.mock("./useFileDownload", () => ({ useFileDownload: () => downloadFile }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("~/state/projects"), async (original) => {
  const module = await original();
  return {
    ...module,
    projectEnvironment: {
      ...module.projectEnvironment,
      readFile: ({ input }) => {
        const byteLength = previewSizes.get(input.relativePath);
        return Atom.make(
          byteLength === undefined
            ? AsyncResult.failure(Cause.die("File size unavailable"))
            : AsyncResult.success({
                relativePath: input.relativePath,
                contents: "",
                byteLength,
                truncated: byteLength > 0,
              }),
        );
      },
    },
  };
});

const previewSizes = new Map([
  ["README.md", FULL_TEXT_MAX_BYTES],
  ["empty.md", 0],
  ["oversized.md", FULL_TEXT_MAX_BYTES + 1],
]);

function findTreeRow(path: string): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
}

function findTreeScroller(): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const scroller = host.shadowRoot?.querySelector<HTMLElement>(
      "[data-file-tree-virtualized-scroll]",
    );
    if (scroller) return scroller;
  }
  return null;
}

function isTreeRowInView(path: string): boolean {
  const rowRect = findTreeRow(path)?.getBoundingClientRect();
  const scrollerRect = findTreeScroller()?.getBoundingClientRect();
  return (
    rowRect !== undefined &&
    scrollerRect !== undefined &&
    rowRect.top >= scrollerRect.top &&
    rowRect.bottom <= scrollerRect.bottom
  );
}

function sizedContainer(): HTMLElement {
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;height:300px;width:300px";
  return container;
}

function withDirectoryListing(listing: readonly ProjectEntry[]): Disposable {
  directory.entries = listing;
  return {
    [Symbol.dispose]: () => {
      directory.entries = entries;
      directory.ready = true;
    },
  };
}

describe("FileBrowserPanel", () => {
  it("copies with the pointer and returns to the row after keyboard dismissal", async () => {
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />,
    );
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    async function openRowMenu(path: string) {
      await vi.waitFor(() => expect(findTreeRow(path)).not.toBeNull());
      findTreeRow(path)!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 2,
        }),
      );
    }

    await openRowMenu("src/");
    const copyPath = page.getByRole("menuitem", { name: "Copy path", exact: true });
    const download = page.getByRole("menuitem", { name: "Download", exact: true });
    await expect.element(copyPath).toBeVisible();
    expect(download.query()).toBeNull();
    await userEvent.click(copyPath);
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("/repo/src"));

    await openRowMenu("README.md");
    const copyMention = page.getByRole("menuitem", { name: "Copy mention", exact: true });
    await expect.element(copyMention).toBeVisible();
    await userEvent.click(copyMention);
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("[README.md](README.md)"));

    await openRowMenu("README.md");
    await userEvent.click(download);
    expect(downloadFile).toHaveBeenCalledWith("/repo", "README.md");

    // Hover can take focus when the keyboard menu reopens under the pointer.
    await commands.resetPointer();
    const row = findTreeRow("README.md")!;
    await userEvent.keyboard("{Tab}");
    row.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(download).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect((row.getRootNode() as ShadowRoot).activeElement).toBe(row));
  });

  it("offers Open preview for Markdown files within the render limit", async () => {
    using _listing = withDirectoryListing([
      ...entries,
      ...["empty.md", "missing.md", "notes.txt", "oversized.md"].map((path): ProjectEntry => ({
        path,
        kind: "file",
      })),
    ]);
    const onOpenFilePreview = vi.fn();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        onOpenFilePreview={onOpenFilePreview}
        workspaceMutationId={null}
      />,
    );
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    const action = page.getByRole("menuitem", { name: "Open preview", exact: true });
    for (const [path, offersPreview] of [
      ["README.md", true],
      ["empty.md", true],
      ["missing.md", true],
      ["oversized.md", false],
      ["notes.txt", false],
      ["src/", false],
    ] as const) {
      await vi.waitFor(() => expect(findTreeRow(path)).not.toBeNull());
      findTreeRow(path)!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 2,
        }),
      );
      await expect
        .element(page.getByRole("menuitem", { name: "Copy mention", exact: true }))
        .toBeVisible();
      if (offersPreview) {
        await userEvent.click(action);
        expect(onOpenFilePreview).toHaveBeenLastCalledWith(path);
      } else {
        await expect.element(action).not.toBeInTheDocument();
        await userEvent.keyboard("{Escape}");
      }
    }
  });

  it("dragging a file row carries a composer mention without opening it, and dragend releases it", async () => {
    const onOpenFile = vi.fn();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={onOpenFile}
        workspaceMutationId={null}
      />,
    );
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    const row = findTreeRow("README.md")!;

    const dataTransfer = new DataTransfer();
    row.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, composed: true, dataTransfer }),
    );
    // The tree selects the row the drag picked up; mid-drag that must not open it.
    row.click();
    await vi.waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));

    expect(dataTransfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toContain("README.md");
    expect(onOpenFile).not.toHaveBeenCalled();

    row.dispatchEvent(new DragEvent("dragend", { bubbles: true, composed: true, dataTransfer }));
    await vi.waitFor(() => expect(row.getAttribute("aria-selected")).not.toBe("true"));

    row.click();
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledTimes(1));

    // The selection stays put, so reopening the selected file must not depend on a selection change.
    row.click();
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledTimes(2));
  });

  it("keeps an expanded folder open when a very large listing rebuilds the tree", async () => {
    using _listing = withDirectoryListing(entries);
    const renderPanel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-large-folder-1"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    await using screen = await render(renderPanel());
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    findTreeRow("src/")!.click();
    await vi.waitFor(() => expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true"));

    directory.entries = [
      ...entries,
      // Out of sort order, because inserting in order hides the cost of each insert.
      ...Array.from({ length: 2_000 }, (_, index): ProjectEntry => {
        const name = String((index * 7_919) % 2_000).padStart(4, "0");
        return { path: `src/generated-${name}`, kind: "directory" };
      }),
    ];
    await screen.rerender(renderPanel());

    await vi.waitFor(() => expect(findTreeRow("src/generated-0000/")).not.toBeNull());
    expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the selected file through a very large listing without reopening it", async () => {
    const onOpenFile = vi.fn();
    const renderPanel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-large-folder-2"
        projectName="repo"
        selectedPath="src/aaa.ts"
        selectedPathRevealId={1}
        onOpenFile={onOpenFile}
        workspaceMutationId={null}
      />
    );
    using _listing = withDirectoryListing([...entries, { path: "src/aaa.ts", kind: "file" }]);
    await using screen = await render(renderPanel());
    await vi.waitFor(() =>
      expect(findTreeRow("src/aaa.ts")?.getAttribute("aria-selected")).toBe("true"),
    );

    directory.entries = [
      ...directory.entries,
      ...Array.from({ length: 2_000 }, (_, index): ProjectEntry => {
        const name = String((index * 7_919) % 2_000).padStart(4, "0");
        return { path: `src/generated-${name}.ts`, kind: "file" };
      }),
    ];
    await screen.rerender(renderPanel());

    await vi.waitFor(() => expect(findTreeRow("src/generated-0000.ts")).not.toBeNull());
    expect(findTreeRow("src/aaa.ts")?.getAttribute("aria-selected")).toBe("true");
    expect(findTreeRow("src/")?.getAttribute("aria-expanded")).toBe("true");
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("keeps an open search accurate when a very large folder listing arrives", async () => {
    const renderPanel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-large-folder-3"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    using _listing = withDirectoryListing([
      ...entries,
      { path: "lib", kind: "directory" },
      { path: "lib/generated-existing.ts", kind: "file" },
    ]);
    await using screen = await render(renderPanel());
    const search = page.getByRole("searchbox", { name: "Search repo files" });
    await userEvent.fill(search, "generated-");
    await vi.waitFor(() => expect(findTreeRow("lib/generated-existing.ts")).not.toBeNull());

    directory.entries = [
      ...directory.entries,
      ...Array.from({ length: 2_000 }, (_, index): ProjectEntry => {
        const name = String((index * 7_919) % 2_000).padStart(4, "0");
        return { path: `src/generated-${name}.ts`, kind: "file" };
      }),
    ];
    await screen.rerender(renderPanel());

    await vi.waitFor(() => expect(findTreeRow("src/generated-0000.ts")).not.toBeNull());
    expect(findTreeRow("lib/generated-existing.ts")).not.toBeNull();
    await expect.element(search).toHaveValue("generated-");
  });

  it("mod+f from a tree row, or the panel find command, focuses the file search", async () => {
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
        answersPanelFind
      />,
    );
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    findTreeRow("README.md")!.focus();

    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    await userEvent.keyboard(`{${modifier}>}f{/${modifier}}`);

    const search = page.getByRole("searchbox", { name: "Search repo files" });
    await expect.element(search).toHaveFocus();

    (search.element() as HTMLElement).blur();
    dispatchPreviewAction("find");
    await expect.element(search).toHaveFocus();
  });

  it("Escape in the file search clears it without closing the panel sheet", async () => {
    const onCloseSheet = vi.fn();
    await using _screen = await render(
      <RightPanelSheet animationDurationMs={0} open onClose={onCloseSheet}>
        <FileBrowserPanel
          environmentId={EnvironmentId.make("env-files")}
          cwd="/repo"
          projectName="repo"
          selectedPath={null}
          selectedPathRevealId={0}
          onOpenFile={() => {}}
          workspaceMutationId={null}
        />
      </RightPanelSheet>,
    );
    const search = page.getByRole("searchbox", { name: "Search repo files" });
    await userEvent.fill(search, "read");
    for (const composition of [
      { key: "Escape", isComposing: true, keyCode: 27 },
      { key: "Escape", isComposing: false, keyCode: 229 },
    ]) {
      // Safari ends the composition just before the Escape keydown.
      await act(() => {
        search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        search
          .element()
          .dispatchEvent(new KeyboardEvent("keydown", { ...composition, bubbles: true }));
      });
      await expect.element(search).toHaveValue("read");
    }
    expect(search.element().getAttribute("type")).toBe("text");

    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect.element(search).toHaveFocus();
    await act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true }),
      );
    });
    expect(onCloseSheet).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(onCloseSheet).toHaveBeenCalledOnce());
  });

  it("keeps expanded folders when the panel remounts", async () => {
    const panel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    {
      await using _first = await render(panel());
      await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
      findTreeRow("src/")!.click();
      await vi.waitFor(() =>
        expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true"),
      );
    }

    using revalidate = vi.spyOn(directory, "revalidate");
    await using _second = await render(panel());
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    await vi.waitFor(() => expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true"));

    // Refresh revalidates the folders behind the rows on screen: the open one and the root.
    // The tree can render its rows again at any time, so compare folders, not calls.
    revalidate.mockClear();
    await userEvent.click(page.getByRole("button", { name: "Refresh workspace files" }));
    expect(new Set(revalidate.mock.calls.flat())).toEqual(new Set(["src", ""]));
  });

  it("opens a chain of single folders from one click and keeps it closed once closed", async () => {
    const chain: readonly ProjectEntry[] = [
      { path: "tests", kind: "directory" },
      { path: "tests/edit", kind: "directory" },
      { path: "tests/edit/unit", kind: "directory" },
      { path: "tests/edit/unit/a.ts", kind: "file" },
    ];
    const panel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-single-folder-chain"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    using _listing = withDirectoryListing(chain.slice(0, 1));
    {
      await using screen = await render(panel());
      await vi.waitFor(() => expect(findTreeRow("tests/")).not.toBeNull());
      findTreeRow("tests/")!.click();
      await vi.waitFor(() =>
        expect(findTreeRow("tests/")!.getAttribute("aria-expanded")).toBe("true"),
      );
      for (const listed of [2, 3, 4]) {
        directory.entries = chain.slice(0, listed);
        await screen.rerender(panel());
      }
      await vi.waitFor(() => expect(findTreeRow("tests/edit/unit/a.ts")).not.toBeNull());

      findTreeRow("tests/edit/unit/")!.click();
      await vi.waitFor(() => expect(findTreeRow("tests/edit/unit/a.ts")).toBeNull());
      directory.entries = [...chain, { path: "tests/edit/unit/b.ts", kind: "file" }];
      await screen.rerender(panel());
      expect(findTreeRow("tests/edit/unit/")!.getAttribute("aria-expanded")).toBe("false");
    }

    directory.entries = [...chain, { path: "pkg", kind: "directory" }];
    await using remounted = await render(panel());
    await vi.waitFor(() => expect(findTreeRow("tests/edit/unit/")).not.toBeNull());
    expect(findTreeRow("tests/edit/unit/")!.getAttribute("aria-expanded")).toBe("false");

    // An ignored folder can hold tens of thousands of entries, so it still opens by hand.
    findTreeRow("pkg/")!.click();
    await vi.waitFor(() => expect(findTreeRow("pkg/")!.getAttribute("aria-expanded")).toBe("true"));
    directory.entries = [
      ...directory.entries,
      { path: "pkg/node_modules", kind: "directory", ignored: true },
    ];
    await remounted.rerender(panel());
    await vi.waitFor(() => expect(findTreeRow("pkg/node_modules/")).not.toBeNull());
    expect(findTreeRow("pkg/node_modules/")!.getAttribute("aria-expanded")).toBe("false");
  });

  describe("revealing a folder while folders above it are still loading", () => {
    const roots = Array.from({ length: 12 }, (_, index): ProjectEntry => {
      return { path: `d${String(index).padStart(2, "0")}`, kind: "directory" };
    });
    const listing = (parent: string, count: number) =>
      Array.from({ length: count }, (_, index): ProjectEntry => {
        return { path: `${parent}/f${String(index).padStart(3, "0")}.ts`, kind: "file" };
      });
    const renderPanel = (cwd: string) => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd={cwd}
        projectName="repo"
        selectedPath="d09"
        selectedPathRevealId={1}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    // The tree mounts empty and measures itself before the first listing arrives, as it does for real.
    async function renderRevealedPanel(cwd: string) {
      writeExpandedDirectories(`env-files:${cwd}`, ["d01/", "d01/sub/"]);
      directory.ready = false;
      await using stack = new AsyncDisposableStack();
      const screen = stack.use(await render(renderPanel(cwd), { container: sizedContainer() }));
      directory.entries = roots;
      directory.ready = true;
      await screen.rerender(renderPanel(cwd));
      await vi.waitFor(() => expect(isTreeRowInView("d09/")).toBe(true));
      stack.move();
      return screen;
    }

    it("keeps the revealed folder in view as restored folders above it load", async () => {
      const cwd = "/repo-reveal-follows-loading";
      using _listing = withDirectoryListing([]);
      await using screen = await renderRevealedPanel(cwd);

      // d01 lists after the reveal and holds another restored folder, which lists in turn.
      directory.entries = [...roots, ...listing("d01", 60), { path: "d01/sub", kind: "directory" }];
      await screen.rerender(renderPanel(cwd));
      await vi.waitFor(() => expect(findTreeScroller()!.scrollHeight).toBeGreaterThan(60 * 24));
      directory.entries = [...directory.entries, ...listing("d01/sub", 60)];
      await screen.rerender(renderPanel(cwd));

      await vi.waitFor(() => expect(isTreeRowInView("d09/")).toBe(true));
    });

    it("leaves the scroll position alone once the user scrolls the tree", async () => {
      const cwd = "/repo-reveal-user-scroll";
      using _listing = withDirectoryListing([]);
      await using screen = await renderRevealedPanel(cwd);

      const scroller = findTreeScroller()!;
      scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, composed: true }));
      scroller.scrollTop = 0;
      directory.entries = [...roots, ...listing("d01", 60)];
      await screen.rerender(renderPanel(cwd));
      await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(60 * 24));

      expect(scroller.scrollTop).toBe(0);
    });
  });
});
