import { describe, expect, it } from "vite-plus/test";

import { readDefaultMobileThemeVariables } from "./mobileTheme.test-support";
import { getMobileThemeVariables, MOBILE_THEME_IDS, themeColorWithAlpha } from "./mobileTheme";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";

describe("mobile theme runtime variables", () => {
  it("derives the standard runtime palette from global.css", () => {
    expect(getMobileThemeRuntimeVariables("t3-code", "light")).toEqual(
      readDefaultMobileThemeVariables("light"),
    );
    expect(getMobileThemeRuntimeVariables("t3-code", "dark")).toEqual(
      readDefaultMobileThemeVariables("dark"),
    );
  });

  it("uses the same shared palette source as generated custom themes", () => {
    expect(getMobileThemeRuntimeVariables("ocean", "light")).toEqual(
      getMobileThemeVariables("ocean", "light"),
    );
    expect(getMobileThemeRuntimeVariables("iris", "dark")).toEqual(
      getMobileThemeVariables("iris", "dark"),
    );
  });

  it.each(MOBILE_THEME_IDS)(
    "keeps %s colors except for an opaque Material layout frame",
    (themeId) => {
      for (const appearance of ["light", "dark"] as const) {
        const stock = getMobileThemeRuntimeVariables(themeId, appearance);
        const rounded = getMobileThemeRuntimeVariables(themeId, appearance, true);
        expect(rounded).toEqual({
          ...stock,
          "--color-header": themeColorWithAlpha(
            stock[
              themeId === "t3-code" || themeId === "material-you"
                ? "--color-card"
                : "--color-drawer"
            ],
            1,
          ),
        });
        expect(rounded["--color-header"]).toMatch(/^rgba\(\d+, \d+, \d+, 1\)$/);
        expect(getMobileThemeRuntimeVariables(themeId, appearance, false)).toEqual(stock);
      }
    },
  );

  it.each(["t3-code", "material-you"] as const)(
    "keeps the %s default dark frame distinct from the rounded settings body",
    (themeId) => {
      const variables = getMobileThemeRuntimeVariables(themeId, "dark", true);
      expect(variables["--color-header"]).toBe("rgba(23, 23, 23, 1)");
      expect(variables["--color-header"]).not.toBe(
        themeColorWithAlpha(variables["--color-sheet-solid"], 1),
      );
    },
  );
});
