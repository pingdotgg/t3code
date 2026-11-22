import { describe, expect, it } from "vite-plus/test";

import {
  createMobileThemeRuntimeOperations,
  type MobileThemeRuntimeState,
} from "./mobileThemeRuntime";

const initialState: MobileThemeRuntimeState = {
  baseFontSize: 16,
  themeAppearance: "light",
  themeMode: "system",
};

describe("mobileThemeRuntime", () => {
  it("lets system appearance changes flow through the root ScopedTheme only", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      themeAppearance: "dark",
    });

    expect(operations).toEqual([]);
  });

  it("sends the build's font families with the text scale on every theme", () => {
    const fonts = { "--font-sans": "Inter-Regular" };
    const initial = createMobileThemeRuntimeOperations(null, initialState, fonts);
    const textUpdates = initial.filter((operation) => operation.kind === "update-text-variables");

    expect(textUpdates.length).toBeGreaterThan(2);
    for (const operation of textUpdates) {
      expect(operation.variables).toMatchObject({ "--font-sans": "Inter-Regular" });
    }
    expect(createMobileThemeRuntimeOperations(initialState, initialState, fonts)).toEqual([]);
  });
});
