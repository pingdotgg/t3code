// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  // jsdom has no layout; give LegendList a 30px viewport and 30px rows so it
  // renders a window of rows the way it does in a browser.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ width: 288, height: 30 }),
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
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

async function typeQuery(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
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
    const press = (key: string) =>
      act(async () => {
        input!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });

    // Both matches were already rendered further down the unfiltered list.
    await typeQuery(input!, "co");
    expect(highlightedOptions()).toEqual(["Courier New"]);

    await press("ArrowDown");
    expect(highlightedOptions()).toEqual(["Fira Code"]);

    await press("Enter");
    expect(onSelect).toHaveBeenCalledWith("Fira Code");
  });
});
