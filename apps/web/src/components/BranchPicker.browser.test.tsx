import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { BranchPicker } from "./BranchPicker";
import { ComboboxItem, ComboboxTrigger } from "./ui/combobox";

function picker(items: string[]) {
  return (
    <BranchPicker
      items={items}
      filteredItems={items}
      value={null}
      query="dev"
      onQueryChange={() => {}}
      open
      onOpenChange={() => {}}
      onSelectItem={() => {}}
      hasNextPage={false}
      isFetchingNextPage={false}
      onLoadNext={() => {}}
      statusText={null}
      popupProps={{}}
      renderItem={(item, index) => (
        <ComboboxItem key={item} index={index} value={item}>
          {item}
        </ComboboxItem>
      )}
    >
      <ComboboxTrigger>Refs</ComboboxTrigger>
    </BranchPicker>
  );
}

describe("BranchPicker", () => {
  it("highlights one row when refs arrive above a row that was already listed", async () => {
    // The create row shows alone until the server answers the query.
    await using screen = await render(picker(["Create dev"]));
    await userEvent.click(page.getByPlaceholder("Search refs..."));
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("option", { name: "Create dev" }))
      .toHaveAttribute("data-highlighted");
    await screen.rerender(picker(["origin/dev", "Create dev"]));

    await expect
      .element(page.getByRole("option", { name: "origin/dev" }))
      .toHaveAttribute("data-highlighted");
    await expect
      .element(page.getByRole("option", { name: "Create dev" }))
      .not.toHaveAttribute("data-highlighted");
  });
});
