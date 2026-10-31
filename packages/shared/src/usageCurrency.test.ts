import { describe, expect, it, vi } from "vite-plus/test";

import {
  convertUsd,
  createUsageCurrencyStore,
  formatUsdIn,
  isUsageCurrencyCode,
  resolveUsageCurrency,
  USAGE_CURRENCIES,
  parseStoredRates,
} from "./usageCurrency.ts";

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

const published = { date: "2026-10-30", rates: { DKK: 6.6895, JPY: 157.25 } };

function makeStore(overrides: Partial<Parameters<typeof createUsageCurrencyStore>[0]> = {}) {
  const saveCode = vi.fn();
  const saveRates = vi.fn();
  const fetchRates = vi.fn(async () => published);
  const store = createUsageCurrencyStore({
    code: null,
    rates: null,
    saveCode,
    saveRates,
    fetchRates,
    now: () => 1_000,
    ...overrides,
  });
  return { store, saveCode, saveRates, fetchRates };
}

// Lets the store's fetch → parse → publish promise chain run to completion.
const settle = async () => {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
};

describe("usage currency store", () => {
  it("does not fetch while USD is selected", async () => {
    const { store, fetchRates } = makeStore();
    store.subscribe(() => {});
    await settle();
    expect(fetchRates).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({ code: "USD", rate: 1 });
  });

  it("fetches, persists and applies rates when a currency is picked", async () => {
    const { store, saveCode, saveRates, fetchRates } = makeStore();
    store.subscribe(() => {});
    store.setCurrency("DKK");
    expect(store.getSnapshot()).toMatchObject({ selected: "DKK", code: "USD", status: "loading" });
    await settle();
    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(saveCode).toHaveBeenCalledWith("DKK");
    expect(saveRates).toHaveBeenCalledWith({
      fetchedAt: 1_000,
      asOf: "2026-10-30",
      rates: published.rates,
    });
    expect(store.getSnapshot()).toMatchObject({ code: "DKK", rate: 6.6895, status: "ready" });
  });

  it("reuses fresh cached rates and refetches stale ones", async () => {
    const fresh = makeStore({ code: "DKK", rates: { ...rates, fetchedAt: 500 } });
    fresh.store.subscribe(() => {});
    await settle();
    expect(fresh.fetchRates).not.toHaveBeenCalled();

    const stale = makeStore({
      code: "DKK",
      rates: { ...rates, fetchedAt: 1_000 - 13 * 60 * 60 * 1000 },
    });
    stale.store.subscribe(() => {});
    await settle();
    expect(stale.fetchRates).toHaveBeenCalledTimes(1);
  });

  it("keeps cached rates when a refresh fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = makeStore({
      code: "DKK",
      rates: { ...rates, fetchedAt: 0 },
      now: () => 1_000 + 13 * 60 * 60 * 1000,
      fetchRates: async () => {
        throw new Error("offline");
      },
    });
    store.subscribe(() => {});
    await settle();
    expect(store.getSnapshot()).toMatchObject({ code: "DKK", rate: 6.9, status: "error" });
    error.mockRestore();
  });

  it("lets a late hydrate fill in storage without overriding a pick", () => {
    const { store } = makeStore({ fetchRates: async () => published });
    store.hydrate({ code: "DKK", rates });
    expect(store.getSnapshot()).toMatchObject({ selected: "DKK", code: "DKK", rate: 6.9 });

    const picked = makeStore();
    picked.store.setCurrency("EUR");
    picked.store.hydrate({ code: "DKK", rates });
    expect(picked.store.getSnapshot().selected).toBe("EUR");
  });
});

describe("stored rates", () => {
  it("drops unusable values", () => {
    expect(parseStoredRates(null)).toBeNull();
    expect(parseStoredRates({ fetchedAt: 1, asOf: "x", rates: {} })).toBeNull();
    expect(parseStoredRates({ fetchedAt: 1, asOf: "x", rates: { DKK: -1, EUR: 0.9 } })).toEqual({
      fetchedAt: 1,
      asOf: "x",
      rates: { EUR: 0.9 },
    });
  });
});
