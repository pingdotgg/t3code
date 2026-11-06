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
});
