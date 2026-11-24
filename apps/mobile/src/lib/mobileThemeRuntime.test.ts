import { describe, expect, it } from "vite-plus/test";

import {
  createMobileThemeRuntimeOperations,
  type MobileThemeRuntimeState,
} from "./mobileThemeRuntime";

const initialState: MobileThemeRuntimeState = {
  baseFontSize: 16,
  useMonospaceFont: false,
  platformOS: "ios",
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

  it("updates Uniwind font family variables when useMonospaceFont toggles", () => {
    const enabled = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      useMonospaceFont: true,
    });
    expect(enabled.length).toBeGreaterThan(0);
    const firstEnabled = enabled[0];
    expect(firstEnabled?.kind).toBe("update-text-variables");
    if (firstEnabled?.kind === "update-text-variables") {
      expect(firstEnabled.variables["--font-sans"]).toBe("ui-monospace");
      expect(firstEnabled.variables["--font-medium"]).toBe("ui-monospace");
      expect(firstEnabled.variables["--font-bold"]).toBe("ui-monospace");
    }

    const disabled = createMobileThemeRuntimeOperations(
      { ...initialState, useMonospaceFont: true },
      initialState,
    );
    const firstDisabled = disabled[0];
    expect(firstDisabled?.kind).toBe("update-text-variables");
    if (firstDisabled?.kind === "update-text-variables") {
      expect(firstDisabled.variables["--font-sans"]).toBe("DMSans-Regular");
      expect(firstDisabled.variables["--font-medium"]).toBe("DMSans-Medium");
      expect(firstDisabled.variables["--font-bold"]).toBe("DMSans-Bold");
    }
  });
});
