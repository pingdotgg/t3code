import { HStack, Image, Rectangle, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  cornerRadius,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";
import type { AgentWidgetSnapshot } from "./agentWidgetSnapshot";

/** Serialized for WidgetKit, including gallery defaults and layout helpers. */
export function AgentWidget(props: Partial<AgentWidgetSnapshot>, environment: WidgetEnvironment) {
  "widget";
  const copy = {
    caughtUp: "All caught up. Start a task in PseudoCode.",
    reviewError: "Open thread to review the error",
    respond: "Tap to respond and keep work moving",
    connectAgent: "Your tasks, at a glance. Open PseudoCode to connect.",
    moreActive: "+{extra} more active",
    tapReview: "Tap to review",
    tapOpen: "Tap to open",
    ...props.copy,
  };
  const activities = props.activities ?? [];
  const first = activities[0];
  const accessory = environment.widgetFamily === "accessoryRectangular";
  const small = environment.widgetFamily === "systemSmall";
  const rows = activities.slice(0, accessory || small ? 1 : 2);
  const attention = props.attentionCount ?? 0;
  const count = props.activeCount ?? 0;
  const dark = environment.colorScheme !== "light";
  const color = (phase?: string) => {
    if (environment.isLuminanceReduced) return "secondary";
    if (phase === "waiting_for_approval") return dark ? "#fcd34d" : "#b45309";
    if (phase === "waiting_for_input") return dark ? "#c4b5fd" : "#6d28d9";
    if (phase === "failed") return dark ? "#fca5a5" : "#b91c1c";
    if (phase === "completed") return dark ? "#6ee7b7" : "#047857";
    return dark ? "#5eead4" : "#0f766e";
  };
  const label = (phase: string) =>
    phase === "waiting_for_approval"
      ? "Approve request"
      : phase === "waiting_for_input"
        ? "Reply needed"
        : phase === "failed"
          ? "Needs review"
          : phase === "completed"
            ? "Done"
            : phase === "starting"
              ? "Starting"
              : phase === "stale"
                ? "Update delayed"
                : "Working";
  const heading =
    attention > 0
      ? `${attention} need${attention === 1 ? "s" : ""} you`
      : count > 0
        ? `${count} active`
        : "Recent results";
  const deepLink = first?.deepLink;
  const url =
    deepLink?.startsWith("/") && !deepLink.startsWith("//")
      ? `t3code://${deepLink.slice(1)}`
      : "t3code://";
  const extra = Math.max(
    0,
    count -
      rows.filter((row) =>
        ["starting", "running", "waiting_for_approval", "waiting_for_input"].includes(row.phase),
      ).length,
  );
  return (
    <VStack
      alignment="leading"
      spacing={accessory ? 3 : small ? 7 : 9}
      modifiers={[
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }),
        widgetURL(url),
      ]}
    >
      <HStack spacing={6}>
        {!accessory ? (
          <HStack modifiers={[frame({ width: 20, height: 20 })]}>
            <Image
              assetName="AppMark"
              modifiers={[resizable(), accessibilityLabel("PseudoCode")]}
            />
          </HStack>
        ) : null}
        <Text
          modifiers={[
            font({ size: accessory ? 11 : 12, weight: "semibold" }),
            foregroundStyle("primary"),
            lineLimit(1),
          ]}
        >
          PseudoCode
        </Text>
        <Spacer minLength={0} />
        {!small ? (
          <Text
            modifiers={[
              font({ size: 11, weight: "semibold" }),
              foregroundStyle(color(first?.phase)),
              lineLimit(1),
            ]}
          >
            {heading}
          </Text>
        ) : null}
      </HStack>
      {rows.map((row) => (
        <HStack key={`${row.environmentId}:${row.threadId}`} alignment="top" spacing={8}>
          {!accessory ? (
            <Rectangle
              modifiers={[
                frame({ width: 3, height: small ? 44 : 32 }),
                foregroundStyle(color(row.phase)),
                cornerRadius(2),
              ]}
            />
          ) : null}
          <VStack
            alignment="leading"
            spacing={3}
            modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
          >
            <Text
              modifiers={[
                font({ size: accessory ? 12 : 14, weight: "semibold" }),
                foregroundStyle("primary"),
                lineLimit(small ? 2 : 1),
              ]}
            >
              {row.threadTitle}
            </Text>
            <HStack spacing={4}>
              <Text
                modifiers={[
                  font({ size: 11 }),
                  foregroundStyle("secondary"),
                  lineLimit(small && row.phase === "failed" ? 2 : 1),
                ]}
              >
                {row.phase === "failed" && row.detail && (small || rows.length > 1)
                  ? row.detail
                  : row.projectTitle}
              </Text>
              {!small ? <Spacer minLength={4} /> : null}
              {!small ? (
                <Text
                  modifiers={[
                    font({ size: 11, weight: "semibold" }),
                    foregroundStyle(color(row.phase)),
                    lineLimit(1),
                  ]}
                >
                  {label(row.phase)}
                </Text>
              ) : null}
            </HStack>
            {small ? (
              <Text
                modifiers={[
                  font({ size: 11, weight: "semibold" }),
                  foregroundStyle(color(row.phase)),
                  lineLimit(1),
                ]}
              >
                {label(row.phase)}
              </Text>
            ) : null}
            {!accessory && !small && rows.length === 1 ? (
              <Text modifiers={[font({ size: 12 }), foregroundStyle("secondary"), lineLimit(2)]}>
                {row.phase === "failed"
                  ? row.detail || copy.reviewError
                  : row.phase.startsWith("waiting")
                    ? copy.respond
                    : row.modelTitle}
              </Text>
            ) : null}
          </VStack>
        </HStack>
      ))}
      {activities.length === 0 ? (
        <Text modifiers={[font({ size: 12 }), foregroundStyle("secondary"), lineLimit(3)]}>
          {props.activities === undefined ? copy.connectAgent : copy.caughtUp}
        </Text>
      ) : null}
      {!accessory ? <Spacer minLength={0} /> : null}
      {!accessory ? (
        <HStack spacing={4}>
          <Text modifiers={[font({ size: 10 }), foregroundStyle("secondary"), lineLimit(1)]}>
            {small
              ? heading
              : extra > 0
                ? copy.moreActive.replace("{extra}", String(extra))
                : first?.phase === "failed" && rows.length > 1
                  ? copy.tapReview
                  : copy.tapOpen}
          </Text>
          <Spacer minLength={0} />
          {props.updatedAt && !small ? (
            <Text
              date={new Date(props.updatedAt)}
              dateStyle="time"
              modifiers={[font({ size: 10 }), foregroundStyle("secondary")]}
            />
          ) : null}
        </HStack>
      ) : null}
    </VStack>
  );
}
const agentWidget = createWidget<AgentWidgetSnapshot>("AgentActivity", AgentWidget);
agentWidget.reload();
export default agentWidget;
