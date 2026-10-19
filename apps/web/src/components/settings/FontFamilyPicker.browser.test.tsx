import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => discoverInstalledFonts());
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function highlightedOptions(): string[] {
  return [...document.querySelectorAll('[role="option"][data-highlighted]')].map(
    (option) => option.textContent ?? "",
  );
}

describe("FontFamilyPicker", () => {
  it("highlights, moves through, and selects matches after filtering", async () => {
    const onSelect = vi.fn();
    await act(async () =>
      root.render(
        <FontFamilyPicker
          ariaLabel="Code font"
          defaultFamily="Menlo"
          selectedFamily=""
          initialOpen
          onSelect={onSelect}
        />,
      ),
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
