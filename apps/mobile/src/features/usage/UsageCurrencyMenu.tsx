import { Pressable, View } from "react-native";

import { USAGE_CURRENCIES, isUsageCurrencyCode } from "@t3tools/shared/usageCurrency";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useUsageCurrency } from "./usageCurrency";

function ratesNote(currency: ReturnType<typeof useUsageCurrency>): string {
  if (currency.selected === "USD") return "Costs are priced in USD";
  if (currency.code !== currency.selected) {
    return currency.status === "loading"
      ? "Loading exchange rate…"
      : "Exchange rate unavailable, showing USD";
  }
  return `1 USD = ${currency.rate.toFixed(4)} ${currency.code}${
    currency.asOf === null ? "" : ` · rates from ${currency.asOf}`
  }`;
}

export function UsageCurrencyMenu() {
  const currency = useUsageCurrency();
  const actions = USAGE_CURRENCIES.map((option) => ({
    id: option.code,
    title: `${option.code} · ${option.label}`,
    state: option.code === currency.selected ? ("on" as const) : ("off" as const),
  }));

  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
        {ratesNote(currency)}
      </Text>
      <Menu
        accessible
        accessibilityRole="button"
        accessibilityLabel="Currency"
        title="Currency"
        actions={actions}
        onPressAction={({ nativeEvent }) => {
          if (isUsageCurrencyCode(nativeEvent.event)) currency.setCurrency(nativeEvent.event);
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Currency: ${currency.selected}`}
          className="flex-row items-center gap-1 rounded-full px-3 py-1.5"
        >
          <Text className="text-sm font-medium text-foreground">{currency.selected}</Text>
          <SymbolView name="chevron.down" size={12} tintColorClassName="accent-icon" />
        </Pressable>
      </Menu>
    </View>
  );
}
