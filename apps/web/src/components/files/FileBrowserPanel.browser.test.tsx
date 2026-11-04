import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { dismissContextMenu } from "~/contextMenuFallback";
import { render } from "../../../test/render";
import FileBrowserPanel from "./FileBrowserPanel";

const entries: readonly ProjectEntry[] = [
  { path: "docs", kind: "directory", mtimeMs: 100 },
  { path: "src", kind: "directory", mtimeMs: 200 },
  { path: "src/a.ts", kind: "file", mtimeMs: 10 },
  { path: "src/b.ts", kind: "file", mtimeMs: 20 },
  { path: "README.md", kind: "file", mtimeMs: 50 },
  { path: "zeta.md", kind: "file", mtimeMs: 300 },
];
const loadingDirectories: ReadonlySet<string> = new Set();
const directory = {
  entries,
  load: () => Promise.resolve(),
  refresh: () => {},
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
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));

function treeRowPaths(): string[] {
  for (const host of document.querySelectorAll("*")) {
    const rows = host.shadowRoot?.querySelectorAll<HTMLElement>("[data-item-path]");
    if (rows?.length) return [...rows].map((row) => row.dataset.itemPath!);
  }
  return [];
}

function findTreeRow(path: string): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
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

  it("re-sorts by date modified and direction while keeping folders open and the selection", async () => {
    using _sortOrder = {
      [Symbol.dispose]: () => localStorage.removeItem("t3code:file-browser-sort"),
    };
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
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    expect(treeRowPaths()).toEqual(["docs/", "src/", "README.md", "zeta.md"]);
    findTreeRow("src/")!.click();
    await vi.waitFor(() => expect(findTreeRow("src/b.ts")).not.toBeNull());
    findTreeRow("src/b.ts")!.click();
    await vi.waitFor(() =>
      expect(findTreeRow("src/b.ts")!.getAttribute("aria-selected")).toBe("true"),
    );

    await userEvent.click(page.getByRole("button", { name: "Sort by date modified" }));
    await vi.waitFor(() =>
      expect(treeRowPaths()).toEqual([
        "docs/",
        "src/",
        "src/a.ts",
        "src/b.ts",
        "README.md",
        "zeta.md",
      ]),
    );
    expect(findTreeRow("src/b.ts")!.getAttribute("aria-selected")).toBe("true");

    await userEvent.click(page.getByRole("button", { name: "Sort descending" }));
    await expect.element(page.getByRole("button", { name: "Sort ascending" })).toBeVisible();
    await vi.waitFor(() =>
      expect(treeRowPaths()).toEqual([
        "src/",
        "src/b.ts",
        "src/a.ts",
        "docs/",
        "zeta.md",
        "README.md",
      ]),
    );
    expect(localStorage.getItem("t3code:file-browser-sort")).toBe(
      '{"key":"modified","direction":"desc"}',
    );
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
  });
});
