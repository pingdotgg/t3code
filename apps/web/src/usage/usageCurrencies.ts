/**
 * Major display currencies for the usage page, plus FX rate caching.
 *
 * Costs are stored in USD; rates convert USD → quote via Frankfurter.
 * Fresh rates are fetched at most once per 24 hours.
 *
 * @module usageCurrencies
 */
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";

export const USAGE_CURRENCY_STORAGE_KEY = "t3code:usage-currency";
export const USAGE_CURRENCY_RATES_STORAGE_KEY = "t3code:usage-currency-rates";
export const USAGE_CURRENCY_RATES_ATTEMPT_STORAGE_KEY = "t3code:usage-currency-rates-attempt";

/** Rolling TTL for FX rates and failed refresh attempts. */
export const USAGE_CURRENCY_RATES_TTL_MS = 24 * 60 * 60 * 1000;

const FRANKFURTER_RATES_URL = "https://api.frankfurter.dev/v2/rates?base=USD";

/** Currencies offered in the usage selector (ISO 4217). */
export const MAJOR_CURRENCIES = [
  { code: "USD", name: "US Dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "AUD", name: "Australian Dollar" },
  { code: "NZD", name: "New Zealand Dollar" },
  { code: "CNY", name: "Chinese Yuan" },
  { code: "HKD", name: "Hong Kong Dollar" },
  { code: "SGD", name: "Singapore Dollar" },
  { code: "TWD", name: "Taiwan Dollar" },
  { code: "KRW", name: "South Korean Won" },
  { code: "INR", name: "Indian Rupee" },
  { code: "IDR", name: "Indonesian Rupiah" },
  { code: "MYR", name: "Malaysian Ringgit" },
  { code: "PHP", name: "Philippine Peso" },
  { code: "THB", name: "Thai Baht" },
  { code: "VND", name: "Vietnamese Dong" },
  { code: "PKR", name: "Pakistani Rupee" },
  { code: "BDT", name: "Bangladeshi Taka" },
  { code: "LKR", name: "Sri Lankan Rupee" },
  { code: "BRL", name: "Brazilian Real" },
  { code: "MXN", name: "Mexican Peso" },
  { code: "ARS", name: "Argentine Peso" },
  { code: "CLP", name: "Chilean Peso" },
  { code: "COP", name: "Colombian Peso" },
  { code: "PEN", name: "Peruvian Sol" },
  { code: "UYU", name: "Uruguayan Peso" },
  { code: "SEK", name: "Swedish Krona" },
  { code: "NOK", name: "Norwegian Krone" },
  { code: "DKK", name: "Danish Krone" },
  { code: "ISK", name: "Icelandic Krona" },
  { code: "PLN", name: "Polish Zloty" },
  { code: "CZK", name: "Czech Koruna" },
  { code: "HUF", name: "Hungarian Forint" },
  { code: "RON", name: "Romanian Leu" },
  { code: "UAH", name: "Ukrainian Hryvnia" },
  { code: "RUB", name: "Russian Ruble" },
  { code: "TRY", name: "Turkish Lira" },
  { code: "ILS", name: "Israeli Shekel" },
  { code: "AED", name: "UAE Dirham" },
  { code: "SAR", name: "Saudi Riyal" },
] as const;

export type UsageCurrencyCode = (typeof MAJOR_CURRENCIES)[number]["code"];

const MAJOR_CURRENCY_CODES = [
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "CAD",
  "AUD",
  "NZD",
  "CNY",
  "HKD",
  "SGD",
  "TWD",
  "KRW",
  "INR",
  "IDR",
  "MYR",
  "PHP",
  "THB",
  "VND",
  "PKR",
  "BDT",
  "LKR",
  "BRL",
  "MXN",
  "ARS",
  "CLP",
  "COP",
  "PEN",
  "UYU",
  "SEK",
  "NOK",
  "DKK",
  "ISK",
  "PLN",
  "CZK",
  "HUF",
  "RON",
  "UAH",
  "RUB",
  "TRY",
  "ILS",
  "AED",
  "SAR",
] as const satisfies ReadonlyArray<UsageCurrencyCode>;

const MAJOR_CURRENCY_CODE_SET = new Set<string>(MAJOR_CURRENCY_CODES);

export const UsageCurrencyCodeSchema = Schema.Literals(MAJOR_CURRENCY_CODES);

export const UsageCurrencyRatesCacheSchema = Schema.Struct({
  /** Epoch ms when the rates were last fetched. */
  fetchedAt: Schema.Number,
  /** Rate date reported by Frankfurter (`YYYY-MM-DD`). */
  date: Schema.String,
  /** USD → quote multipliers keyed by ISO code. */
  rates: Schema.Record(Schema.String, Schema.Number),
});

export type UsageCurrencyRatesCache = typeof UsageCurrencyRatesCacheSchema.Type;

const FrankfurterRateRowSchema = Schema.Struct({
  date: Schema.String,
  base: Schema.String,
  quote: Schema.String,
  rate: Schema.Number,
});

const FrankfurterRatesResponseSchema = Schema.Array(FrankfurterRateRowSchema);

/** Diagnostics-only failure from the Frankfurter FX rates fetch path. */
export class UsageCurrencyRatesFetchError extends Schema.TaggedErrorClass<UsageCurrencyRatesFetchError>()(
  "UsageCurrencyRatesFetchError",
  {
    stage: Schema.Literals(["request", "status", "json", "decode"]),
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.stage === "status"
      ? `Frankfurter rates request failed (${this.status ?? 0}).`
      : `Frankfurter rates ${this.stage} step failed.`;
  }
}

export function isUsageCurrencyCode(value: string): value is UsageCurrencyCode {
  return MAJOR_CURRENCY_CODE_SET.has(value);
}

export function currencyLabel(code: UsageCurrencyCode): string {
  const entry = MAJOR_CURRENCIES.find((currency) => currency.code === code);
  return entry === undefined ? code : `${entry.code} · ${entry.name}`;
}

/** Local calendar day used as a fallback Frankfurter rate date. */
function todayLocalDay(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isWithinRatesTtl(fetchedAt: number, now: Date): boolean {
  if (!Number.isFinite(fetchedAt)) return false;
  const ageMs = now.getTime() - fetchedAt;
  return ageMs >= 0 && ageMs < USAGE_CURRENCY_RATES_TTL_MS;
}

export function readStoredUsageCurrency(): UsageCurrencyCode {
  try {
    return getLocalStorageItem(USAGE_CURRENCY_STORAGE_KEY, UsageCurrencyCodeSchema) ?? "USD";
  } catch {
    return "USD";
  }
}

export function readStoredUsageCurrencyRates(): UsageCurrencyRatesCache | null {
  try {
    return getLocalStorageItem(USAGE_CURRENCY_RATES_STORAGE_KEY, UsageCurrencyRatesCacheSchema);
  } catch {
    return null;
  }
}

export function writeStoredUsageCurrencyRates(cache: UsageCurrencyRatesCache): void {
  setLocalStorageItem(USAGE_CURRENCY_RATES_STORAGE_KEY, cache, UsageCurrencyRatesCacheSchema);
}

function readStoredUsageCurrencyRatesAttempt(): number | null {
  try {
    return getLocalStorageItem(USAGE_CURRENCY_RATES_ATTEMPT_STORAGE_KEY, Schema.Number);
  } catch {
    return null;
  }
}

function writeStoredUsageCurrencyRatesAttempt(fetchedAt: number): void {
  setLocalStorageItem(USAGE_CURRENCY_RATES_ATTEMPT_STORAGE_KEY, fetchedAt, Schema.Number);
}

function tryWriteStoredUsageCurrencyRatesAttempt(attemptedAt: number): void {
  try {
    writeStoredUsageCurrencyRatesAttempt(attemptedAt);
  } catch (error) {
    console.error("[usage-currency] Failed to persist the FX refresh attempt.", error);
  }
}

export function ratesNeedRefresh(cache: UsageCurrencyRatesCache | null, now = new Date()): boolean {
  if (cache === null) return true;
  return !isWithinRatesTtl(cache.fetchedAt, now);
}

/**
 * USD amount → selected currency using a USD-based rate table.
 * Missing quotes return `null` so callers cannot accidentally label an
 * unconverted USD amount as another currency.
 */
export function convertFromUsd(
  amountUsd: number,
  currency: UsageCurrencyCode,
  rates: Readonly<Record<string, number>>,
): number | null {
  if (currency === "USD") return amountUsd;
  const rate = rates[currency];
  return rate === undefined ? null : amountUsd * rate;
}

export function getUsdRate(
  currency: UsageCurrencyCode,
  rates: Readonly<Record<string, number>>,
): number | null {
  if (currency === "USD") return 1;
  return rates[currency] ?? null;
}

/** Fetch major-currency rates against USD and reshape into a cache document. */
export async function fetchUsageCurrencyRates(now = new Date()): Promise<UsageCurrencyRatesCache> {
  const quotes = MAJOR_CURRENCIES.map((entry) => entry.code).join(",");

  let response: Response;
  try {
    response = await fetch(`${FRANKFURTER_RATES_URL}&quotes=${quotes}`);
  } catch (cause) {
    throw new UsageCurrencyRatesFetchError({ stage: "request", cause });
  }

  if (!response.ok) {
    throw new UsageCurrencyRatesFetchError({ stage: "status", status: response.status });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new UsageCurrencyRatesFetchError({ stage: "json", cause });
  }

  let rows;
  try {
    rows = Schema.decodeUnknownSync(FrankfurterRatesResponseSchema)(body);
  } catch (cause) {
    throw new UsageCurrencyRatesFetchError({ stage: "decode", cause });
  }

  const rates: Record<string, number> = { USD: 1 };
  let date = todayLocalDay(now);

  for (const row of rows) {
    if (row.base !== "USD") continue;
    if (!isUsageCurrencyCode(row.quote)) continue;
    rates[row.quote] = row.rate;
    date = row.date;
  }

  return {
    fetchedAt: now.getTime(),
    date,
    rates,
  };
}

let ratesFetchInFlight: Promise<UsageCurrencyRatesCache | null> | null = null;
let ratesFetchAttemptedAt: number | null = null;
let ratesFetchedInMemory: UsageCurrencyRatesCache | null = null;

/**
 * Contact Frankfurter at most once per 24 hours. Fetch failures leave any
 * existing cache alone; persist failures still return the freshly fetched table
 * so the UI can convert without waiting on localStorage.
 */
export async function refreshUsageCurrencyRatesIfNeeded(
  now = new Date(),
): Promise<UsageCurrencyRatesCache | null> {
  const stored = readStoredUsageCurrencyRates();
  if (!ratesNeedRefresh(stored, now)) return null;
  if (ratesFetchInFlight !== null) return ratesFetchInFlight;

  const storedAttemptAt = readStoredUsageCurrencyRatesAttempt();
  if (
    (ratesFetchAttemptedAt !== null && isWithinRatesTtl(ratesFetchAttemptedAt, now)) ||
    (storedAttemptAt !== null && isWithinRatesTtl(storedAttemptAt, now))
  ) {
    return ratesFetchedInMemory;
  }

  const attemptedAt = now.getTime();
  ratesFetchAttemptedAt = attemptedAt;

  ratesFetchInFlight = (async () => {
    try {
      const next = await fetchUsageCurrencyRates(now);
      ratesFetchedInMemory = next;
      try {
        writeStoredUsageCurrencyRates(next);
        tryWriteStoredUsageCurrencyRatesAttempt(attemptedAt);
      } catch (error) {
        console.error("[usage-currency] Failed to persist FX rates.", error);
      }
      return next;
    } catch (error) {
      console.error("[usage-currency] Failed to refresh FX rates.", error);
      tryWriteStoredUsageCurrencyRatesAttempt(attemptedAt);
      return null;
    } finally {
      ratesFetchInFlight = null;
    }
  })();

  return ratesFetchInFlight;
}

export function __resetUsageCurrencyRatesFetchForTests(): void {
  ratesFetchInFlight = null;
  ratesFetchAttemptedAt = null;
  ratesFetchedInMemory = null;
}
