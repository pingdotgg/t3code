import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_THEME_IDS } from "@t3tools/shared/themePalettes";

import {
  createMobileThemeRuntimeOperations,
  getMobileUniwindThemeName,
  type MobileThemeRuntimeState,
} from "./mobileThemeRuntime";

const initialState: MobileThemeRuntimeState = {
  baseFontSize: 16,
  themeAppearance: "light",
  themeMode: "system",
};

describe("mobileThemeRuntime", () => {
  it("keeps the default palette on Uniwind's built-in appearance themes", () => {
    expect(getMobileUniwindThemeName("t3-code", "light")).toBe("light");
    expect(getMobileUniwindThemeName("t3-code", "dark")).toBe("dark");
  });

  it("maps custom palettes and appearances to registered themes", () => {
    expect(getMobileUniwindThemeName("t3-chat", "dark")).toBe("t3-chat-dark");
  });

  it("hydrates text variables and clears the native appearance override", () => {
    const operations = createMobileThemeRuntimeOperations(null, initialState);
    const variableOperations = operations.filter(
      (operation) => operation.kind === "update-text-variables",
    );

    expect(variableOperations).toHaveLength(2 + BUILT_IN_THEME_IDS.length * 2);
    expect(variableOperations.at(-1)?.themeName).toBe("absolutely-dark");
    expect(operations.at(-1)).toEqual({
      kind: "set-appearance-mode",
      appearance: "light",
      themeMode: "system",
    });
  });

  it("lets system appearance changes flow through the root ScopedTheme only", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      themeAppearance: "dark",
    });

    expect(operations).toEqual([]);
  });

  it("updates native appearance once when the selected mode changes", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      themeAppearance: "dark",
      themeMode: "dark",
    });

    expect(operations).toEqual([
      {
        kind: "set-appearance-mode",
        appearance: "dark",
        themeMode: "dark",
      },
    ]);
  });

  it("updates text variables for every theme without switching palettes", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      baseFontSize: 18,
    });

    expect(operations).toHaveLength(2 + BUILT_IN_THEME_IDS.length * 2);
    expect(operations.every((operation) => operation.kind === "update-text-variables")).toBe(true);
    expect(operations.at(-1)).toMatchObject({
      kind: "update-text-variables",
      themeName: "absolutely-dark",
    });
  });

  it("uses Absolutely's measured text scale while preserving other themes", () => {
    const operations = createMobileThemeRuntimeOperations(null, initialState);
    const absolutely = operations.find(
      (operation) =>
        operation.kind === "update-text-variables" && operation.themeName === "absolutely-light",
    );
    const grove = operations.find(
      (operation) =>
        operation.kind === "update-text-variables" && operation.themeName === "grove-light",
    );
    expect(absolutely).toMatchObject({
      variables: {
        "--text-base": 15,
        "--text-base--line-height": 21,
        "--text-sm--line-height": 21,
      },
    });
    expect(grove).toMatchObject({
      variables: {
        "--text-base": 16,
        "--text-base--line-height": 23,
        "--text-sm--line-height": 19,
      },
    });
  });

  it("does no native work when persistence echoes an already-applied state", () => {
    expect(createMobileThemeRuntimeOperations(initialState, initialState)).toEqual([]);
  });
});
