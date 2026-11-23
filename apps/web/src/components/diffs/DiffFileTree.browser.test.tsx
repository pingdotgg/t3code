import { FileTree } from "@pierre/trees";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { ComposerHandleContext, type ComposerHandleRef } from "~/composerHandleContext";
import { dismissContextMenu } from "~/contextMenuFallback";

import { render } from "../../../test/render";
import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";

const FOLDERS = 300;

it("expands every folder without asking the tree about all folders for each one", async () => {
  // Two levels, so flattening empty folders cannot merge them into one.
  const entries: DiffFileTreeEntry[] = Array.from({ length: FOLDERS }, (_, index) => [
    { path: `package-${index}/a.ts`, status: "modified" as const },
    { path: `package-${index}/lib/b.ts`, status: "modified" as const },
  ]).flat();
  using getItem = vi.spyOn(FileTree.prototype, "getItem");
  await using _screen = await render(
    <div className="flex h-[600px] flex-col">
      <DiffFileTree
        entries={entries}
        onSelectFile={() => {}}
        workspaceRoot="/repo"
        ariaLabel="Changed files"
      />
    </div>,
  );
  const collapseAll = page.getByRole("button", { name: "Collapse all folders" });
  await expect.element(collapseAll).toBeVisible();
  await userEvent.click(collapseAll);
  const expandAll = page.getByRole("button", { name: "Expand all folders" });
  await expect.element(expandAll).toBeVisible();
  getItem.mockClear();
  await userEvent.click(expandAll);
  await expect.element(page.getByRole("button", { name: "Collapse all folders" })).toBeVisible();
  // Each of the expansions used to look up the folders again from the first one, so the lookups
  // grew with the square of the folder count (hundreds of thousands at 600 folders).
  expect(getItem.mock.calls.length).toBeLessThan(FOLDERS * 2 * 20);
});

function findTreeRow(path: string): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
}

function rightClick(row: HTMLElement) {
  row.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, button: 2 }),
  );
}

it("copies a folder's path and a file's name from the right-click menu without opening the file", async () => {
  const onSelectFile = vi.fn();
  await using _screen = await render(
    <div className="flex h-[600px] flex-col">
      <DiffFileTree
        entries={[
          { path: "apps/web/src/a.ts", status: "modified" },
          { path: "apps/web/src/b.ts", status: "added" },
        ]}
        onSelectFile={onSelectFile}
        workspaceRoot="/repo"
        ariaLabel="Changed files"
      />
    </div>,
  );
  using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
  using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

  // Empty folders flatten into one "apps / web / src" row.
  await vi.waitFor(() => expect(findTreeRow("apps/web/src/")).not.toBeNull());
  rightClick(findTreeRow("apps/web/src/")!);
  const copyPath = page.getByRole("menuitem", { name: "Copy path", exact: true });
  await expect.element(copyPath).toBeVisible();
  // No chat is open, so there is nothing to add the row to.
  await expect.element(page.getByRole("menuitem", { name: "Add to chat" })).not.toBeInTheDocument();
  await userEvent.click(copyPath);
  await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("apps/web/src"));

  rightClick(findTreeRow("apps/web/src/a.ts")!);
  await userEvent.click(page.getByRole("menuitem", { name: "Copy name", exact: true }));
  await vi.waitFor(() => expect(clipboard).toHaveBeenLastCalledWith("a.ts"));
  expect(onSelectFile).not.toHaveBeenCalled();
});

it("adds a row to the open chat by the thread's path", async () => {
  const insertTextAtEnd = vi.fn(() => true);
  const composerRef = { current: { insertTextAtEnd } } as unknown as ComposerHandleRef;
  await using _screen = await render(
    <ComposerHandleContext value={composerRef}>
      <div className="flex h-[600px] flex-col">
        <DiffFileTree
          entries={[{ path: "apps/web/src/a.ts", status: "modified" }]}
          onSelectFile={() => {}}
          workspaceRoot="/repo/apps/web"
          // The thread works in the repository's apps/web folder.
          mentionPath={(path) => path.replace(/^apps\/web\//, "")}
          ariaLabel="Changed files"
        />
      </div>
    </ComposerHandleContext>,
  );
  using _menu = { [Symbol.dispose]: () => dismissContextMenu() };

  await vi.waitFor(() => expect(findTreeRow("apps/web/src/a.ts")).not.toBeNull());
  rightClick(findTreeRow("apps/web/src/a.ts")!);
  await userEvent.click(page.getByRole("menuitem", { name: "Add to chat", exact: true }));
  await vi.waitFor(() =>
    expect(insertTextAtEnd).toHaveBeenCalledWith("[a.ts](src/a.ts) ", {
      ensureLeadingBoundary: true,
    }),
  );
});
