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
    <div style={{ width: 160, display: "flex", flexDirection: "column" }}>
      <DiffFileTree
        ariaLabel="Changed files"
        onSelectFile={() => {}}
        entries={[
          { path: "documentation-that-is-cut-off", status: "added" },
          { path: "documentation-that-is-cut-off/guide.md", status: "added" },
        ]}
      />
    </div>,
    // DiffFileTree has no links or navigation, so it needs no router.
    { router: false },
  );
  // The tree stores the file as the directory path plus an invisible suffix because the directory owns that path.
  await vi.waitFor(() => expect(findTreeRow("documentation-that-is-cut-off\u200b")).not.toBeNull());

  findTreeRow("documentation-that-is-cut-off\u200b")!.dispatchEvent(
    new PointerEvent("pointerover", { bubbles: true, composed: true }),
  );

  expect(findTreeRow("documentation-that-is-cut-off\u200b")!.title).toBe(
    "documentation-that-is-cut-off",
  );
});
