import { describe, expect, it } from "vite-plus/test";

import { installIntlPolyfillCache } from "./intl-polyfill-cache";

describe("installIntlPolyfillCache", () => {
  it("memoizes Intl constructors, getters, and lookups while preserving spec semantics", () => {
    installIntlPolyfillCache();
    installIntlPolyfillCache();

    const canonical = Intl.getCanonicalLocales("en-us");
    expect(canonical).toEqual(["en-US"]);
    canonical.push("mutated");
    expect(Intl.getCanonicalLocales("en-us")).toEqual(["en-US"]);
    expect(() => Intl.getCanonicalLocales("not_a_valid_tag!!")).toThrow(RangeError);

    expect(Intl.getCanonicalLocales(["en", "fr"])).toEqual(["en", "fr"]);
    expect(() => Intl.getCanonicalLocales(["en\u0000fr"])).toThrow(RangeError);

    let localeReads = 0;
    const getterLocales: string[] = new Array(1);
    Object.defineProperty(getterLocales, 0, {
      enumerable: true,
      get() {
        localeReads += 1;
        return localeReads === 1 ? "en" : "fr";
      },
    });
    expect(Intl.getCanonicalLocales(["en"])).toEqual(["en"]);
    expect(Intl.getCanonicalLocales(getterLocales)).toEqual(["en"]);
    expect(Intl.getCanonicalLocales(getterLocales)).toEqual(["fr"]);
    expect(localeReads).toBe(2);

    const customProtoLocales = Object.setPrototypeOf(["en"], { 1: "fr" }) as string[];
    customProtoLocales.length = 2;
    expect(Intl.getCanonicalLocales(customProtoLocales)).toEqual(["en", "fr"]);
    expect(Intl.getCanonicalLocales(["en"])).toEqual(["en"]);

    const supported = Intl.NumberFormat.supportedLocalesOf(["en-US"]);
    expect(supported).toEqual(["en-US"]);
    supported.push("mutated");
    expect(Intl.NumberFormat.supportedLocalesOf(["en-US"])).toEqual(["en-US"]);

    const l1 = new Intl.Locale("en-US");
    const l2 = new Intl.Locale("en-US");
    expect(l1).toBe(l2);
    expect(l1 instanceof Intl.Locale).toBe(true);
    expect(l1.language).toBe("en");
    expect(l1.language).toBe("en");
    expect(l1.region).toBe("US");
    expect(l1.region).toBe("US");
    expect(l1.script).toBeUndefined();
    expect(l1.script).toBeUndefined();
    expect(l1.baseName).toBe("en-US");
    expect(l1.toString()).toBe("en-US");
    expect(l1.toString()).toBe("en-US");
    expect(new Intl.Locale("en", { region: "GB" }).region).toBe("GB");
    const langGetter = Object.getOwnPropertyDescriptor(Intl.Locale.prototype, "language")?.get;
    expect(() => langGetter?.call({})).toThrow(TypeError);

    // Object tags with overridden toString must not poison string-keyed Locale entries.
    const frLocale = new Intl.Locale("fr", { region: "FR" });
    Object.defineProperty(frLocale, "toString", { value: () => "de" });
    expect(new Intl.Locale(frLocale).language).toBe("fr");
    expect(new Intl.Locale("de").language).toBe("de");

    const pr1 = new Intl.PluralRules("en", { type: "cardinal" });
    const pr2 = new Intl.PluralRules("en", { type: "cardinal" });
    expect(pr1).toBe(pr2);
    expect(pr1 instanceof Intl.PluralRules).toBe(true);
    expect(pr1.select(0)).toBe("other");
    expect(pr1.select(-0)).toBe("other");
    expect(pr1.select(1)).toBe("one");
    expect(pr1.select(2)).toBe("other");
    expect(pr1.select(1)).toBe("one");

    const ru = new Intl.PluralRules("ru", { type: "cardinal" });
    expect(ru.select(1)).toBe("one");
    expect(ru.select(2)).toBe("few");
    expect(ru.select(5)).toBe("many");
    expect(ru.select(21)).toBe("one");

    const dn1 = new Intl.DisplayNames(["en"], { type: "language" });
    const dn2 = new Intl.DisplayNames(["en"], { type: "language" });
    expect(dn1).toBe(dn2);
    expect(dn1 instanceof Intl.DisplayNames).toBe(true);
    expect(dn1.of("en")).toBe("English");
    expect(dn1.of("en")).toBe("English");
    expect(dn1.of("fr")).toBe("French");
    expect(Intl.DisplayNames.supportedLocalesOf(["en"])).toEqual(["en"]);

    // Non-enumerable options, option getters, and delimiter-shaped keys/locales stay isolated.
    const nonEnumOptions = { type: "language" } as Intl.DisplayNamesOptions;
    Object.defineProperty(nonEnumOptions, "style", { value: "short", enumerable: false });
    expect(new Intl.DisplayNames(["en"], nonEnumOptions).resolvedOptions().style).toBe("short");

    let getterReads = 0;
    const getterOptions = {
      get type(): Intl.DisplayNamesType {
        getterReads += 1;
        return getterReads === 1 ? "language" : "region";
      },
    };
    expect(new Intl.DisplayNames(["en"], getterOptions).resolvedOptions().type).toBe("language");
    expect(getterReads).toBe(1);

    const dnShort = new Intl.DisplayNames("en", { style: "short", type: "language" });
    expect(dnShort.resolvedOptions().style).toBe("short");
    expect(
      () =>
        new Intl.DisplayNames("en", {
          "style=s:short|type": "language",
        } as unknown as Intl.DisplayNamesOptions),
    ).toThrow(TypeError);
    expect(
      () =>
        new Intl.DisplayNames("en\u0001type=s:language", {
          type: "language",
        }),
    ).toThrow(RangeError);

    const nf1 = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
    const nf2 = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
    expect(nf1).toBe(nf2);
    expect(nf1.format(12.34)).toBe("12.3");

    const dtf1 = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    });
    const dtf2 = new Intl.DateTimeFormat("en-US", {
      minute: "2-digit",
      timeZone: "UTC",
      hour: "numeric",
    });
    expect(dtf1).toBe(dtf2);
    expect(dtf1 instanceof Intl.DateTimeFormat).toBe(true);

    const implicit1 = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
    const implicit2 = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
    expect(implicit1).not.toBe(implicit2);
  });
});
