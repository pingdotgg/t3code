import { HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  fixedSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  layoutPriority,
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
      ? { ...row, phase: "stale" as const, status: "Out of date" }
      : row,
  );
  const outOfDate = expired && rows.some((row) => row.phase === "stale");
  const activeCount = props.activeCount ?? 0;
  const accessory = environment.widgetFamily === "accessoryRectangular";
  const small = environment.widgetFamily === "systemSmall";
  const large = environment.widgetFamily === "systemLarge";
  const roomier = !small && !accessory;
  const textSize = environment.dynamicTypeSize ?? "large";
  const accessibility = textSize.startsWith("accessibility");
  const enlarged = textSize === "xxxLarge";
  const rowLimit = large
    ? accessibility
      ? 2
      : enlarged
        ? 3
        : textSize === "xLarge" || textSize === "xxLarge"
          ? 4
          : 5
    : accessibility || enlarged
      ? 1
      : 2;
  const hero = rows[0];
  const showRows = roomier && rows.length > 0;
  const monochrome =
    environment.widgetRenderingMode !== "fullColor" || environment.isLuminanceReduced;
  const statusColor = (row: AgentActivityWidgetProps["activities"][number]) => {
    if (row.phase === "stale") return "secondary";
    if (monochrome) return "primary";
    const dark = environment.colorScheme === "dark";
    switch (row.phase) {
      case "waiting_for_approval":
        return dark ? "#FCD34D" : "#B45309";
      case "waiting_for_input":
        return dark ? "#C4B5FD" : "#6D28D9";
      case "completed":
        return dark ? "#6EE7B7" : "#047857";
      case "failed":
        return dark ? "#FCA5A5" : "#B91C1C";
      default:
        return dark ? "#7DD3FC" : "#0369A1";
    }
  };
  const statusSymbols = {
    starting: "arrow.trianglehead.2.clockwise.rotate.90",
    running: "arrow.trianglehead.2.clockwise.rotate.90",
    waiting_for_approval: "hand.raised.circle",
    waiting_for_input: "questionmark.circle",
    completed: "checkmark.circle.fill",
    failed: "exclamationmark.circle.fill",
    stale: "clock",
  } as const;
  const renderStatus = (
    row: AgentActivityWidgetProps["activities"][number],
    horizontal = false,
  ) => {
    const color = statusColor(row);
    const text = (
      <Text
        modifiers={[
          font(roomier ? { textStyle: "caption2" } : { size: 11, weight: "medium" }),
          foregroundStyle(color),
          lineLimit(1),
          ...(horizontal ? [layoutPriority(1)] : []),
        ]}
      >
        {row.status}
      </Text>
    );
    return horizontal ? (
      text
    ) : (
      <HStack spacing={5} modifiers={[foregroundStyle(color)]}>
        <HStack modifiers={[frame({ width: 5, height: 5 })]}>
          <Image systemName="circle.fill" modifiers={[resizable()]} />
        </HStack>
        {text}
      </HStack>
    );
  };

  return (
    <VStack
      alignment="leading"
      spacing={accessory ? 5 : showRows ? 8 : 10}
      modifiers={[
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }),
        ...(props.baseUrl ? [widgetURL(`${props.baseUrl}${hero?.deepLink.slice(1) ?? ""}`)] : []),
      ]}
    >
      {showRows ? (
        rows.slice(0, rowLimit).map((row) => (
          <HStack key={`${row.environmentId}:${row.threadId}`} spacing={10} alignment="center">
            {!accessibility ? (
              <Image
                systemName={statusSymbols[row.phase]}
                modifiers={[font({ textStyle: "body" }), foregroundStyle(statusColor(row))]}
              />
            ) : null}
            <VStack alignment="leading" spacing={3}>
              <Text
                modifiers={[
                  font({ textStyle: "headline" }),
                  lineLimit(large && !accessibility ? 2 : 1),
                ]}
              >
                {row.threadTitle}
              </Text>
              {!accessibility || large ? (
                <Text
                  modifiers={[
                    font({ textStyle: "caption2" }),
                    foregroundStyle("secondary"),
                    lineLimit(1),
                  ]}
                >
                  {row.projectTitle}
                </Text>
              ) : null}
            </VStack>
            <Spacer minLength={8} />
            {renderStatus(row, true)}
          </HStack>
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
          <Text
            modifiers={[
              font(
                roomier
                  ? { textStyle: "headline" }
                  : { size: accessory ? 13 : 17, weight: "semibold" },
              ),
              lineLimit(accessory || (roomier && !large) ? 1 : 2),
            ]}
          >
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
          {!(roomier && accessibility && !large) ? (
            <Text
              modifiers={[
                font(roomier ? { textStyle: "caption2" } : { size: 12 }),
                foregroundStyle("secondary"),
                lineLimit(accessory ? 1 : 3),
              ]}
            >
              {props.subtitle ?? "Load agent activity"}
            </Text>
          ) : null}
        </VStack>
      )}
      {!accessory ? <Spacer minLength={0} /> : null}
      <HStack>
        <Spacer minLength={0} />
        <Text
          modifiers={[
            font(roomier ? { textStyle: "caption2" } : { size: 11, weight: "medium" }),
            foregroundStyle("secondary"),
            lineLimit(1),
            fixedSize({ horizontal: false, vertical: true }),
            layoutPriority(1),
          ]}
        >
          {outOfDate
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
    </VStack>
  );
}

export default createWidget<AgentActivityWidgetProps>("AgentActivity", AgentActivityWidget, {
  activeCount: 0,
  activities: [],
});
