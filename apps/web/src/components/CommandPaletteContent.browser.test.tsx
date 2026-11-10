import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandDialog, CommandDialogPopup, CommandItem, CommandList } from "./ui/command";

function SubmenuPalette() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(0);
  const [query, setQuery] = useState("");
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandDialogPopup aria-label="Command palette">
          <CommandPaletteContent
            key={view}
            items={["Project A"]}
            value={query}
            onValueChange={setQuery}
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
              {(item: string) => (
                <CommandItem key={item} value={item} onClick={() => setView(view + 1)}>
                  {item}
                </CommandItem>
              )}
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
    await userEvent.click(page.getByRole("option", { name: "Project A" }));
    await userEvent.keyboard("t3");
    await expect.element(page.getByPlaceholder("Search projects")).toHaveValue("t3");
    await expect.element(page.getByPlaceholder("Search projects")).toHaveFocus();
  });
});
