import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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

  it.each([
    { side: "right" as const, grow: "ArrowLeft", shrink: "ArrowRight" },
    { side: "left" as const, grow: "ArrowRight", shrink: "ArrowLeft" },
  ])(
    "widens a $side file tree with the arrow key pointing into the content",
    async ({ side, grow, shrink }) => {
      const previous = localStorage.getItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY);
      try {
        // This layout has no navigation or links.
        await using screen = await render(
          <div style={{ display: "flex", width: 800 }}>
            <FileExplorerPane resizable side={side} storageKey={STORAGE_KEY}>
              File tree
            </FileExplorerPane>
          </div>,
          { router: false },
        );
        const separator = screen.getByRole("separator");
        await expect.element(separator).toHaveAttribute("aria-valuenow", "256");

        separator.element().focus();
        await userEvent.keyboard(`{${grow}}`);
        await expect.element(separator).toHaveAttribute("aria-valuenow", "272");
        await userEvent.keyboard(`{${shrink}}{${shrink}}`);
        await expect.element(separator).toHaveAttribute("aria-valuenow", "240");
      } finally {
        if (previous === null) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, previous);
      }
    },
  );
});
