import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import {
  USAGE_CURRENCY_CODES,
  createUsageCurrencyStore,
  toUsageCurrency,
  type UsageCurrency,
} from "@t3tools/shared/usageCurrency";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

export { USAGE_CURRENCIES, isUsageCurrencyCode } from "@t3tools/shared/usageCurrency";

const PREFERENCE_KEY = "t3code:usage-currency:v1";
const RATES_KEY = "t3code:usage-currency-rates:v1";

const PreferenceSchema = Schema.Struct({ code: Schema.Literals(USAGE_CURRENCY_CODES) });
const RatesSchema = Schema.Struct({
  fetchedAt: Schema.Number,
  asOf: Schema.String,
  rates: Schema.Record(Schema.String, Schema.Number),
});

function readStored<T, E>(key: string, schema: Schema.Codec<T, E>): T | null {
  try {
    return getLocalStorageItem(key, schema);
  } catch (error) {
    console.error(`Could not read ${key}.`, error);
    return null;
  }
}

function writeStored<T, E>(key: string, value: T, schema: Schema.Codec<T, E>): void {
  try {
    setLocalStorageItem(key, value, schema);
  } catch (error) {
    console.error(`Could not save ${key}.`, error);
  }
}

const store = createUsageCurrencyStore({
  code: readStored(PREFERENCE_KEY, PreferenceSchema)?.code ?? null,
  rates: readStored(RATES_KEY, RatesSchema),
  saveCode: (code) => writeStored(PREFERENCE_KEY, { code }, PreferenceSchema),
  saveRates: (rates) => writeStored(RATES_KEY, rates, RatesSchema),
});

export function useUsageCurrency(): UsageCurrency {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return toUsageCurrency(state, store.setCurrency);
}
