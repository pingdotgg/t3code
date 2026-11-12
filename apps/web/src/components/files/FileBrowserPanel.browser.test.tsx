import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { dismissContextMenu } from "~/contextMenuFallback";
import { isMacPlatform } from "~/lib/utils";
import { render } from "../../../test/render";
import FileBrowserPanel from "./FileBrowserPanel";
import { dispatchPreviewAction } from "../preview/previewActionBus";

const entries: readonly ProjectEntry[] = [
  { path: "src", kind: "directory", mtimeMs: 100 },
  { path: ".config", kind: "directory", mtimeMs: 200 },
  { path: "alpha", kind: "directory", mtimeMs: 300 },
  { path: "alpha/a-new.ts", kind: "file", mtimeMs: 900 },
  { path: "alpha/b-old.ts", kind: "file", mtimeMs: 800 },
  { path: "README.md", kind: "file", mtimeMs: 400 },
  { path: ".env", kind: "file", mtimeMs: 200 },
  { path: "b.txt", kind: "file", mtimeMs: 100 },
  { path: "c.txt", kind: "file", mtimeMs: 300 },
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

const { useDirectoryEntries } = vi.hoisted(() => ({ useDirectoryEntries: vi.fn() }));
useDirectoryEntries.mockImplementation(
  (_environmentId: EnvironmentId, _cwd: string, includeModifiedTimes: boolean) =>
    includeModifiedTimes
      ? directory
      : { ...directory, entries: directory.entries.map(({ mtimeMs: _, ...entry }) => entry) },
);
vi.mock("./useDirectoryEntries", () => ({ useDirectoryEntries }));
vi.mock("~/state/queries", () => ({ useProjectPathSearch: () => pathSearch }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: () => Promise.resolve() }),
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));

function findTreeRow(path: string): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
}

function visibleRowPaths(): string[] {
  for (const host of document.querySelectorAll("*")) {
    const rows = host.shadowRoot?.querySelectorAll<HTMLElement>("[data-item-path]");
    if (rows?.length) return Array.from(rows, (row) => row.dataset.itemPath ?? "");
  }
  return [];
}

const SORT_STORAGE_KEY = "t3code:file-browser-sort";

function setupSort(): Disposable {
  localStorage.removeItem(SORT_STORAGE_KEY);
  return { [Symbol.dispose]: () => localStorage.removeItem(SORT_STORAGE_KEY) };
}

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

function renderPanel() {
  return render(panel());
}

function setEntries(next: readonly ProjectEntry[]): Disposable {
  directory.entries = next;
  return {
    [Symbol.dispose]: () => {
      directory.entries = entries;
    },
  };
}

const sortKeyButton = (name: "Sort by date modified" | "Sort by name") =>
  page.getByRole("button", { name, exact: true });
const sortDirectionButton = (name: "Sort descending" | "Sort ascending") =>
  page.getByRole("button", { name, exact: true });

const expectRows = (expected: readonly string[]) =>
  vi.waitFor(() => expect(visibleRowPaths()).toEqual(expected));

const NAME_ASC = [".config/", "alpha/", "src/", ".env", "b.txt", "c.txt", "README.md"];
const NAME_DESC = ["src/", "alpha/", ".config/", "README.md", "c.txt", "b.txt", ".env"];
const MODIFIED_ASC = ["src/", ".config/", "alpha/", "b.txt", ".env", "c.txt", "README.md"];
const MODIFIED_DESC = ["alpha/", ".config/", "src/", "README.md", "c.txt", ".env", "b.txt"];

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
});

describe("FileBrowserPanel sorting", () => {
  it("sorts by date modified, oldest first, with folders before files", async () => {
    using _sort = setupSort();
    await using _screen = await renderPanel();
    await expectRows(NAME_ASC);

    await userEvent.click(sortKeyButton("Sort by date modified"));

    await expectRows(MODIFIED_ASC);
    await expect.element(sortKeyButton("Sort by name")).toBeVisible();
    await expect.element(sortDirectionButton("Sort descending")).toBeVisible();
  });

  it("reverses the order in name mode when the direction is toggled", async () => {
    using _sort = setupSort();
    await using _screen = await renderPanel();
    await expectRows(NAME_ASC);

    await userEvent.click(sortDirectionButton("Sort descending"));
    await expectRows(NAME_DESC);
    await expect.element(sortDirectionButton("Sort ascending")).toBeVisible();

    await userEvent.click(sortDirectionButton("Sort ascending"));
    await expectRows(NAME_ASC);
    await expect.element(sortDirectionButton("Sort descending")).toBeVisible();
  });

  it("reverses the order in modified mode when the direction is toggled", async () => {
    using _sort = setupSort();
    await using _screen = await renderPanel();
    await userEvent.click(sortKeyButton("Sort by date modified"));
    await expectRows(MODIFIED_ASC);

    await userEvent.click(sortDirectionButton("Sort descending"));
    await expectRows(MODIFIED_DESC);
    await expect.element(sortDirectionButton("Sort ascending")).toBeVisible();

    await userEvent.click(sortDirectionButton("Sort ascending"));
    await expectRows(MODIFIED_ASC);
  });

  it("returns to name order when the key is toggled back", async () => {
    using _sort = setupSort();
    await using _screen = await renderPanel();
    await userEvent.click(sortKeyButton("Sort by date modified"));
    await expectRows(MODIFIED_ASC);

    await userEvent.click(sortKeyButton("Sort by name"));

    await expectRows(NAME_ASC);
    await expect.element(sortKeyButton("Sort by date modified")).toBeVisible();
  });

  it("keeps the chosen order after the panel is mounted again", async () => {
    using _sort = setupSort();
    {
      await using _first = await renderPanel();
      await userEvent.click(sortKeyButton("Sort by date modified"));
      await userEvent.click(sortDirectionButton("Sort descending"));
      await expectRows(MODIFIED_DESC);
      expect(localStorage.getItem(SORT_STORAGE_KEY)).not.toBeNull();
    }

    await using _second = await renderPanel();

    await expectRows(MODIFIED_DESC);
    await expect.element(sortKeyButton("Sort by name")).toBeVisible();
    await expect.element(sortDirectionButton("Sort ascending")).toBeVisible();
  });

  it("keeps expanded folders open and sorts their children when the order changes", async () => {
    using _sort = setupSort();
    await using _screen = await renderPanel();
    await expectRows(NAME_ASC);

    findTreeRow("alpha/")!.click();
    await expectRows([
      ".config/",
      "alpha/",
      "alpha/a-new.ts",
      "alpha/b-old.ts",
      "src/",
      ".env",
      "b.txt",
      "c.txt",
      "README.md",
    ]);

    await userEvent.click(sortKeyButton("Sort by date modified"));
    await expectRows([
      "src/",
      ".config/",
      "alpha/",
      "alpha/b-old.ts",
      "alpha/a-new.ts",
      "b.txt",
      ".env",
      "c.txt",
      "README.md",
    ]);

    await userEvent.click(sortDirectionButton("Sort descending"));
    await expectRows([
      "alpha/",
      "alpha/a-new.ts",
      "alpha/b-old.ts",
      ".config/",
      "src/",
      "README.md",
      "c.txt",
      ".env",
      "b.txt",
    ]);
  });

  it("re-sorts by date modified when a refresh adds or drops timestamps", async () => {
    using _sort = setupSort();
    using _entries = setEntries([
      { path: "a.txt", kind: "file" },
      { path: "z.txt", kind: "file" },
    ]);
    await using screen = await renderPanel();
    await userEvent.click(sortKeyButton("Sort by date modified"));
    await expectRows(["a.txt", "z.txt"]);

    setEntries([
      { path: "a.txt", kind: "file", mtimeMs: 20 },
      { path: "z.txt", kind: "file", mtimeMs: 10 },
    ]);
    await screen.rerender(panel());
    await expectRows(["z.txt", "a.txt"]);

    setEntries([
      { path: "a.txt", kind: "file", mtimeMs: 5 },
      { path: "z.txt", kind: "file" },
    ]);
    await screen.rerender(panel());
    await expectRows(["a.txt", "z.txt"]);
  });

  it("sorts a folder's children by date modified when they load", async () => {
    using _sort = setupSort();
    const root: readonly ProjectEntry[] = [
      { path: "alpha", kind: "directory", mtimeMs: 1 },
      { path: "zeta.txt", kind: "file", mtimeMs: 2 },
    ];
    using _entries = setEntries(root);
    await using screen = await renderPanel();
    await userEvent.click(sortKeyButton("Sort by date modified"));
    await userEvent.click(sortDirectionButton("Sort descending"));
    findTreeRow("alpha/")!.click();

    setEntries([
      ...root,
      { path: "alpha/a.ts", kind: "file", mtimeMs: 10 },
      { path: "alpha/b.ts", kind: "file", mtimeMs: 30 },
      { path: "alpha/c.ts", kind: "file", mtimeMs: 20 },
    ]);
    await screen.rerender(panel());

    await expectRows(["alpha/", "alpha/b.ts", "alpha/c.ts", "alpha/a.ts", "zeta.txt"]);
  });

  it("keeps expanding all folders after a re-sort by date modified", async () => {
    using _sort = setupSort();
    const loaded: ProjectEntry[] = [
      { path: "alpha", kind: "directory", mtimeMs: 1 },
      { path: "alpha/a.ts", kind: "file", mtimeMs: 1 },
      { path: "beta", kind: "directory", mtimeMs: 2 },
      { path: "beta/b.ts", kind: "file", mtimeMs: 2 },
    ];
    using _entries = setEntries(loaded);
    await using screen = await renderPanel();
    await userEvent.click(sortKeyButton("Sort by date modified"));
    await userEvent.click(page.getByRole("button", { name: "Expand all folders", exact: true }));
    await expectRows(["alpha/", "alpha/a.ts", "beta/", "beta/b.ts"]);

    loaded[0] = { path: "alpha", kind: "directory", mtimeMs: 3 };
    setEntries([...loaded]);
    await screen.rerender(panel());
    await expectRows(["beta/", "beta/b.ts", "alpha/", "alpha/a.ts"]);

    setEntries([
      ...loaded,
      { path: "alpha/inner", kind: "directory", mtimeMs: 4 },
      { path: "alpha/inner/x.ts", kind: "file", mtimeMs: 4 },
    ]);
    await screen.rerender(panel());

    await expectRows([
      "beta/",
      "beta/b.ts",
      "alpha/",
      "alpha/inner/",
      "alpha/inner/x.ts",
      "alpha/a.ts",
    ]);
  });

  it("keeps a collapsed parent closed over an open child when the order changes", async () => {
    using _sort = setupSort();
    const tree: ProjectEntry[] = [
      { path: "alpha", kind: "directory", mtimeMs: 1 },
      { path: "alpha/inner", kind: "directory", mtimeMs: 1 },
      { path: "alpha/inner/x.ts", kind: "file", mtimeMs: 1 },
      { path: "alpha/z.ts", kind: "file", mtimeMs: 1 },
      { path: "beta.txt", kind: "file", mtimeMs: 2 },
    ];
    using _entries = setEntries(tree);
    await using screen = await renderPanel();
    await userEvent.click(sortKeyButton("Sort by date modified"));
    findTreeRow("alpha/")!.click();
    await vi.waitFor(() => expect(findTreeRow("alpha/inner/")).not.toBeNull());
    findTreeRow("alpha/inner/")!.click();
    await vi.waitFor(() => expect(findTreeRow("alpha/inner/x.ts")).not.toBeNull());
    findTreeRow("alpha/")!.click();
    await expectRows(["alpha/", "beta.txt"]);

    tree[4] = { path: "beta.txt", kind: "file", mtimeMs: 3 };
    setEntries([...tree]);
    await screen.rerender(panel());
    await userEvent.click(sortDirectionButton("Sort descending"));

    await expectRows(["alpha/", "beta.txt"]);
  });

  it("shows new search matches after a refresh re-sorts by date modified", async () => {
    using _sort = setupSort();
    using _entries = setEntries([
      { path: "a.txt", kind: "file", mtimeMs: 1 },
      { path: "b.md", kind: "file", mtimeMs: 2 },
    ]);
    await using screen = await renderPanel();
    await userEvent.click(sortKeyButton("Sort by date modified"));
    await userEvent.fill(page.getByRole("searchbox", { name: "Search repo files" }), "txt");
    await expectRows(["a.txt"]);

    setEntries([
      { path: "a.txt", kind: "file", mtimeMs: 3 },
      { path: "b.md", kind: "file", mtimeMs: 2 },
      { path: "c.txt", kind: "file", mtimeMs: 4 },
    ]);
    await screen.rerender(panel());

    await expectRows(["a.txt", "c.txt"]);
  });

  it("keeps the focused row when a refresh re-sorts by date modified", async () => {
    using _sort = setupSort();
    const tree: ProjectEntry[] = [
      { path: "alpha", kind: "directory", mtimeMs: 1 },
      { path: "alpha/a.ts", kind: "file", mtimeMs: 1 },
      { path: "beta.txt", kind: "file", mtimeMs: 2 },
    ];
    using _entries = setEntries(tree);
    await using screen = await renderPanel();
    await userEvent.click(sortKeyButton("Sort by date modified"));
    findTreeRow("alpha/")!.click();
    await vi.waitFor(() => expect(findTreeRow("alpha/a.ts")).not.toBeNull());
    findTreeRow("alpha/a.ts")!.click();
    await vi.waitFor(() => expect(findTreeRow("alpha/a.ts")?.dataset.itemFocused).toBe("true"));

    tree[2] = { path: "beta.txt", kind: "file", mtimeMs: 0 };
    setEntries([...tree]);
    await screen.rerender(panel());

    await expectRows(["alpha/", "alpha/a.ts", "beta.txt"]);
    await vi.waitFor(() => expect(findTreeRow("alpha/a.ts")?.dataset.itemFocused).toBe("true"));
  });
});
