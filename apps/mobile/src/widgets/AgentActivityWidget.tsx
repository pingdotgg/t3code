import { HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  fixedSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { AgentActivityRowProps } from "./AgentActivity";

export interface AgentActivityWidgetProps {
  readonly activeCount: number;
  readonly activities: ReadonlyArray<
    Pick<
      AgentActivityRowProps,
      | "environmentId"
      | "threadId"
      | "projectTitle"
      | "threadTitle"
      | "phase"
      | "status"
      | "deepLink"
    >
  >;
  readonly baseUrl?: string;
  readonly freshUntil?: number;
  readonly updatedAt?: string;
  readonly subtitle?: string;
  readonly source?: "snapshot" | "loading" | "signed-out" | "unavailable";
  readonly accountId?: string;
}

function AgentActivityWidget(props: AgentActivityWidgetProps, environment: WidgetEnvironment) {
  "widget";
  const now = Math.max(environment.date?.getTime() ?? 0, Date.now());
  const expired = (props.freshUntil ?? Infinity) <= now;
  const rows = (props.activities ?? []).map((row) =>
    expired && row.phase !== "completed" && row.phase !== "failed"
      ? { ...row, phase: "stale" as const }
      : row,
  );
  const stale = rows.some((row) => row.phase === "stale");
  const activeCount = props.activeCount ?? 0;
  const accessory = environment.widgetFamily === "accessoryRectangular";
  const small = environment.widgetFamily === "systemSmall";
  const hero = rows[0];
  const multiple = !small && !accessory && rows.length > 1;
  const monochrome =
    environment.widgetRenderingMode !== "fullColor" || environment.isLuminanceReduced;
  const status = (row: AgentActivityWidgetProps["activities"][number]) => {
    switch (row.phase) {
      case "waiting_for_approval":
        return { label: "Approval needed", color: "#B45309" };
      case "waiting_for_input":
        return { label: "Needs input", color: "#6D28D9" };
      case "starting":
        return { label: "Starting", color: "#0369A1" };
      case "running":
        return { label: "Working", color: "#0369A1" };
      case "completed":
        return { label: "Done", color: "#047857" };
      case "failed":
        return { label: "Failed", color: "#B91C1C" };
      case "stale":
        return { label: "Tap to refresh", color: "secondary" };
      default:
        return { label: row.status, color: "primary" };
    }
  };
  const renderStatus = (row: AgentActivityWidgetProps["activities"][number]) => {
    const presentation = status(row);
    const color =
      row.phase === "stale"
        ? "secondary"
        : monochrome
          ? "primary"
          : environment.colorScheme === "dark"
            ? row.phase === "waiting_for_approval"
              ? "#FCD34D"
              : row.phase === "waiting_for_input"
                ? "#C4B5FD"
                : row.phase === "completed"
                  ? "#6EE7B7"
                  : row.phase === "failed"
                    ? "#FCA5A5"
                    : "#7DD3FC"
            : presentation.color;
    return (
      <HStack spacing={5} modifiers={[foregroundStyle(color)]}>
        <HStack modifiers={[frame({ width: 5, height: 5 })]}>
          <Image systemName="circle.fill" modifiers={[resizable()]} />
        </HStack>
        <Text modifiers={[font({ size: 11, weight: "medium" }), lineLimit(1)]}>
          {presentation.label}
        </Text>
      </HStack>
    );
  };

  return (
    <VStack
      alignment="leading"
      spacing={accessory ? 5 : 10}
      modifiers={[
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }),
        ...(props.baseUrl ? [widgetURL(`${props.baseUrl}${hero?.deepLink.slice(1) ?? ""}`)] : []),
      ]}
    >
      <HStack spacing={8}>
        <HStack modifiers={[frame({ width: accessory ? 21 : 27, height: accessory ? 14 : 18 })]}>
          <Image assetName="T3Mark" modifiers={[resizable()]} />
        </HStack>
        <Spacer minLength={0} />
        <Text
          modifiers={[
            font({ size: 11, weight: "medium" }),
            foregroundStyle("secondary"),
            lineLimit(1),
          ]}
        >
          {stale
            ? "Out of date"
            : activeCount > 0
              ? `${activeCount} active`
              : rows.some((row) => row.phase === "failed")
                ? "Failed"
                : rows.length > 0
                  ? "Done"
                  : "Agents"}
        </Text>
      </HStack>
      {!multiple && !accessory ? <Spacer minLength={0} /> : null}
      {multiple ? (
        rows.slice(0, 2).map((row) => (
          <VStack key={`${row.environmentId}:${row.threadId}`} alignment="leading" spacing={4}>
            <Text modifiers={[font({ size: 14, weight: "semibold" }), lineLimit(1)]}>
              {row.threadTitle}
            </Text>
            <HStack spacing={7}>
              {renderStatus(row)}
              <Text modifiers={[font({ size: 11 }), foregroundStyle("secondary"), lineLimit(1)]}>
                · {row.projectTitle}
              </Text>
            </HStack>
          </VStack>
        ))
      ) : hero ? (
        <VStack alignment="leading" spacing={accessory ? 3 : 8}>
          <Text
            modifiers={[
              font({ size: accessory ? 13 : small ? 15 : 18, weight: "semibold" }),
              lineLimit(accessory ? 1 : 3),
              fixedSize({ horizontal: false, vertical: true }),
            ]}
          >
            {hero.threadTitle}
          </Text>
          {renderStatus(hero)}
          {!accessory ? (
            <Text modifiers={[font({ size: 11 }), foregroundStyle("secondary"), lineLimit(1)]}>
              {hero.projectTitle}
            </Text>
          ) : null}
        </VStack>
      ) : (
        <VStack alignment="leading" spacing={6}>
          <Text modifiers={[font({ size: accessory ? 13 : 17, weight: "semibold" }), lineLimit(2)]}>
            {props.source === "loading"
              ? "Loading activity"
              : props.source === "unavailable"
                ? "Couldn’t refresh"
                : props.source === "signed-out"
                  ? "Connect your account"
                  : props.source === "snapshot"
                    ? "Ready when you are"
                    : "Open T3 Code"}
          </Text>
          <Text modifiers={[font({ size: 12 }), foregroundStyle("secondary"), lineLimit(3)]}>
            {props.subtitle ?? "Load agent activity"}
          </Text>
        </VStack>
      )}
      {!accessory ? <Spacer minLength={0} /> : null}
    </VStack>
  );
}

export default createWidget<AgentActivityWidgetProps>("AgentActivity", AgentActivityWidget, {
  activeCount: 0,
  activities: [],
});
