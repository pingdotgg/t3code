import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { Combobox, ComboboxSearchInput } from "./combobox";
import { Menu, MenuItem, MenuPopup, MenuSearchInput, MenuTrigger } from "./menu";

function SearchableMenu() {
  return (
    <Menu defaultOpen>
      <MenuTrigger>Filter</MenuTrigger>
      <MenuPopup>
        <MenuSearchInput aria-label="Search options" />
        <MenuItem>Alpha</MenuItem>
        <MenuItem>Beta</MenuItem>
        <MenuItem>Gamma</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

it.each(["combobox", "menu"] as const)(
  "focuses the %s search when clicking anywhere in its row",
  async (kind) => {
    await using screen = await render(
      <div className="w-96" data-testid="search-row">
        {kind === "combobox" ? (
          <Combobox>
            <ComboboxSearchInput aria-label="Search options" />
          </Combobox>
        ) : (
          <MenuSearchInput aria-label="Search options" />
        )}
      </div>,
      { router: false /* input focus does not involve navigation */ },
    );
    const row = screen.getByTestId("search-row");
    const field = screen.getByRole(kind === "combobox" ? "combobox" : "textbox", {
      name: "Search options",
    });
    const { width, height } = row.element().getBoundingClientRect();

    for (const x of [4, width / 2, width - 20, width - 4]) {
      field.element().blur();
      await userEvent.click(row, { position: { x, y: height / 2 } });
      await expect.element(field).toHaveFocus();
    }
    await userEvent.keyboard("project");
    await expect.element(field).toHaveValue("project");
  },
);

it("moves focus from MenuSearchInput to the last item on ArrowUp and the first on ArrowDown", async () => {
  await using _screen = await render(<SearchableMenu />, {
    router: false /* menu keyboard navigation does not involve routing */,
  });

  const search = page.getByRole("textbox", { name: "Search options" });
  const first = page.getByRole("menuitem", { name: "Alpha" });
  const last = page.getByRole("menuitem", { name: "Gamma" });

  await userEvent.click(search);
  await expect.element(search).toHaveFocus();

  await userEvent.keyboard("{ArrowUp}");
  await expect.element(last).toHaveFocus();
  await expect.element(last).toHaveAttribute("data-highlighted");

  await userEvent.click(search);
  await expect.element(search).toHaveFocus();

  await userEvent.keyboard("{ArrowDown}");
  await expect.element(first).toHaveFocus();
  await expect.element(first).toHaveAttribute("data-highlighted");
});

it.each(["ArrowUp", "ArrowDown"] as const)(
  "keeps %s in MenuSearchInput while an IME is composing",
  async (key) => {
    await using _screen = await render(<SearchableMenu />, {
      router: false /* menu keyboard navigation does not involve routing */,
    });

    const search = page.getByRole("textbox", { name: "Search options" });
    await userEvent.click(search);
    await expect.element(search).toHaveFocus();

    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    await act(() => search.element().dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    await expect.element(search).toHaveFocus();
  },
);
