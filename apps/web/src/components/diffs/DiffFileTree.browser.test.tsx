import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { DiffFileTree } from "./DiffFileTree";

function findTreeRow(path: string): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
}

it("names the real path on a file that shares its path with a directory", async () => {
  await using _screen = await render(
    <DiffFileTree
      ariaLabel="Changed files"
      onSelectFile={() => {}}
      entries={[
        { path: "docs", status: "added" },
        { path: "docs/guide.md", status: "added" },
      ]}
    />,
    // DiffFileTree has no links or navigation, so it needs no router.
    { router: false },
  );
  // The tree stores the file as "docs" plus an invisible suffix because the directory owns "docs".
  await vi.waitFor(() => expect(findTreeRow("docs\u200b")).not.toBeNull());

  findTreeRow("docs\u200b")!.dispatchEvent(
    new PointerEvent("pointerover", { bubbles: true, composed: true }),
  );

  expect(findTreeRow("docs\u200b")!.title).toBe("docs");
});
