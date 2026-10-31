import type { UsageModelPriceOverride } from "@t3tools/contracts";

export const USAGE_PRICE_FIELDS = [
  { key: "inputCostPerMillionTokens", label: "Input", optional: false },
  { key: "outputCostPerMillionTokens", label: "Output", optional: false },
  { key: "cacheReadCostPerMillionTokens", label: "Cache read", optional: true },
  { key: "cacheWriteCostPerMillionTokens", label: "Cache write", optional: true },
] as const;

export type UsagePriceForm = { model: string } & Record<
  (typeof USAGE_PRICE_FIELDS)[number]["key"],
  string
>;

export function usagePriceForm(model = "", price?: UsageModelPriceOverride): UsagePriceForm {
  return {
    model,
    inputCostPerMillionTokens: price?.inputCostPerMillionTokens.toString() ?? "",
    outputCostPerMillionTokens: price?.outputCostPerMillionTokens.toString() ?? "",
    cacheReadCostPerMillionTokens: price?.cacheReadCostPerMillionTokens?.toString() ?? "",
    cacheWriteCostPerMillionTokens: price?.cacheWriteCostPerMillionTokens?.toString() ?? "",
  };
}

/** Allow decimal/exponent edits and all deletions, including temporarily invalid values; saving validates
 * the result. */
export function isUsagePriceEdit(previous: string, next: string): boolean {
  if (/^\s*(?:\d*[.,]?\d*|(?:\d+[.,]?\d*|[.,]\d+)e[+-]?\d*)\s*$/i.test(next)) return true;
  if (next.length >= previous.length) return false;
  let start = 0;
  while (start < next.length && next[start] === previous[start]) start++;
  return next.slice(start) === previous.slice(previous.length - (next.length - start));
}

/** Blank cache prices use the input rate; explicit zero means free. */
export function parseUsagePriceForm(
  form: UsagePriceForm,
): { model: string; price: UsageModelPriceOverride } | null {
  const model = form.model.trim();
  if (model.length === 0) return null;
  const rates: Partial<Record<(typeof USAGE_PRICE_FIELDS)[number]["key"], number>> = {};
  for (const field of USAGE_PRICE_FIELDS) {
    const raw = form[field.key].trim().replace(",", ".");
    if (raw === "") {
      if (field.optional) continue;
      return null;
    }
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    rates[field.key] = value;
  }
  if (
    rates.inputCostPerMillionTokens === undefined ||
    rates.outputCostPerMillionTokens === undefined
  ) {
    return null;
  }
  return {
    model,
    price: {
      inputCostPerMillionTokens: rates.inputCostPerMillionTokens,
      outputCostPerMillionTokens: rates.outputCostPerMillionTokens,
      ...(rates.cacheReadCostPerMillionTokens === undefined
        ? {}
        : { cacheReadCostPerMillionTokens: rates.cacheReadCostPerMillionTokens }),
      ...(rates.cacheWriteCostPerMillionTokens === undefined
        ? {}
        : { cacheWriteCostPerMillionTokens: rates.cacheWriteCostPerMillionTokens }),
    },
  };
}
