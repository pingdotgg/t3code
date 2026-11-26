import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { Combobox, ComboboxSearchInput } from "./combobox";
import { Menu, MenuItem, MenuPopup, MenuSearchInput, MenuTrigger } from "./menu";

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

it("moves focus from MenuSearchInput to the last item on ArrowUp", async () => {
  await using _screen = await render(
    <Menu defaultOpen>
      <MenuTrigger>Filter</MenuTrigger>
      <MenuPopup>
        <MenuSearchInput aria-label="Search options" />
        <MenuItem>Alpha</MenuItem>
        <MenuItem>Gamma</MenuItem>
      </MenuPopup>
    </Menu>,
    { router: false /* menu keyboard navigation does not involve routing */ },
  );

  await userEvent.click(page.getByRole("textbox", { name: "Search options" }));
  await userEvent.keyboard("{ArrowUp}");

  await expect.element(page.getByRole("menuitem", { name: "Gamma" })).toHaveFocus();
});
