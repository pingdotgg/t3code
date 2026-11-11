import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { FileTree } from "@pierre/trees";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { dismissContextMenu } from "~/contextMenuFallback";
import { act, render } from "../../../test/render";
import FileBrowserPanel from "./FileBrowserPanel";

const entries: readonly ProjectEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
];
const loadingDirectories: ReadonlySet<string> = new Set();
const defaultDirectory = {
  entries,
  load: (_path: string) => Promise.resolve(),
  refresh: () => {},
  ready: true,
  error: null,
  isPending: false,
  loadingDirectories,
};
let directory = defaultDirectory;
const pathSearch = {
  entries: [],
  isPending: false,
  error: null,
  truncated: false,
  refresh: () => {},
};

const directoryListeners = new Set<() => void>();
vi.mock("./useDirectoryEntries", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    directoryListeners.add(listener);
    return () => void directoryListeners.delete(listener);
  };
  return { useDirectoryEntries: () => useSyncExternalStore(subscribe, () => directory) };
});
vi.mock("~/state/queries", () => ({ useProjectPathSearch: () => pathSearch }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: () => Promise.resolve() }),
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));

function Panel() {
  return (
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
}

function findTreeRow(path: string): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
}

// The useDirectoryEntries mock reads `directory`, so every test starts from the default.
function setup() {
  directory = defaultDirectory;
}

describe("FileBrowserPanel", () => {
  it("copies with the pointer and returns to the row after keyboard dismissal", async () => {
    setup();
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
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    findTreeRow("README.md")!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 2,
      }),
    );
    const action = page.getByRole("menuitem", { name: "Copy mention", exact: true });
    await expect.element(action).toBeVisible();
    await userEvent.click(action);
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("[README.md](README.md)"));

    const row = findTreeRow("README.md")!;
    await userEvent.keyboard("{Tab}");
    row.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(action).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect((row.getRootNode() as ShadowRoot).activeElement).toBe(row));
  });

  it("dragging a file row carries a composer mention without opening it, and dragend releases it", async () => {
    setup();
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
  });

  it("expands every folder without asking the tree about all folders for each one", async () => {
    setup();
    const folders: readonly ProjectEntry[] = Array.from({ length: 300 }, (_, index) => ({
      path: `folder-${index}`,
      kind: "directory",
    }));
    const load = vi.fn((_path: string) => Promise.resolve());
    directory = { ...directory, entries: folders, load };
    await using _screen = await render(<Panel />);
    using getItem = vi.spyOn(FileTree.prototype, "getItem");
    const expandAll = page.getByRole("button", { name: "Expand all folders" });
    await expect.element(expandAll).toBeVisible();
    getItem.mockClear();
    await userEvent.click(expandAll);
    await expect.element(page.getByRole("button", { name: "Collapse all folders" })).toBeVisible();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(folders.length));
    // Each of the 300 expansions used to look up all 300 folders again, about 137,000 lookups.
    expect(getItem.mock.calls.length).toBeLessThan(folders.length * 20);
  });

  it("expands folders that arrive after Expand all without visiting the earlier ones again", async () => {
    setup();
    const batches = 5;
    const perBatch = 60;
    const folder = (index: number): ProjectEntry => ({
      path: `folder-${index}`,
      kind: "directory",
    });
    const load = vi.fn((_path: string) => Promise.resolve());
    directory = {
      ...directory,
      entries: Array.from({ length: perBatch }, (_, i) => folder(i)),
      load,
    };
    await using _screen = await render(<Panel />);
    using getItem = vi.spyOn(FileTree.prototype, "getItem");
    await userEvent.click(page.getByRole("button", { name: "Expand all folders" }));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(perBatch));
    getItem.mockClear();
    // An asynchronous read returns: the listing grows by a batch of folders at a time.
    for (let batch = 1; batch < batches; batch++) {
      const total = (batch + 1) * perBatch;
      directory = { ...directory, entries: Array.from({ length: total }, (_, i) => folder(i)) };
      await act(() => directoryListeners.forEach((listener) => listener()));
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(total));
    }
    const total = batches * perBatch;
    await expect.element(page.getByRole("button", { name: "Collapse all folders" })).toBeVisible();
    // Every folder, early and late, loaded exactly once.
    expect(new Set(load.mock.calls.map(([path]) => path)).size).toBe(total);
    // About 7,100 lookups with the fix. Expanding all listed folders on each update instead of
    // only the new ones adds 600, and asking the tree about all folders per expansion makes 100,000.
    expect(getItem.mock.calls.length).toBeLessThan(7_400);
  });
});
