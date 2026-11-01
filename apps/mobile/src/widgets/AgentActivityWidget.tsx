import { HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  containerBackground,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type {
  AgentActivityPhase,
  AgentActivityProps,
  AgentActivityRowProps,
} from "./AgentActivity";

// Home-screen and Lock Screen counterpart of the AgentActivity Live Activity.
// It shares the Live Activity's name, but expo-widgets stores widget and Live
// Activity layouts under different keys, so each needs its own registration.
export function AgentActivityWidget(
  publishedProps: (Partial<AgentActivityProps> & { readonly accountId?: string }) | undefined,
  environment: WidgetEnvironment,
) {
  "widget";
  // The extension evaluates this function without the app's module scope.
  // Before the app's first publish, the embedded layout renders with no props.
  const props = publishedProps ?? {};
  const family = environment.widgetFamily;
  const accessory = family === "accessoryRectangular";
  const small = family === "systemSmall";
  const monochrome =
    environment.widgetRenderingMode === "accented" ||
    environment.widgetRenderingMode === "vibrant" ||
    environment.isLuminanceReduced === true;
  const isLightScheme = environment.colorScheme === "light";

  type Foreground = Parameters<typeof foregroundStyle>[0];
  const primaryForeground = { type: "hierarchical", style: "primary" } as const;
  const secondaryForeground = { type: "hierarchical", style: "secondary" } as const;
  const phaseTint = (phase: AgentActivityPhase): Foreground => {
    if (monochrome) return primaryForeground;
    switch (phase) {
      case "waiting_for_approval":
        return isLightScheme ? "#d97706" : "#fcd34d";
      case "waiting_for_input":
        return isLightScheme ? "#4f46e5" : "#a5b4fc";
      case "failed":
        return isLightScheme ? "#dc2626" : "#fca5a5";
      case "completed":
        return isLightScheme ? "#059669" : "#6ee7b7";
      case "stale":
        return secondaryForeground;
      case "starting":
      case "running":
      default:
        return isLightScheme ? "#0284c7" : "#7dd3fc";
    }
  };
  const phasePriority = (phase: AgentActivityPhase): number => {
    if (phase === "waiting_for_approval" || phase === "waiting_for_input") return 0;
    if (phase === "failed") return 1;
    if (phase === "running" || phase === "starting") return 2;
    return 3;
  };

  const loaded = props.activities !== undefined;
  const rows = [...(props.activities ?? [])].sort(
    (a, b) => phasePriority(a.phase) - phasePriority(b.phase),
  );
  const shown = rows.slice(0, accessory || small ? 2 : 4);
  const attentionCount = rows.filter(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  ).length;
  const workingCount = rows.filter(
    (row) => row.phase === "running" || row.phase === "starting",
  ).length;
  const summary =
    attentionCount > 0
      ? `${attentionCount} need${attentionCount === 1 ? "s" : ""} ${small ? "you" : "attention"}`
      : workingCount > 0
        ? `${props.activeCount ?? workingCount} active`
        : rows.some((row) => row.phase === "stale")
          ? "Out of date"
          : rows.some((row) => row.phase === "failed")
            ? "Failed"
            : rows.length > 0
              ? "Done"
              : "";
  const summaryTint = rows[0] ? phaseTint(rows[0].phase) : secondaryForeground;
  const emptyMessage = loaded
    ? (props.subtitle ?? "No active agents")
    : "Open T3 Code to load agent activity";

  // Widget taps open the containing app, and every build accepts the prod
  // scheme as a link prefix, so dev and preview builds route this too.
  const linkRow = rows[0];
  const deepLink =
    linkRow && linkRow.deepLink.startsWith("/") && !linkRow.deepLink.startsWith("//")
      ? `t3code://${linkRow.deepLink.slice(1)}`
      : null;

  const background = accessory ? "clear" : isLightScheme ? "#ffffff" : "#1c1c1e";
  const rootModifiers = [
    containerBackground(background, "widget"),
    ...(deepLink ? [widgetURL(deepLink)] : []),
  ];

  // The template image ignores frame/foregroundStyle applied to itself; size
  // and tint it through a container the resizable image fills.
  const renderLogo = (height: number) => (
    <HStack
      modifiers={[frame({ width: height * 1.5, height }), foregroundStyle(primaryForeground)]}
    >
      <Image assetName="T3Mark" modifiers={[resizable()]} />
    </HStack>
  );

  const renderRow = (row: AgentActivityRowProps, key: string) =>
    small || accessory ? (
      <VStack key={key} alignment="leading" spacing={1}>
        <Text
          modifiers={[
            font({ weight: "semibold", size: accessory ? 13 : 12 }),
            foregroundStyle(primaryForeground),
            lineLimit(1),
          ]}
        >
          {row.threadTitle}
        </Text>
        <Text
          modifiers={[
            font({ weight: "medium", size: 11 }),
            foregroundStyle(phaseTint(row.phase)),
            lineLimit(1),
          ]}
        >
          {row.status}
        </Text>
      </VStack>
    ) : (
      <HStack key={key} spacing={7} alignment="center">
        <Text
          modifiers={[
            font({ weight: "semibold", size: 13 }),
            foregroundStyle(primaryForeground),
            lineLimit(1),
          ]}
        >
          {row.threadTitle}
        </Text>
        <Text modifiers={[font({ size: 11 }), foregroundStyle(secondaryForeground), lineLimit(1)]}>
          {row.projectTitle}
        </Text>
        <Spacer minLength={8} />
        <Text
          modifiers={[
            font({ weight: "semibold", size: 11 }),
            foregroundStyle(phaseTint(row.phase)),
            layoutPriority(1),
          ]}
        >
          {row.status}
        </Text>
      </HStack>
    );

  return (
    <VStack alignment="leading" spacing={accessory ? 2 : 8} modifiers={rootModifiers}>
      <HStack spacing={6} alignment="center">
        {accessory ? null : renderLogo(13)}
        <Text
          modifiers={[
            font({ weight: "semibold", size: 12 }),
            foregroundStyle(accessory ? primaryForeground : summaryTint),
            lineLimit(1),
          ]}
        >
          {summary || (accessory ? "T3 Code" : "")}
        </Text>
        <Spacer minLength={0} />
      </HStack>
      {shown.length > 0 ? (
        <VStack alignment="leading" spacing={accessory ? 1 : small ? 6 : 5}>
          {shown.map((row, index) => renderRow(row, `${row.threadId}:${index}`))}
        </VStack>
      ) : (
        <Text modifiers={[font({ size: 12 }), foregroundStyle(secondaryForeground), lineLimit(2)]}>
          {emptyMessage}
        </Text>
      )}
      {accessory ? null : <Spacer minLength={0} />}
    </VStack>
  );
}

export default createWidget<Partial<AgentActivityProps> & { readonly accountId?: string }>(
  "AgentActivity",
  AgentActivityWidget,
);
