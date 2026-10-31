// @effect-diagnostics globalDate:off -- Exchange-rate freshness is wall-clock time by nature.
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import { formatMoney } from "@t3tools/shared/usageFormat";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

/** Usage is priced in USD; every other currency is a display-time conversion. */
const BASE_CURRENCY = "USD";

/** Every currency the rate provider (frankfurter.dev, ECB reference rates) publishes, plus USD. */
const SUPPORTED_CODES = [
  "AUD",
  "BRL",
  "CAD",
  "CHF",
  "CNY",
  "CZK",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "ISK",
  "JPY",
  "KRW",
  "MXN",
  "MYR",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "RON",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "USD",
  "ZAR",
] as const;

export type UsageCurrencyCode = (typeof SUPPORTED_CODES)[number];

const CURRENCY_NAMES = new Intl.DisplayNames("en", { type: "currency" });

// USD and DKK lead the list; everything else follows alphabetically.
const PINNED_CODES: readonly UsageCurrencyCode[] = ["USD", "DKK"];

const LOCALE_OVERRIDES: Partial<Record<UsageCurrencyCode, string>> = {
  DKK: "da-DK",
  EUR: "en-IE",
  GBP: "en-GB",
  NOK: "nb-NO",
  SEK: "sv-SE",
};

export const USAGE_CURRENCIES = [
  ...PINNED_CODES,
  ...SUPPORTED_CODES.filter((code) => !PINNED_CODES.includes(code)),
].map((code) => ({
  code,
  label: CURRENCY_NAMES.of(code) ?? code,
  locale: LOCALE_OVERRIDES[code] ?? "en-US",
}));

const CODES = USAGE_CURRENCIES.map((currency) => currency.code);
// Without a `symbols` filter the provider returns every currency it publishes.
const RATES_URL = `https://api.frankfurter.dev/v1/latest?base=${BASE_CURRENCY}`;
const RATES_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const PREFERENCE_KEY = "t3code:usage-currency:v1";
const RATES_KEY = "t3code:usage-currency-rates:v1";

const PreferenceSchema = Schema.Struct({ code: Schema.Literals(SUPPORTED_CODES) });
const RatesSchema = Schema.Struct({
  fetchedAt: Schema.Number,
  /** The publication date of the rates, as reported by the rate provider. */
  asOf: Schema.String,
  rates: Schema.Record(Schema.String, Schema.Number),
});
type StoredRates = typeof RatesSchema.Type;

export type RatesStatus = "idle" | "loading" | "ready" | "error";

export interface UsageCurrencyState {
  /** What the user picked. */
  readonly selected: UsageCurrencyCode;
  /** What is actually shown: falls back to USD while no rate is available. */
  readonly code: UsageCurrencyCode;
  /** USD → `code` multiplier. */
  readonly rate: number;
  readonly status: RatesStatus;
  readonly asOf: string | null;
}

export function isUsageCurrencyCode(value: unknown): value is UsageCurrencyCode {
  return CODES.some((code) => code === value);
}

export function resolveUsageCurrency(
  selected: UsageCurrencyCode,
  stored: StoredRates | null,
  status: RatesStatus,
): UsageCurrencyState {
  const rate = selected === BASE_CURRENCY ? 1 : stored?.rates[selected];
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
    return { selected, code: BASE_CURRENCY, rate: 1, status, asOf: null };
  }
  return { selected, code: selected, rate, status, asOf: stored?.asOf ?? null };
}

export function convertUsd(valueUsd: number, state: Pick<UsageCurrencyState, "rate">): number {
  return valueUsd * state.rate;
}

function localeFor(code: UsageCurrencyCode): string {
  return USAGE_CURRENCIES.find((currency) => currency.code === code)?.locale ?? "en-US";
}

function formatConvertedAmount(amount: number, state: Pick<UsageCurrencyState, "code">): string {
  return formatMoney(amount, state.code, localeFor(state.code));
}

export function formatUsdIn(
  valueUsd: number,
  state: Pick<UsageCurrencyState, "code" | "rate">,
): string {
  return formatConvertedAmount(convertUsd(valueUsd, state), state);
}

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

let selected: UsageCurrencyCode = readStored(PREFERENCE_KEY, PreferenceSchema)?.code ?? "USD";
let storedRates: StoredRates | null = readStored(RATES_KEY, RatesSchema);
let status: RatesStatus = "idle";
let inFlight: Promise<void> | null = null;
let snapshot = resolveUsageCurrency(selected, storedRates, status);
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = resolveUsageCurrency(selected, storedRates, status);
  for (const listener of listeners) listener();
}

function ratesAreFresh(): boolean {
  return storedRates !== null && Date.now() - storedRates.fetchedAt < RATES_MAX_AGE_MS;
}

function parseRates(body: unknown): StoredRates | null {
  if (typeof body !== "object" || body === null) return null;
  const { rates, date } = body as { rates?: unknown; date?: unknown };
  if (typeof rates !== "object" || rates === null || typeof date !== "string") return null;
  const parsed: Record<string, number> = {};
  for (const [code, value] of Object.entries(rates)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) parsed[code] = value;
  }
  if (Object.keys(parsed).length === 0) return null;
  return { fetchedAt: Date.now(), asOf: date, rates: parsed };
}

function ensureRates(): void {
  if (selected === BASE_CURRENCY || inFlight !== null || ratesAreFresh()) return;
  status = "loading";
  publish();
  inFlight = fetch(RATES_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`Rate request failed with ${response.status}.`);
      return response.json() as Promise<unknown>;
    })
    .then((body) => {
      const next = parseRates(body);
      if (next === null) throw new Error("Rate response had no usable rates.");
      storedRates = next;
      writeStored(RATES_KEY, next, RatesSchema);
      status = "ready";
    })
    .catch((error: unknown) => {
      // Keep whatever rates were cached; the picker falls back to USD only if there are none.
      console.error("Could not load exchange rates.", error);
      status = "error";
    })
    .finally(() => {
      inFlight = null;
      publish();
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureRates();
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): UsageCurrencyState {
  return snapshot;
}

function setUsageCurrency(code: UsageCurrencyCode): void {
  if (code === selected) return;
  selected = code;
  writeStored(PREFERENCE_KEY, { code }, PreferenceSchema);
  publish();
  ensureRates();
}

export interface UsageCurrency extends UsageCurrencyState {
  /** Formats an amount that is in USD. */
  readonly format: (valueUsd: number) => string;
  /** Formats an amount that is already in the displayed currency. */
  readonly formatConverted: (amount: number) => string;
  readonly setCurrency: (code: UsageCurrencyCode) => void;
}

export function useUsageCurrency(): UsageCurrency {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...state,
    format: (valueUsd) => formatUsdIn(valueUsd, state),
    formatConverted: (amount) => formatConvertedAmount(amount, state),
    setCurrency: setUsageCurrency,
  };
}
