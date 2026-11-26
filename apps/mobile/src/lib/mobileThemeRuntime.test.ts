import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import {
  createMobileThemeRuntimeOperations,
  type MobileThemeRuntimeState,
} from "./mobileThemeRuntime";

const initialState: MobileThemeRuntimeState = {
  baseFontSize: 16,
  fontId: "dm-sans",
  monoFontId: "system",
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

  it("swaps the font family variables when the font changes", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      fontId: "system",
    });

    expect(operations[0]).toMatchObject({
      kind: "update-text-variables",
      variables: { "--font-sans": "System", "--font-medium": "System", "--font-bold": "System" },
    });
  });

  it("swaps the mono family variable when the mono font changes", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      monoFontId: "meslo",
    });

    expect(operations[0]).toMatchObject({
      kind: "update-text-variables",
      variables: { "--font-mono": "MesloLGS-NF-Regular" },
    });
  });
});
