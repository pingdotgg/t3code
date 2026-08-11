import { SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  currencyLabel,
  MAJOR_CURRENCIES,
  type UsageCurrencyCode,
} from "../../usage/usageCurrencies";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";

export function UsageCurrencySelect({
  value,
  onValueChange,
}: {
  readonly value: UsageCurrencyCode;
  readonly onValueChange: (currency: UsageCurrencyCode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const items = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed.length === 0) return MAJOR_CURRENCIES;
    return MAJOR_CURRENCIES.filter(
      (currency) =>
        currency.code.toLowerCase().includes(trimmed) ||
        currency.name.toLowerCase().includes(trimmed),
    );
  }, [query]);

  return (
    <Combobox
      items={items.map((currency) => currency.code)}
      filteredItems={items.map((currency) => currency.code)}
      autoHighlight
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setQuery("");
      }}
      value={value}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        onValueChange(next as UsageCurrencyCode);
        setOpen(false);
      }}
    >
      <ComboboxTrigger
        aria-label="Display currency"
        className="inline-flex h-7.5 min-w-20 items-center justify-between gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="tabular-nums">{value}</span>
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="w-64">
        <div className="shrink-0 px-3 pt-2.5">
          <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
            />
            <ComboboxInput
              className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
              inputClassName="rounded-none bg-transparent text-sm"
              placeholder="Search currencies…"
              showTrigger={false}
              size="sm"
              unstyled
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <ComboboxEmpty>No currencies found.</ComboboxEmpty>
        <ComboboxList className="max-h-64">
          {items.map((currency) => (
            <ComboboxItem key={currency.code} value={currency.code}>
              <span className="flex w-full items-baseline justify-between gap-3">
                <span className="text-foreground">{currencyLabel(currency.code)}</span>
              </span>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
