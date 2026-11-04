import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { dismissContextMenu } from "~/contextMenuFallback";
import { render } from "../../../test/render";
import FileBrowserPanel from "./FileBrowserPanel";

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
useDirectoryEntries.mockImplementation(() => directory);
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

function tooltipTexts(): string[] {
  return Array.from(
    document.querySelectorAll('[data-slot="tooltip-popup"]'),
    (popup) => popup.textContent ?? "",
  );
}

const SORT_STORAGE_KEY = "t3code:file-browser-sort";

function setupSort(): Disposable {
  localStorage.removeItem(SORT_STORAGE_KEY);
  return { [Symbol.dispose]: () => localStorage.removeItem(SORT_STORAGE_KEY) };
}

function renderPanel() {
  return render(
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
});

describe("FileBrowserPanel sorting", () => {
  it("keeps folders first by name ascending and offers both sort buttons", async () => {
    using _sort = setupSort();
    await using _screen = await renderPanel();
    await expectRows(NAME_ASC);

    await expect.element(sortKeyButton("Sort by date modified")).toBeVisible();
    await expect.element(sortDirectionButton("Sort descending")).toBeVisible();

    await userEvent.hover(sortKeyButton("Sort by date modified"));
    await vi.waitFor(() => expect(tooltipTexts()).toContain("Sort by date modified"));
    await userEvent.hover(sortDirectionButton("Sort descending"));
    await vi.waitFor(() => expect(tooltipTexts()).toContain("Sort descending"));
  });

  it("sorts by date modified, oldest first, with folders before files", async () => {
    using _sort = setupSort();
    await using _screen = await renderPanel();
    await expectRows(NAME_ASC);

    await userEvent.click(sortKeyButton("Sort by date modified"));

    await expectRows(MODIFIED_ASC);
    await expect.element(sortKeyButton("Sort by name")).toBeVisible();
    await expect.element(sortDirectionButton("Sort descending")).toBeVisible();

    await userEvent.unhover(sortKeyButton("Sort by name"));
    await userEvent.hover(sortKeyButton("Sort by name"));
    await vi.waitFor(() => expect(tooltipTexts()).toContain("Sort by name"));
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

  it("asks for modified times only while sorting by date modified", async () => {
    using _sort = setupSort();
    const requested = () => useDirectoryEntries.mock.lastCall?.[2];
    await using _screen = await renderPanel();
    await expectRows(NAME_ASC);
    expect(requested()).toBe(false);

    await userEvent.click(sortKeyButton("Sort by date modified"));
    await expectRows(MODIFIED_ASC);
    expect(requested()).toBe(true);

    await userEvent.click(sortKeyButton("Sort by name"));
    await expectRows(NAME_ASC);
    expect(requested()).toBe(false);
  });

  it("re-sorts by date modified when a refresh adds or drops timestamps", async () => {
    using _sort = setupSort();
    using _entries = {
      [Symbol.dispose]: () => {
        directory.entries = entries;
      },
    };
    const rerenderPanel = (screen: Awaited<ReturnType<typeof renderPanel>>) =>
      screen.rerender(
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
    directory.entries = [
      { path: "a.txt", kind: "file" },
      { path: "z.txt", kind: "file" },
    ];
    await using screen = await renderPanel();
    await userEvent.click(sortKeyButton("Sort by date modified"));
    await expectRows(["a.txt", "z.txt"]);

    directory.entries = [
      { path: "a.txt", kind: "file", mtimeMs: 20 },
      { path: "z.txt", kind: "file", mtimeMs: 10 },
    ];
    await rerenderPanel(screen);
    await expectRows(["z.txt", "a.txt"]);

    directory.entries = [
      { path: "a.txt", kind: "file", mtimeMs: 5 },
      { path: "z.txt", kind: "file" },
    ];
    await rerenderPanel(screen);
    await expectRows(["a.txt", "z.txt"]);
  });
});
