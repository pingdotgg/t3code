import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { formatCurrency, formatCurrencyCompact } from "@t3tools/shared/usageFormat";

import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import {
  __resetUsageCurrencyRatesFetchForTests,
  convertFromUsd,
  fetchUsageCurrencyRates,
  getUsdRate,
  ratesNeedRefresh,
  readStoredUsageCurrencyRates,
  refreshUsageCurrencyRatesIfNeeded,
  USAGE_CURRENCY_RATES_ATTEMPT_STORAGE_KEY,
  USAGE_CURRENCY_RATES_STORAGE_KEY,
  USAGE_CURRENCY_RATES_TTL_MS,
  USAGE_CURRENCY_STORAGE_KEY,
  UsageCurrencyRatesFetchError,
  writeStoredUsageCurrencyRates,
  type UsageCurrencyRatesCache,
} from "./usageCurrencies";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

async function loadUsageCurrencies(storage: Storage) {
  vi.resetModules();
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
  return import("./usageCurrencies");
}

describe("convertFromUsd", () => {
  it("leaves USD amounts unchanged", () => {
    expect(convertFromUsd(12.5, "USD", { EUR: 0.9 })).toBe(12.5);
  });

  it("multiplies by the quote rate", () => {
    expect(convertFromUsd(10, "EUR", { EUR: 0.86 })).toBeCloseTo(8.6);
  });

  it("returns null when the quote is missing", () => {
    expect(convertFromUsd(10, "JPY", {})).toBeNull();
  });
});

describe("getUsdRate", () => {
  it("returns 1 for USD", () => {
    expect(getUsdRate("USD", { EUR: 0.9 })).toBe(1);
  });

  it("returns the cached quote rate", () => {
    expect(getUsdRate("GBP", { GBP: 0.74 })).toBe(0.74);
  });

  it("returns null when the quote is missing", () => {
    expect(getUsdRate("JPY", {})).toBeNull();
  });
});

describe("ratesNeedRefresh", () => {
  it("refreshes when nothing is cached", () => {
    expect(ratesNeedRefresh(null)).toBe(true);
  });

  it("skips a second fetch within 24 hours", () => {
    const now = new Date("2026-08-09T12:00:00");
    const cache: UsageCurrencyRatesCache = {
      fetchedAt: now.getTime() - USAGE_CURRENCY_RATES_TTL_MS + 1,
      date: "2026-08-08",
      rates: { USD: 1, EUR: 0.86 },
    };
    expect(ratesNeedRefresh(cache, now)).toBe(false);
  });

  it("refreshes after 24 hours", () => {
    const now = new Date("2026-08-09T12:00:00");
    const cache: UsageCurrencyRatesCache = {
      fetchedAt: now.getTime() - USAGE_CURRENCY_RATES_TTL_MS,
      date: "2020-01-01",
      rates: { USD: 1 },
    };
    expect(ratesNeedRefresh(cache, now)).toBe(true);
  });

  it("refreshes when fetchedAt is in the future", () => {
    const now = new Date("2026-08-09T12:00:00");
    const cache: UsageCurrencyRatesCache = {
      fetchedAt: now.getTime() + 60_000,
      date: "2026-08-09",
      rates: { USD: 1, EUR: 0.86 },
    };
    expect(ratesNeedRefresh(cache, now)).toBe(true);
  });
});

describe("formatCurrency", () => {
  it("formats USD with a dollar sign", () => {
    expect(formatCurrency(12.5, "USD")).toBe("$12.50");
  });

  it("formats EUR with a euro sign", () => {
    expect(formatCurrency(8.6, "EUR")).toBe("€8.60");
  });

  it("formats zero-decimal currencies without cents", () => {
    expect(formatCurrency(1234, "JPY")).toBe("¥1,234");
    expect(formatCurrency(1234, "KRW")).toBe("₩1,234");
  });

  it("rounds unscaled zero-decimal currency amounts to whole units", () => {
    expect(formatCurrencyCompact(12.5, "JPY")).toBe("¥13");
    expect(formatCurrencyCompact(12.5, "KRW")).toBe("₩13");
    expect(formatCurrencyCompact(1234.56, "JPY")).toBe("¥1.2K");
    expect(formatCurrencyCompact(1234.56, "KRW")).toBe("₩1.2K");
  });

  it("keeps compact zero-decimal significands distinguishable", () => {
    expect(formatCurrencyCompact(1500, "JPY")).toBe("¥1.5K");
    expect(formatCurrencyCompact(1500, "JPY")).not.toBe(formatCurrencyCompact(2000, "JPY"));
    expect(formatCurrencyCompact(1500, "KRW")).toBe("₩1.5K");
    expect(formatCurrencyCompact(1500, "KRW")).not.toBe(formatCurrencyCompact(2000, "KRW"));
  });

  it("compacts large currency amounts for chart axes", () => {
    expect(formatCurrencyCompact(2_395_896, "BIF")).toMatch(/BIF\s*2\.4M/i);
  });

  it("keeps sub-unit compact labels distinguishable", () => {
    // Regression: one fraction digit collapsed every cent-scale amount to "$0".
    expect(formatCurrencyCompact(0.01, "USD")).toBe("$0.01");
    expect(formatCurrencyCompact(0.04, "USD")).toBe("$0.04");
    expect(formatCurrencyCompact(0.01, "USD")).not.toBe(formatCurrencyCompact(0.04, "USD"));
  });
});

describe("usage currency rates persistence", () => {
  afterEach(() => {
    removeLocalStorageItem(USAGE_CURRENCY_RATES_STORAGE_KEY);
    removeLocalStorageItem(USAGE_CURRENCY_RATES_ATTEMPT_STORAGE_KEY);
    removeLocalStorageItem(USAGE_CURRENCY_STORAGE_KEY);
    __resetUsageCurrencyRatesFetchForTests();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reuses a cache written within 24 hours without needing a refresh", () => {
    const now = new Date("2026-08-09T12:00:00");
    const cache: UsageCurrencyRatesCache = {
      fetchedAt: now.getTime() - 60_000,
      date: "2026-08-08",
      rates: { USD: 1, EUR: 0.86, GBP: 0.74 },
    };
    writeStoredUsageCurrencyRates(cache);

    const stored = readStoredUsageCurrencyRates();
    expect(stored).toEqual(cache);
    expect(ratesNeedRefresh(stored, now)).toBe(false);
  });

  it("returns null when stored rates are corrupt", async () => {
    const storage = createStorage({
      getItem: () => "{not-json",
    });
    const { readStoredUsageCurrencyRates: readRates } = await loadUsageCurrencies(storage);
    expect(readRates()).toBeNull();
  });

  it("returns null when stored rates fail the schema", async () => {
    const storage = createStorage({
      getItem: () => JSON.stringify({ fetchedAt: "2026-08-08", rates: { EUR: "nope" } }),
    });
    const { readStoredUsageCurrencyRates: readRates } = await loadUsageCurrencies(storage);
    expect(readRates()).toBeNull();
  });

  it("falls back to USD when the stored currency is corrupt", async () => {
    const storage = createStorage({
      getItem: () => "{not-json",
    });
    const { readStoredUsageCurrency: readCurrency } = await loadUsageCurrencies(storage);
    expect(readCurrency()).toBe("USD");
  });

  it("falls back to USD when the stored currency is not supported", async () => {
    const storage = createStorage({
      getItem: () => JSON.stringify("XYZ"),
    });
    const { readStoredUsageCurrency: readCurrency } = await loadUsageCurrencies(storage);
    expect(readCurrency()).toBe("USD");
  });
});

describe("fetchUsageCurrencyRates", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reshapes a Frankfurter payload into a cache document", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json([
        { date: "2026-08-08", base: "USD", quote: "EUR", rate: 0.86 },
        { date: "2026-08-08", base: "USD", quote: "GBP", rate: 0.74 },
        { date: "2026-08-08", base: "USD", quote: "ZZZ", rate: 9 },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date("2026-08-09T12:00:00");
    const cache = await fetchUsageCurrencyRates(now);
    expect(cache).toEqual({
      fetchedAt: now.getTime(),
      date: "2026-08-08",
      rates: { USD: 1, EUR: 0.86, GBP: 0.74 },
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("base=USD");
  });

  it("ignores rates whose base currency is not USD", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json([
          { date: "2026-08-08", base: "USD", quote: "GBP", rate: 0.74 },
          { date: "2026-08-09", base: "EUR", quote: "GBP", rate: 0.86 },
        ]),
      ),
    );

    const cache = await fetchUsageCurrencyRates(new Date("2026-08-09T12:00:00"));
    expect(cache).toMatchObject({
      date: "2026-08-08",
      rates: { USD: 1, GBP: 0.74 },
    });
  });

  it("throws when the network request fails", async () => {
    const offline = new Error("offline");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(offline));

    const error = await fetchUsageCurrencyRates().catch((cause) => cause);
    expect(error).toBeInstanceOf(UsageCurrencyRatesFetchError);
    expect(error).toMatchObject({
      _tag: "UsageCurrencyRatesFetchError",
      stage: "request",
      cause: offline,
      message: "Frankfurter rates request step failed.",
    });
  });

  it("throws when Frankfurter responds with a non-OK status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 503 })));

    const error = await fetchUsageCurrencyRates().catch((cause) => cause);
    expect(error).toBeInstanceOf(UsageCurrencyRatesFetchError);
    expect(error).toMatchObject({
      _tag: "UsageCurrencyRatesFetchError",
      stage: "status",
      status: 503,
      message: "Frankfurter rates request failed (503).",
    });
  });

  it("throws when the response body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));

    const error = await fetchUsageCurrencyRates().catch((cause) => cause);
    expect(error).toBeInstanceOf(UsageCurrencyRatesFetchError);
    expect(error).toMatchObject({
      _tag: "UsageCurrencyRatesFetchError",
      stage: "json",
      message: "Frankfurter rates json step failed.",
    });
    expect(error.cause).toBeDefined();
  });

  it("throws when the response shape is unexpected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ rates: { EUR: 0.9 } })));

    const error = await fetchUsageCurrencyRates().catch((cause) => cause);
    expect(error).toBeInstanceOf(UsageCurrencyRatesFetchError);
    expect(error).toMatchObject({
      _tag: "UsageCurrencyRatesFetchError",
      stage: "decode",
      message: "Frankfurter rates decode step failed.",
    });
    expect(error.cause).toBeDefined();
  });
});

describe("refreshUsageCurrencyRatesIfNeeded", () => {
  afterEach(() => {
    removeLocalStorageItem(USAGE_CURRENCY_RATES_STORAGE_KEY);
    removeLocalStorageItem(USAGE_CURRENCY_RATES_ATTEMPT_STORAGE_KEY);
    __resetUsageCurrencyRatesFetchForTests();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns null and leaves a stale cache alone when fetch fails", async () => {
    const stale: UsageCurrencyRatesCache = {
      fetchedAt: new Date("2020-01-01").getTime(),
      date: "2020-01-01",
      rates: { USD: 1, EUR: 0.5 },
    };
    writeStoredUsageCurrencyRates(stale);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(refreshUsageCurrencyRatesIfNeeded()).resolves.toBeNull();
    expect(readStoredUsageCurrencyRates()).toEqual(stale);
    expect(errorSpy).toHaveBeenCalledWith(
      "[usage-currency] Failed to refresh FX rates.",
      expect.any(Error),
    );
  });

  it("does not retry a failed request again within 24 hours", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date("2026-08-09T12:00:00");
    await expect(refreshUsageCurrencyRatesIfNeeded(now)).resolves.toBeNull();
    await expect(
      refreshUsageCurrencyRatesIfNeeded(new Date(now.getTime() + 60_000)),
    ).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("retries a failed request after 24 hours", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    const first = new Date("2026-08-09T12:00:00");
    await expect(refreshUsageCurrencyRatesIfNeeded(first)).resolves.toBeNull();
    await expect(
      refreshUsageCurrencyRatesIfNeeded(new Date(first.getTime() + USAGE_CURRENCY_RATES_TTL_MS)),
    ).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("remembers a failed attempt across module reloads", async () => {
    const storage = createStorage();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date("2026-08-09T12:00:00");
    const firstModule = await loadUsageCurrencies(storage);
    await expect(firstModule.refreshUsageCurrencyRatesIfNeeded(now)).resolves.toBeNull();

    const reloadedModule = await loadUsageCurrencies(storage);
    await expect(reloadedModule.refreshUsageCurrencyRatesIfNeeded(now)).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("does not persist the attempt when the fetched rates fail to persist", async () => {
    const storage = createStorage();
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      if (key === USAGE_CURRENCY_RATES_STORAGE_KEY) throw new Error("quota exceeded");
      setItem(key, value);
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        Response.json([{ date: "2026-08-08", base: "USD", quote: "EUR", rate: 0.86 }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date("2026-08-09T12:00:00");
    const firstModule = await loadUsageCurrencies(storage);
    await expect(firstModule.refreshUsageCurrencyRatesIfNeeded(now)).resolves.toMatchObject({
      rates: { USD: 1, EUR: 0.86 },
    });
    expect(storage.getItem(USAGE_CURRENCY_RATES_ATTEMPT_STORAGE_KEY)).toBeNull();

    const reloadedModule = await loadUsageCurrencies(storage);
    await expect(reloadedModule.refreshUsageCurrencyRatesIfNeeded(now)).resolves.toMatchObject({
      rates: { USD: 1, EUR: 0.86 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("still returns fetched rates when persisting them fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = createStorage({
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });
    const { refreshUsageCurrencyRatesIfNeeded: refresh } = await loadUsageCurrencies(storage);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json([{ date: "2026-08-08", base: "USD", quote: "EUR", rate: 0.86 }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date("2026-08-09T12:00:00");
    const next = await refresh(now);
    expect(next).toEqual({
      fetchedAt: now.getTime(),
      date: "2026-08-08",
      rates: { USD: 1, EUR: 0.86 },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[usage-currency] Failed to persist FX rates.",
      expect.anything(),
    );

    await expect(refresh(now)).resolves.toEqual(next);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry in the same runtime when attempt persistence fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = createStorage({
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });
    const { refreshUsageCurrencyRatesIfNeeded: refresh } = await loadUsageCurrencies(storage);
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    const now = new Date("2026-08-09T12:00:00");
    await expect(refresh(now)).resolves.toBeNull();
    await expect(refresh(now)).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      "[usage-currency] Failed to persist the FX refresh attempt.",
      expect.anything(),
    );
  });

  it("skips the network when a fresh cache is already present", async () => {
    const now = new Date("2026-08-09T12:00:00");
    const cache: UsageCurrencyRatesCache = {
      fetchedAt: now.getTime() - 60_000,
      date: "2026-08-08",
      rates: { USD: 1, EUR: 0.86 },
    };
    writeStoredUsageCurrencyRates(cache);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshUsageCurrencyRatesIfNeeded(now)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
