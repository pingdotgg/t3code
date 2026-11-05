import { FileTree } from "@pierre/trees";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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
    <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
      <DiffFileTree entries={entries} onSelectFile={() => {}} ariaLabel="Changed files" />
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
