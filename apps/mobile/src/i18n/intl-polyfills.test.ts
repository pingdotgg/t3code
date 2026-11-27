import { describe, expect, it } from "vite-plus/test";

import "./intl-polyfills";

describe("shared plural rules", () => {
  it("builds one instance for equal arguments", () => {
    const cardinal = new Intl.PluralRules("en");

    expect(new Intl.PluralRules("en")).toBe(cardinal);
    expect(new Intl.PluralRules(["en"])).toBe(cardinal);
    expect(new Intl.PluralRules("en", { type: "ordinal" })).not.toBe(cardinal);
    expect(new Intl.PluralRules("de")).not.toBe(cardinal);
  });

  it("selects the same categories as an unshared instance", () => {
    expect(new Intl.PluralRules("en").select(1)).toBe("one");
    expect(new Intl.PluralRules("en").select(2)).toBe("other");
    expect(new Intl.PluralRules("en", { type: "ordinal" }).select(2)).toBe("two");
    expect(new Intl.PluralRules("en")).toBeInstanceOf(Intl.PluralRules);
  });

  it("does not share arguments a key cannot describe", () => {
    const plain = new Intl.PluralRules("en", {});
    const inherited: Intl.PluralRulesOptions = Object.create({ type: "ordinal" });
    expect(new Intl.PluralRules("en", inherited)).not.toBe(plain);
    expect(new Intl.PluralRules("en", inherited).select(2)).toBe("two");

    const hidden = Object.defineProperty({}, "type", { value: "ordinal" });
    expect(new Intl.PluralRules("en", hidden).select(2)).toBe("two");
    const getter = {
      get type() {
        return "ordinal" as const;
      },
    };
    expect(new Intl.PluralRules("en", getter).select(2)).toBe("two");

    expect(new Intl.PluralRules(new Intl.Locale("ru")).select(2)).toBe("few");
    expect(new Intl.PluralRules(new Intl.Locale("en")).select(2)).toBe("other");
    expect(new Intl.PluralRules()).not.toBe(new Intl.PluralRules());
  });

  it("builds a subclass as the subclass", () => {
    class Rules extends Intl.PluralRules {}

    expect(new Rules("en")).toBeInstanceOf(Rules);
    expect(new Intl.PluralRules("en")).not.toBeInstanceOf(Rules);
  });
});
