import { describe, expect, it, vi } from "vite-plus/test";

import { applyAppearanceContrast } from "./appearanceContrast";

function makeRoot() {
  const setProperty = vi.fn();
  return {
    root: { style: { setProperty } } as unknown as HTMLElement,
    setProperty,
  };
}

describe("applyAppearanceContrast", () => {
  it("boosts semantic contrast above the default", () => {
    const { root, setProperty } = makeRoot();

    applyAppearanceContrast(root, 135);

    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-base", "100%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-boost", "35%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-border-boost", "8.75%");
  });

  it("supports the maximum contrast boost", () => {
    const { root, setProperty } = makeRoot();

    applyAppearanceContrast(root, 200);

    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-base", "100%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-boost", "100%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-border-boost", "25%");
  });

  it("softens semantic contrast below the default", () => {
    const { root, setProperty } = makeRoot();

    applyAppearanceContrast(root, 70);

    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-base", "70%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-boost", "0%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-border-boost", "0%");
  });

  it("disables contrast mixing at the default", () => {
    const { root, setProperty } = makeRoot();

    applyAppearanceContrast(root, 100);

    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-base", "100%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-boost", "0%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-border-boost", "0%");
  });
});
