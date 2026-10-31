import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import {
  createUsageCurrencyStore,
  isUsageCurrencyCode,
  parseStoredRates,
  toUsageCurrency,
  type UsageCurrency,
} from "@t3tools/shared/usageCurrency";

const PREFERENCE_KEY = "t3code:usage-currency:v1";
const RATES_KEY = "t3code:usage-currency-rates:v1";

function logStorageFailure(action: string, error: unknown): void {
  console.warn(`Could not ${action} the usage currency.`, error);
}

const store = createUsageCurrencyStore({
  code: null,
  rates: null,
  saveCode: (code) => {
    AsyncStorage.setItem(PREFERENCE_KEY, code).catch((error: unknown) =>
      logStorageFailure("save", error),
    );
  },
  saveRates: (rates) => {
    AsyncStorage.setItem(RATES_KEY, JSON.stringify(rates)).catch((error: unknown) =>
      logStorageFailure("save", error),
    );
  },
});

// AsyncStorage is asynchronous, so the store starts on USD and catches up once storage answers.
AsyncStorage.getMany([PREFERENCE_KEY, RATES_KEY])
  .then((stored) => {
    const code = stored[PREFERENCE_KEY];
    const rates = stored[RATES_KEY];
    store.hydrate({
      code: isUsageCurrencyCode(code) ? code : null,
      rates: rates == null ? null : parseStoredRates(JSON.parse(rates)),
    });
  })
  .catch((error: unknown) => logStorageFailure("read", error));

export function useUsageCurrency(): UsageCurrency {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return toUsageCurrency(state, store.setCurrency);
}
