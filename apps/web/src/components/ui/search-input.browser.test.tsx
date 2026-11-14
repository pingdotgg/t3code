import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { Combobox, ComboboxSearchInput } from "./combobox";
import { MenuSearchInput } from "./menu";

it.each(["combobox", "menu"] as const)(
  "focuses the %s search when clicking the right edge of its row",
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
