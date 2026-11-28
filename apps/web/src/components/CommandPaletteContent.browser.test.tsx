import "~/index.css";

import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandDialog, CommandDialogPopup, CommandItem, CommandList } from "./ui/command";

function LongPalette() {
  const items = Array.from({ length: 40 }, (_, index) => `Project ${index}`);
  return (
    <CommandDialog open>
      <CommandDialogPopup aria-label="Command palette">
        <CommandPaletteContent items={items} inputProps={{ placeholder: "Search projects" }}>
          <CommandList>
            {(item: string) => <CommandItem value={item}>{item}</CommandItem>}
          </CommandList>
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function SubmenuPalette() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandDialogPopup aria-label="Command palette">
          <CommandPaletteContent
            items={["Project A"]}
            inputProps={{
              placeholder: "Search projects",
              startAddon: (
                <button type="button" aria-label="Back">
                  Back
                </button>
              ),
            }}
          >
            <CommandList>
              {(item: string) => <CommandItem value={item}>{item}</CommandItem>}
            </CommandList>
          </CommandPaletteContent>
        </CommandDialogPopup>
      </CommandDialog>
    </>
  );
}

describe("CommandPaletteContent", () => {
  it("focuses the search input, not the Back button, when it opens into a submenu", async () => {
    await using _screen = await render(<SubmenuPalette />);

    await userEvent.click(page.getByRole("button", { name: "Open" }));

    await expect.element(page.getByPlaceholder("Search projects")).toHaveFocus();
  });

  // The redesign keeps the palette at its fixed 6rem offset; it still never shrinks below its list.
  it.each([
    { height: 900, top: 96 },
    { height: 620, top: 96 },
  ])("sits low without shrinking in a $height px tall window", async ({ height, top }) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1440, height);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await using _screen = await render(<LongPalette />);

    const popup = page.getByRole("dialog", { name: "Command palette" });
    await expect.element(popup).toBeVisible();
    await expect
      .poll(() => {
        const bounds = popup.element().getBoundingClientRect();
        return { top: Math.round(bounds.top), shrunk: Math.round(bounds.height) < 420 };
      })
      .toEqual({ top, shrunk: false });
  });
});
