import { describe, expect, it } from "vite-plus/test";

import { standaloneThemeMigration } from "./standaloneThemeMigration";

describe("standaloneThemeMigration", () => {
  it.each([
    ["system", false, "adopt"],
    ["light", false, "adopt"],
    ["dark", false, "adopt"],
    ["system", true, "record"],
    ["grove", false, "record"],
    ["my-imported-theme", false, "record"],
    ["easydev", false, "record"],
    [null, false, "record"],
  ] as const)("stored %s with halves=%s -> %s", (storedTheme, hasThemeHalves, expected) => {
    expect(
      standaloneThemeMigration({ standalone: true, migrated: false, storedTheme, hasThemeHalves }),
    ).toBe(expected);
  });

  it("does nothing upstream or once it has run", () => {
    const stock = { storedTheme: "dark", hasThemeHalves: false };
    expect(standaloneThemeMigration({ ...stock, standalone: false, migrated: false })).toBeNull();
    expect(standaloneThemeMigration({ ...stock, standalone: true, migrated: true })).toBeNull();
  });
});
