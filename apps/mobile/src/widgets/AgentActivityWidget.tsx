import { HStack, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  containerBackground,
  font,
  foregroundStyle,
  lineLimit,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { AgentActivityProps } from "./AgentActivity";

export type AgentActivityWidgetProps = Omit<Partial<AgentActivityProps>, "activeCount"> & {
  // Null means aggregation cannot establish a total; absent props are first paint.
  readonly activeCount?: number | null;
};

// WidgetKit can render before the app has published its first snapshot. Keep
// this serialized layout self-contained and accept the initial empty props.
export function AgentActivityWidget(
  props: AgentActivityWidgetProps,
  environment: WidgetEnvironment,
) {
  "widget";

  const compact = environment.widgetFamily !== "systemMedium";
  const small = environment.widgetFamily === "systemSmall";
  const accessory = environment.widgetFamily === "accessoryRectangular";
  const priority = (phase: string) =>
    phase === "waiting_for_approval" || phase === "waiting_for_input"
      ? 0
      : phase === "failed"
        ? 1
        : phase === "running" || phase === "starting"
          ? 2
          : 3;
  const rows = [...(props.activities ?? [])]
    .sort((a, b) => priority(a.phase) - priority(b.phase))
    .slice(0, compact ? 1 : 3);
  const count = props.activeCount ?? 0;
  const path = rows[0]?.deepLink;
  const url = path?.startsWith("/threads/") ? `t3code:/${path}` : "t3code://";
  const tint = (phase: string) => {
    if (environment.isLuminanceReduced) return "#ffffff";
    switch (phase) {
      case "waiting_for_approval":
        return "#fcd34d";
      case "waiting_for_input":
        return "#a5b4fc";
      case "failed":
        return "#fca5a5";
      case "completed":
        return "#6ee7b7";
      case "stale":
        return "#aaaaaa";
      default:
        return "#7dd3fc";
    }
  };

  return (
    <VStack
      alignment="leading"
      spacing={accessory ? 4 : 8}
      modifiers={[
        containerBackground("#000000", "widget"),
        foregroundStyle("#ffffff"),
        widgetURL(url),
      ]}
    >
      <HStack spacing={6}>
        <Text modifiers={[font({ size: accessory ? 12 : 14, weight: "bold" }), lineLimit(1)]}>
          T3 Code
        </Text>
        <Spacer minLength={0} />
        {count > 0 ? (
          <Text modifiers={[font({ size: 12, weight: "semibold" }), lineLimit(1)]}>
            {`${count} active`}
          </Text>
        ) : null}
      </HStack>
      {rows.length === 0 ? (
        <Text modifiers={[font({ size: 14 }), lineLimit(2)]}>
          {props.activeCount === null ? "Activity count unavailable" : "No active agents"}
        </Text>
      ) : (
        rows.map((row) =>
          small ? (
            <VStack key={`${row.environmentId}/${row.threadId}`} alignment="leading" spacing={4}>
              <Text modifiers={[font({ size: 13, weight: "semibold" }), lineLimit(2)]}>
                {row.threadTitle}
              </Text>
              <Text
                modifiers={[font({ size: 12 }), foregroundStyle(tint(row.phase)), lineLimit(1)]}
              >
                {row.status}
              </Text>
            </VStack>
          ) : (
            <HStack key={`${row.environmentId}/${row.threadId}`} spacing={8}>
              <Text modifiers={[font({ size: 13 }), lineLimit(1)]}>{row.threadTitle}</Text>
              <Spacer minLength={0} />
              <Text
                modifiers={[font({ size: 12 }), foregroundStyle(tint(row.phase)), lineLimit(1)]}
              >
                {row.status}
              </Text>
            </HStack>
          ),
        )
      )}
    </VStack>
  );
}

export default createWidget<AgentActivityWidgetProps>("AgentActivity", AgentActivityWidget);
