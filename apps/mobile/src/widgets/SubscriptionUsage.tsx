import { HStack, ProgressView, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, lineLimit, tint, widgetURL } from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

export function SubscriptionUsage(
  props: SubscriptionUsageSnapshot,
  environment: WidgetEnvironment,
) {
  "widget";
  const rows = props.rows ?? [];
  const count =
    environment.widgetFamily === "systemLarge"
      ? 4
      : environment.widgetFamily === "systemMedium"
        ? 2
        : 1;
  const visible = rows.slice(0, count);
  const now = environment.date.getTime();
  const renderRow = (row: SubscriptionUsageSnapshot["rows"][number], index: number) => (
    <VStack key={index} alignment="leading" spacing={3}>
      <HStack>
        <Text
          modifiers={[
            font({ size: 12, weight: "semibold" }),
            foregroundStyle("primary"),
            lineLimit(1),
          ]}
        >
          {row.label}
        </Text>
        <Spacer />
        <Text modifiers={[font({ size: 12 }), foregroundStyle("primary")]}>
          {row.usedPercent === null ? "—" : `${row.usedPercent}% used`}
        </Text>
      </HStack>
      <Text modifiers={[font({ size: 10 }), foregroundStyle("secondary"), lineLimit(1)]}>
        {row.window}
      </Text>
      {row.usedPercent !== null ? (
        <ProgressView
          value={row.usedPercent / 100}
          modifiers={[
            tint(row.usedPercent >= 90 ? "#dc2626" : row.usedPercent >= 70 ? "#d97706" : "#0284c7"),
          ]}
        />
      ) : null}
      <Text modifiers={[font({ size: 10 }), foregroundStyle("secondary"), lineLimit(1)]}>
        {row.expiresAt <= now ? "Open app to refresh" : row.resetLabel}
      </Text>
    </VStack>
  );

  return (
    <VStack
      alignment="leading"
      spacing={8}
      modifiers={[widgetURL(props.deepLink ?? "t3code://settings/usage?tab=limits")]}
    >
      <Text
        modifiers={[font({ size: 14, weight: "bold" }), foregroundStyle("primary"), lineLimit(1)]}
      >
        Subscription usage
      </Text>
      {visible.length === 0 ? (
        <Text modifiers={[font({ size: 12 }), foregroundStyle("secondary")]}>
          Open T3 Code and connect an environment to see limits.
        </Text>
      ) : null}
      {environment.widgetFamily === "systemMedium" ? (
        <HStack alignment="top" spacing={16}>
          {visible.map(renderRow)}
        </HStack>
      ) : (
        visible.map(renderRow)
      )}
      <Spacer minLength={0} />
      <Text modifiers={[font({ size: 10 }), foregroundStyle("secondary"), lineLimit(1)]}>
        {visible.length > 0
          ? `As of ${new Date(Math.min(...visible.map((row) => row.checkedAt))).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${props.totalRows > visible.length ? ` · +${props.totalRows - visible.length} more` : ""}`
          : "Tap to open Usage"}
      </Text>
    </VStack>
  );
}

export default createWidget("SubscriptionUsage", SubscriptionUsage);
