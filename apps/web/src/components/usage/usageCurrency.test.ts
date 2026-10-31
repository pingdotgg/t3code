import { describe, expect, it } from "vite-plus/test";

import {
  convertUsd,
  formatUsdIn,
  isUsageCurrencyCode,
  resolveUsageCurrency,
  USAGE_CURRENCIES,
} from "./usageCurrency";

const rates = { fetchedAt: 0, asOf: "2026-10-30", rates: { DKK: 6.9, EUR: 0.93 } };

describe("usage currency", () => {
  it("keeps USD as the identity", () => {
    const state = resolveUsageCurrency("USD", null, "idle");
    expect(state).toMatchObject({ code: "USD", rate: 1 });
    expect(formatUsdIn(12.5, state)).toBe("$12.50");
  });

  it("converts into the selected currency once a rate is known", () => {
    const state = resolveUsageCurrency("DKK", rates, "ready");
    expect(state).toMatchObject({ selected: "DKK", code: "DKK", rate: 6.9, asOf: "2026-10-30" });
    expect(convertUsd(10, state)).toBeCloseTo(69);
    expect(formatUsdIn(10, state)).toContain("kr");
  });

  it("falls back to USD while the rate is missing instead of mislabelling dollars", () => {
    expect(resolveUsageCurrency("DKK", null, "loading")).toMatchObject({
      selected: "DKK",
      code: "USD",
      rate: 1,
    });
    expect(resolveUsageCurrency("GBP", rates, "ready").code).toBe("USD");
  });

  it("rejects unknown currency codes", () => {
    expect(isUsageCurrencyCode("DKK")).toBe(true);
    expect(isUsageCurrencyCode("XYZ")).toBe(false);
  });

  it("offers every supported currency with USD and DKK first", () => {
    expect(USAGE_CURRENCIES).toHaveLength(30);
    expect(USAGE_CURRENCIES.slice(0, 2).map((currency) => currency.code)).toEqual(["USD", "DKK"]);
    expect(new Set(USAGE_CURRENCIES.map((currency) => currency.code)).size).toBe(30);
  });

  it("uses each currency's own decimals", () => {
    const yen = resolveUsageCurrency("JPY", { ...rates, rates: { JPY: 157.25 } }, "ready");
    expect(formatUsdIn(1, yen)).toMatch(/157$/);
  });
});
