import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const families = vi.hoisted(() => {
  const families = [
    "Arial",
    "Courier New",
    "Fira Code",
    "Georgia",
    "Helvetica",
    "JetBrains Mono",
    "Menlo",
    "Times New Roman",
  ];
  // The picker decides at module load whether the engine can list fonts.
  Object.assign(window, { queryLocalFonts: async () => families.map((family) => ({ family })) });
  return families;
});

vi.mock("../../appearanceFonts", () => ({
  isMonospaceFamily: () => true,
  queryInstalledFontFamilies: async () => ({ status: "granted", families }),
}));

import { discoverInstalledFonts, FontFamilyPicker } from "./FontFamilyPicker";

function highlightedOptions(): string[] {
  return [...document.querySelectorAll('[role="option"][data-highlighted]')].map(
    (option) => option.textContent ?? "",
  );
}

describe("FontFamilyPicker", () => {
  it("highlights, moves through, and selects matches after filtering", async () => {
    const onSelect = vi.fn();
    await act(() => discoverInstalledFonts());
    await using _screen = await render(
      <FontFamilyPicker
        ariaLabel="Code font"
        defaultFamily="Menlo"
        selectedFamily=""
        initialOpen
        onSelect={onSelect}
      />,
    );

    const input = document.querySelector<HTMLInputElement>('input[placeholder="Search fonts…"]');
    expect(input).not.toBeNull();
    const press = (key: string) => act(() => userEvent.keyboard(`{${key}}`));

    // Both matches were already rendered further down the unfiltered list.
    await act(() => userEvent.type(input!, "co"));
    await expect.poll(highlightedOptions).toEqual(["Courier New"]);

    await press("ArrowDown");
    expect(highlightedOptions()).toEqual(["Fira Code"]);

    await press("Enter");
    expect(onSelect).toHaveBeenCalledWith("Fira Code");
  });
});
