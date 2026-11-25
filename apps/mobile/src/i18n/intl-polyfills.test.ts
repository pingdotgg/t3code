import { describe, expect, it } from "vite-plus/test";

import "./intl-polyfills";

describe("shared plural rules", () => {
  it("builds one instance for equal arguments", () => {
    const cardinal = new Intl.PluralRules("en");

    expect(new Intl.PluralRules("en")).toBe(cardinal);
    expect(new Intl.PluralRules("en", { type: "ordinal" })).not.toBe(cardinal);
    expect(new Intl.PluralRules("de")).not.toBe(cardinal);
  });

  it("selects the same categories as an unshared instance", () => {
    expect(new Intl.PluralRules("en").select(1)).toBe("one");
    expect(new Intl.PluralRules("en").select(2)).toBe("other");
    expect(new Intl.PluralRules("en", { type: "ordinal" }).select(2)).toBe("two");
    expect(new Intl.PluralRules("en")).toBeInstanceOf(Intl.PluralRules);
  });
});
