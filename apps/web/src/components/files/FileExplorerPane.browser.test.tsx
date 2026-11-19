import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { FileExplorerPane } from "./FileExplorerPane";

const STORAGE_KEY = "test:file-explorer-default";

describe("FileExplorerPane", () => {
  it.each([
    { view: "Changes", defaultWidth: 256, defaultWidthFraction: 0.4, minWidth: 160, expected: 168 },
    { view: "PR Code", defaultWidth: 320, defaultWidthFraction: 0.4, minWidth: 192, expected: 192 },
    {
      view: "Files",
      defaultWidth: 256,
      minWidth: 160,
      expected: 164,
    },
  ])(
    "preserves the $view initial width in a 420px row",
    async ({ expected, view: _, ...sizing }) => {
      const previous = localStorage.getItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY);
      try {
        // This layout has no navigation or links.
        await using screen = await render(
          <div style={{ display: "flex", width: 420 }}>
            <FileExplorerPane resizable storageKey={STORAGE_KEY} {...sizing}>
              File tree
            </FileExplorerPane>
          </div>,
          { router: false },
        );
        await expect
          .element(screen.getByRole("separator"))
          .toHaveAttribute("aria-valuenow", String(expected));
        expect(screen.container.querySelector("aside")!.getBoundingClientRect().width).toBe(
          expected,
        );
      } finally {
        if (previous === null) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, previous);
      }
    },
  );
});
