import { useGT } from "gt-react-native";
import { Alert, Pressable, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import {
  type ContextWindowSnapshot,
  formatContextWindowPercentage,
  formatContextWindowTokens,
  formatThreadCostUsd,
} from "@t3tools/client-runtime/context-window";

import { useUniwindTheme } from "../lib/useUniwindTheme";
import { AppText as Text } from "./ui/AppText";

const RING_SIZE = 14;
const RING_RADIUS = 5.5;
const RING_STROKE = 2.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Composer readout of context window fill and thread cost. Two short values fit beside the model
 * pill and send button; tapping opens the full breakdown, mobile's stand-in for web's popover.
 */
export function ContextWindowMeter(props: { readonly usage: ContextWindowSnapshot }) {
  const gt = useGT();
  const { usage } = props;
  const theme = useUniwindTheme();
  const percentageLabel = formatContextWindowPercentage(usage.usedPercentage);
  const costLabel = formatThreadCostUsd(usage.costUsd ?? null);
  const usedLabel = percentageLabel ?? formatContextWindowTokens(usage.usedTokens);
  const costNoun = usage.costSource === "modelPriced" ? "estimated cost" : "cost";
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const isOverloaded = normalizedPercentage > 90;
  const trackColor = theme["--color-border"];
  const fillColor = isOverloaded ? theme["--color-danger-foreground"] : theme["--color-icon-muted"];

  const showDetails = () => {
    const lines = [
      usage.maxTokens != null
        ? `${formatContextWindowTokens(usage.usedTokens)} of ${formatContextWindowTokens(usage.maxTokens)} tokens used`
        : `${formatContextWindowTokens(usage.usedTokens)} tokens used`,
    ];
    if (costLabel) {
      lines.push(
        `${costNoun[0]?.toUpperCase()}${costNoun.slice(1)}: ${costLabel}`,
        "API-equivalent cost for this thread. Subscription plans bill separately.",
      );
    }
    Alert.alert(gt("Context window"), lines.join("\n\n"));
  };

  return (
    <Pressable
      accessibilityLabel={
        costLabel
          ? gt("Context window {usedLabel} used, {costLabel} {costNoun}", {
              usedLabel,
              costLabel,
              costNoun,
            })
          : gt("Context window {usedLabel} used", { usedLabel })
      }
      accessibilityRole="button"
      className="h-11 flex-row items-center gap-1.5 rounded-xl px-1.5 active:bg-subtle"
      onPress={showDetails}
    >
      <View style={{ height: RING_SIZE, width: RING_SIZE }}>
        <Svg height={RING_SIZE} width={RING_SIZE} viewBox="0 0 14 14">
          <Circle
            cx={7}
            cy={7}
            r={RING_RADIUS}
            fill="none"
            stroke={trackColor}
            strokeWidth={RING_STROKE}
          />
          <Circle
            cx={7}
            cy={7}
            r={RING_RADIUS}
            fill="none"
            stroke={fillColor}
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - normalizedPercentage / 100)}
            // Rotate the arc so it starts at twelve o'clock like the web meter.
            transform="rotate(-90 7 7)"
          />
        </Svg>
      </View>
      <Text
        className="text-xs font-t3-medium text-foreground-muted"
        numberOfLines={1}
        style={isOverloaded ? { color: fillColor } : undefined}
      >
        {costLabel ? `${usedLabel} · ${costLabel}` : usedLabel}
      </Text>
    </Pressable>
  );
}
