import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { dismissContextMenu } from "~/contextMenuFallback";
import { render } from "../../../test/render";
import FileBrowserPanel from "./FileBrowserPanel";

const entries: readonly ProjectEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
];
const loadingDirectories: ReadonlySet<string> = new Set();
const directory: {
  entries: readonly ProjectEntry[];
  load: () => Promise<void>;
  refresh: () => void;
  ready: boolean;
  error: null;
  isPending: boolean;
  loadingDirectories: ReadonlySet<string>;
} = {
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

function findTreeRow(path: string): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
}

function withDirectoryListing(listing: readonly ProjectEntry[]): Disposable {
  directory.entries = listing;
  return {
    [Symbol.dispose]: () => {
      directory.entries = entries;
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

  it("applies a very large folder listing quickly and keeps the expanded folder open", async () => {
    using _listing = withDirectoryListing(entries);
    const renderPanel = () => (
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
    await using screen = await render(renderPanel());
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    findTreeRow("src/")!.click();
    await vi.waitFor(() => expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true"));

    directory.entries = [
      ...entries,
      // Out of sort order, because inserting in order hides the cost of each insert.
      ...Array.from({ length: 40_000 }, (_, index): ProjectEntry => {
        const name = String((index * 7_919) % 40_000).padStart(5, "0");
        return { path: `src/generated-${name}`, kind: "directory" };
      }),
    ];
    await screen.rerender(renderPanel());

    await vi.waitFor(() => expect(findTreeRow("src/generated-00000/")).not.toBeNull());
    expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("applies the removal of a very large number of sibling folders quickly", async () => {
    const renderPanel = () => (
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
    using _listing = withDirectoryListing([
      ...entries,
      ...Array.from({ length: 30_000 }, (_, index): ProjectEntry => {
        return { path: `src/generated-${String(index).padStart(6, "0")}`, kind: "directory" };
      }),
    ]);
    await using screen = await render(renderPanel());
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    findTreeRow("src/")!.click();
    await vi.waitFor(() => expect(findTreeRow("src/generated-000000/")).not.toBeNull());

    directory.entries = entries;
    await screen.rerender(renderPanel());

    await vi.waitFor(() => expect(findTreeRow("src/generated-000000/")).toBeNull());
    expect(findTreeRow("README.md")).not.toBeNull();
  });

  it("keeps the selected file through a very large listing without reopening it", async () => {
    const onOpenFile = vi.fn();
    const renderPanel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
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
        cwd="/repo"
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
});
