/**
 * Selected usage display currency and FX rates.
 *
 * Rates and the selected currency live in localStorage. Opening the app reuses
 * the cached table; Frankfurter is contacted at most once per 24 hours.
 *
 * @module useUsageCurrency
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { formatCurrency, formatCurrencyCompact } from "@t3tools/shared/usageFormat";

import { useLocalStorage } from "./useLocalStorage";
import {
  convertFromUsd,
  getUsdRate,
  readStoredUsageCurrencyRates,
  refreshUsageCurrencyRatesIfNeeded,
  USAGE_CURRENCY_RATES_STORAGE_KEY,
  USAGE_CURRENCY_STORAGE_KEY,
  UsageCurrencyCodeSchema,
  type UsageCurrencyCode,
  type UsageCurrencyRatesCache,
} from "../usage/usageCurrencies";

const FALLBACK_RATES: UsageCurrencyRatesCache = {
  fetchedAt: 0,
  date: "",
  rates: { USD: 1 },
};

function loadRatesCache(): UsageCurrencyRatesCache {
  return readStoredUsageCurrencyRates() ?? FALLBACK_RATES;
}

/**
 * Persists the user's currency choice and refreshes Frankfurter USD rates at
 * most once per 24 hours.
 */
export function useUsageCurrency() {
  const [currency, setCurrency] = useLocalStorage(
    USAGE_CURRENCY_STORAGE_KEY,
    "USD" as UsageCurrencyCode,
    UsageCurrencyCodeSchema,
  );
  // Seed from localStorage synchronously so a reopen never flashes empty rates
  // or triggers a redundant network call before React state catches up.
  const [ratesCache, setRatesCache] = useState(loadRatesCache);

  useEffect(() => {
    let cancelled = false;
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== USAGE_CURRENCY_RATES_STORAGE_KEY) return;
      const next = readStoredUsageCurrencyRates();
      if (next !== null) setRatesCache(next);
    };

    window.addEventListener("storage", handleStorage);

    void refreshUsageCurrencyRatesIfNeeded().then((next) => {
      if (cancelled || next === null) return;
      setRatesCache(next);
    });

    return () => {
      cancelled = true;
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const rates = ratesCache.rates;
  const rate = getUsdRate(currency, rates);

  const formatCost = useCallback(
    (amountUsd: number) => {
      const converted = convertFromUsd(amountUsd, currency, rates);
      return converted === null
        ? formatCurrency(amountUsd, "USD")
        : formatCurrency(converted, currency);
    },
    [currency, rates],
  );

  const formatCostCompact = useCallback(
    (amountUsd: number) => {
      const converted = convertFromUsd(amountUsd, currency, rates);
      return converted === null
        ? formatCurrencyCompact(amountUsd, "USD")
        : formatCurrencyCompact(converted, currency);
    },
    [currency, rates],
  );

  return useMemo(
    () => ({
      currency,
      setCurrency,
      rate,
      rates,
      formatCost,
      formatCostCompact,
    }),
    [currency, formatCost, formatCostCompact, rate, rates, setCurrency],
  );
}
