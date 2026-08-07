import { describe, expect, it } from "vite-plus/test";

import { createManagedThemeColors, type ThemeDefinition } from "@t3tools/themes";
import { buildThemePickerItems } from "../themePickerItems";

const fakeTheme: ThemeDefinition = {
  id: "fake-sixth-theme",
  label: "Fake Sixth",
  appearance: "light",
  colors: createManagedThemeColors("light", "#f0f0f0", "#3050d0"),
};

describe("buildThemePickerItems", () => {
  it("renders a future built-in roster without mobile code changes", () => {
    const definitions = [fakeTheme, { ...fakeTheme, id: "another-theme", label: "Another" }];

    expect(buildThemePickerItems(definitions).map((item) => item.id)).toEqual([
      "fake-sixth-theme",
      "another-theme",
    ]);
  });
});
