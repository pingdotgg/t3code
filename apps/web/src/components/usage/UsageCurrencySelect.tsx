import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { USAGE_CURRENCIES, isUsageCurrencyCode, useUsageCurrency } from "./usageCurrency";

function ratesNote(currency: ReturnType<typeof useUsageCurrency>): string | null {
  if (currency.selected === "USD") return null;
  if (currency.code !== currency.selected) {
    return currency.status === "loading"
      ? "Loading exchange rate…"
      : "Exchange rate unavailable, showing USD";
  }
  return currency.asOf === null
    ? null
    : `1 USD = ${currency.rate.toFixed(4)} ${currency.code} · rates from ${currency.asOf}`;
}

export function UsageCurrencySelect() {
  const currency = useUsageCurrency();
  const note = ratesNote(currency);

  return (
    <Select
      value={currency.selected}
      onValueChange={(value) => {
        if (isUsageCurrencyCode(value)) currency.setCurrency(value);
      }}
    >
      <SelectTrigger
        aria-label="Currency"
        title={note ?? "Costs are priced in USD"}
        size="compact"
        variant="ghost"
        className="w-auto min-w-0"
      >
        <SelectValue>{currency.selected}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {USAGE_CURRENCIES.map((option) => (
          <SelectItem key={option.code} value={option.code}>
            {option.code} · {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
