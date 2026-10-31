// @effect-diagnostics globalDate:off globalFetch:off globalConsole:off - Rate freshness is wall-clock time, and this client-side store runs on web and mobile without an Effect runtime.
import { formatMoney } from "./usageFormat.ts";

/** Usage is priced in USD; every other currency is a display-time conversion. */
const BASE_CURRENCY = "USD";

/** Every currency the rate provider (frankfurter.dev, ECB reference rates) publishes, plus USD. */
export const USAGE_CURRENCY_CODES = [
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

export type UsageCurrencyCode = (typeof USAGE_CURRENCY_CODES)[number];

// USD and DKK lead the list; everything else follows alphabetically.
const PINNED_CODES: readonly UsageCurrencyCode[] = ["USD", "DKK"];

const LOCALE_OVERRIDES: Partial<Record<UsageCurrencyCode, string>> = {
  DKK: "da-DK",
  EUR: "en-IE",
  GBP: "en-GB",
  NOK: "nb-NO",
  SEK: "sv-SE",
};

function currencyName(code: UsageCurrencyCode): string {
  // Intl.DisplayNames is missing on some JS engines; the code itself is a fine label.
  try {
    return new Intl.DisplayNames("en", { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export const USAGE_CURRENCIES = [
  ...PINNED_CODES,
  ...USAGE_CURRENCY_CODES.filter((code) => !PINNED_CODES.includes(code)),
].map((code) => ({
  code,
  label: currencyName(code),
  locale: LOCALE_OVERRIDES[code] ?? "en-US",
}));

// Without a `symbols` filter the provider returns every currency it publishes.
const RATES_URL = `https://api.frankfurter.dev/v1/latest?base=${BASE_CURRENCY}`;
const RATES_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface StoredRates {
  readonly fetchedAt: number;
  /** The publication date of the rates, as reported by the rate provider. */
  readonly asOf: string;
  readonly rates: Readonly<Record<string, number>>;
}

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
  return USAGE_CURRENCY_CODES.some((code) => code === value);
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
  return LOCALE_OVERRIDES[code] ?? "en-US";
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

export interface UsageCurrency extends UsageCurrencyState {
  /** Formats an amount that is in USD. */
  readonly format: (valueUsd: number) => string;
  /** Formats an amount that is already in the displayed currency. */
  readonly formatConverted: (amount: number) => string;
  readonly setCurrency: (code: UsageCurrencyCode) => void;
}

export function toUsageCurrency(
  state: UsageCurrencyState,
  setCurrency: (code: UsageCurrencyCode) => void,
): UsageCurrency {
  return {
    ...state,
    format: (valueUsd) => formatUsdIn(valueUsd, state),
    formatConverted: (amount) => formatConvertedAmount(amount, state),
    setCurrency,
  };
}

/** Validates rates read back from a persisted value; anything unusable is dropped. */
export function parseStoredRates(value: unknown): StoredRates | null {
  if (typeof value !== "object" || value === null) return null;
  const { fetchedAt, asOf, rates } = value as Record<string, unknown>;
  if (typeof fetchedAt !== "number" || typeof asOf !== "string") return null;
  if (typeof rates !== "object" || rates === null) return null;
  const parsed: Record<string, number> = {};
  for (const [code, rate] of Object.entries(rates)) {
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) parsed[code] = rate;
  }
  return Object.keys(parsed).length === 0 ? null : { fetchedAt, asOf, rates: parsed };
}

function parseRatesResponse(body: unknown, fetchedAt: number): StoredRates | null {
  if (typeof body !== "object" || body === null) return null;
  const { rates, date } = body as { rates?: unknown; date?: unknown };
  return parseStoredRates({ fetchedAt, asOf: date, rates });
}

export interface UsageCurrencyStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => UsageCurrencyState;
  readonly setCurrency: (code: UsageCurrencyCode) => void;
  /**
   * Applies values that were loaded asynchronously. A currency the user already picked wins over
   * a stored one that arrives late.
   */
  readonly hydrate: (stored: {
    readonly code: UsageCurrencyCode | null;
    readonly rates: StoredRates | null;
  }) => void;
}

export interface UsageCurrencyStoreOptions {
  readonly code: UsageCurrencyCode | null;
  readonly rates: StoredRates | null;
  readonly saveCode: (code: UsageCurrencyCode) => void;
  readonly saveRates: (rates: StoredRates) => void;
  /** Defaults to fetching the public rate feed. */
  readonly fetchRates?: () => Promise<unknown>;
  readonly now?: () => number;
}

async function fetchPublishedRates(): Promise<unknown> {
  const response = await fetch(RATES_URL);
  if (!response.ok) throw new Error(`Rate request failed with ${response.status}.`);
  return response.json();
}

/**
 * A tiny external store holding the picked currency and cached rates. Storage is injected so the
 * same logic backs synchronous (web) and asynchronous (mobile) persistence.
 */
export function createUsageCurrencyStore(options: UsageCurrencyStoreOptions): UsageCurrencyStore {
  const fetchRates = options.fetchRates ?? fetchPublishedRates;
  const now = options.now ?? Date.now;
  let selected: UsageCurrencyCode = options.code ?? BASE_CURRENCY;
  let userPicked = false;
  let storedRates = options.rates;
  let status: RatesStatus = "idle";
  let inFlight: Promise<void> | null = null;
  let snapshot = resolveUsageCurrency(selected, storedRates, status);
  const listeners = new Set<() => void>();

  const publish = () => {
    snapshot = resolveUsageCurrency(selected, storedRates, status);
    for (const listener of listeners) listener();
  };

  const ratesAreFresh = () =>
    storedRates !== null && now() - storedRates.fetchedAt < RATES_MAX_AGE_MS;

  const ensureRates = () => {
    if (selected === BASE_CURRENCY || inFlight !== null || ratesAreFresh()) return;
    status = "loading";
    publish();
    inFlight = fetchRates()
      .then((body) => {
        const next = parseRatesResponse(body, now());
        if (next === null) throw new Error("Rate response had no usable rates.");
        storedRates = next;
        options.saveRates(next);
        status = "ready";
      })
      .catch((error: unknown) => {
        // Keep whatever rates were cached; the view falls back to USD only if there are none.
        console.error("Could not load exchange rates.", error);
        status = "error";
      })
      .finally(() => {
        inFlight = null;
        publish();
      });
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      ensureRates();
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    setCurrency: (code) => {
      userPicked = true;
      if (code === selected) return;
      selected = code;
      options.saveCode(code);
      publish();
      ensureRates();
    },
    hydrate: (stored) => {
      if (!userPicked && stored.code !== null) selected = stored.code;
      if (
        stored.rates !== null &&
        (storedRates === null || stored.rates.fetchedAt > storedRates.fetchedAt)
      ) {
        storedRates = stored.rates;
      }
      publish();
      if (listeners.size > 0) ensureRates();
    },
  };
}
