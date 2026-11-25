import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "./autocomplete";
import { Combobox, ComboboxInput, ComboboxItem, ComboboxList, ComboboxPopup } from "./combobox";

const items = [
  ...Array.from({ length: 40 }, (_, index) => `option-${index}`),
  ...Array.from({ length: 12 }, (_, index) => `match-${index}`),
];

const pickers = {
  combobox: (scrollAreaClassName: string) => (
    <Combobox defaultOpen items={items}>
      <ComboboxInput aria-label="Search options" />
      <ComboboxPopup>
        <ComboboxList scrollAreaClassName={scrollAreaClassName}>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  ),
  autocomplete: (scrollAreaClassName: string) => (
    <Autocomplete defaultOpen items={items}>
      <AutocompleteInput aria-label="Search options" />
      <AutocompletePopup>
        <AutocompleteList scrollAreaClassName={scrollAreaClassName}>
          {(item: string) => (
            <AutocompleteItem key={item} value={item}>
              {item}
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  ),
};

it.each([
  ["combobox", "max-h-none"],
  ["combobox", "max-h-72"],
  ["autocomplete", "max-h-none"],
  ["autocomplete", "max-h-72"],
] as const)(
  "resizes the %s scrollbar thumb when filtering shortens the list (cap: %s)",
  async (kind, scrollAreaClassName) => {
    await using _screen = await render(pickers[kind](scrollAreaClassName), {
      router: false /* filtering a popup list does not involve routing */,
    });

    const viewport = page
      .getByRole("listbox")
      .element()
      .closest("[data-slot=scroll-area-viewport]");
    if (!viewport) throw new Error("List is not inside a scroll area");
    if (scrollAreaClassName === "max-h-72") expect(viewport.clientHeight).toBeLessThanOrEqual(288);
    const thumbHeight = () =>
      document
        .querySelector(
          "[data-slot=scroll-area-scrollbar][data-orientation=vertical] [data-slot=scroll-area-thumb]",
        )
        ?.getBoundingClientRect().height ?? 0;
    await vi.waitFor(() => expect(thumbHeight()).toBeGreaterThan(0));
    const unfilteredThumbHeight = thumbHeight();

    await userEvent.click(page.getByRole("combobox", { name: "Search options" }));
    await userEvent.keyboard("match");
    await vi.waitFor(() => expect(page.getByRole("option").elements()).toHaveLength(12));
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);

    await vi.waitFor(() => expect(thumbHeight()).toBeGreaterThan(unfilteredThumbHeight * 2));
  },
);
