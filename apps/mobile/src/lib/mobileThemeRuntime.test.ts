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
});
