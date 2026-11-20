import { HStack, Image, Link, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  resizable,
  widgetURL,
  widgetAccentedRenderingMode,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";
import type { AgentWidgetSnapshot } from "../agentWidgetSnapshot";

/** WidgetKit serializes this closure; keep layout helpers local. */
export function OverviewWidget(
  props: Partial<AgentWidgetSnapshot>,
  environment: WidgetEnvironment,
) {
  "widget";
  const copy = {
    caughtUp: "All caught up. Start a task in PseudoCode.",
    recent: "Recent results",
    needsAttention: "{attentionCount} need you",
    connectOverview:
      "Follow your work and see when your agent needs you. Open PseudoCode to connect.",
    delayed: "Updates delayed · Open to reconnect",
    moreThreads: "+{value} more threads",
    workOverview: "Your work, at a glance",
    ...props.copy,
  };
  const large = environment.widgetFamily === "systemLarge";
  const dark = environment.colorScheme !== "light";
  // The server heartbeats only while agents are active; idle results are not late.
  const delayed =
    props.updatedAt != null &&
    (environment.date ?? new Date()).getTime() - Date.parse(props.updatedAt) > 25 * 60_000 &&
    (props.activities ?? []).some(
      (row) =>
        row.phase === "running" || row.phase === "starting" || row.phase.startsWith("waiting"),
    );
  const scheme = props.appScheme ?? "t3code";
  const url = (path?: string) =>
    path?.startsWith("/threads/") && !path.includes("?") && !path.includes("#")
      ? `${scheme}://${path.slice(1)}`
      : `${scheme}://`;
  const tint = (phase: string) => {
    if (
      environment.isLuminanceReduced ||
      (delayed && (phase === "running" || phase === "starting")) ||
      phase === "stale"
    )
      return "secondary";
    if (phase === "waiting_for_input") return dark ? "#c4a1ff" : "#7040a8";
    if (phase === "waiting_for_approval") return dark ? "#ffc65c" : "#805000";
    if (phase === "failed") return dark ? "#ff758f" : "#ad2045";
    if (phase === "completed") return dark ? "#62e4b3" : "#146b49";
    return dark ? "#68c8ff" : "#126799";
  };
  const label = (phase: string) =>
    delayed && (phase === "running" || phase === "starting")
      ? "Update delayed"
      : phase === "waiting_for_approval"
        ? "Approval needed"
        : phase === "waiting_for_input"
          ? "Needs your input"
          : phase === "completed"
            ? "Ready to review"
            : phase === "failed"
              ? "Needs review"
              : phase === "starting"
                ? "Starting"
                : phase === "stale"
                  ? "Update delayed"
                  : "Working";
  const fallback = (phase: string) =>
    phase === "waiting_for_approval"
      ? "Review the agent’s request to continue."
      : phase === "waiting_for_input"
        ? "Your agent has a question for you."
        : phase === "completed"
          ? "The latest turn has finished."
          : phase === "failed"
            ? "Open the thread to review the error."
            : "Your agent is working on this thread.";
  const activities = [...(props.activities ?? [])].sort((a, b) => {
    const priority = (phase: string) =>
      phase.startsWith("waiting") ? 0 : phase === "failed" ? 1 : phase === "completed" ? 3 : 2;
    return priority(a.phase) - priority(b.phase) || b.updatedAt.localeCompare(a.updatedAt);
  });
  const rows = activities.slice(0, large ? 4 : 2);
  return (
    <VStack
      alignment="leading"
      spacing={large ? 8 : 4}
      modifiers={[
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }),
        widgetURL(`${scheme}://`),
      ]}
    >
      <HStack spacing={6}>
        <Image
          assetName="AppMark"
          modifiers={[
            resizable(),
            widgetAccentedRenderingMode("fullColor"),
            frame({ width: 18, height: 18 }),
          ]}
        />
        <Text modifiers={[font({ size: 13, weight: "semibold" }), foregroundStyle("primary")]}>
          PseudoCode
        </Text>
        <Spacer minLength={4} />
        <Text
          modifiers={[
            font({ size: 11, weight: "medium" }),
            foregroundStyle(
              (props.attentionCount ?? 0) > 0 ? tint("waiting_for_input") : "secondary",
            ),
            lineLimit(1),
          ]}
        >
          {(props.attentionCount ?? 0) > 0
            ? copy.needsAttention.replace("{attentionCount}", String(props.attentionCount ?? 0))
            : (props.activeCount ?? 0) > 0
              ? `${props.activeCount} active`
              : copy.recent}
        </Text>
      </HStack>
      {rows.map((row) => (
        <Link key={`${row.environmentId}:${row.threadId}`} destination={url(row.deepLink)}>
          <HStack alignment="top" spacing={9}>
            {row.projectIcon ? (
              <Image
                uiImage={row.projectIcon}
                modifiers={[
                  resizable(),
                  widgetAccentedRenderingMode("fullColor"),
                  frame({ width: 24, height: 24 }),
                  accessibilityLabel(row.projectTitle),
                ]}
              />
            ) : (
              <Image
                systemName="folder"
                modifiers={[
                  font({ size: 20 }),
                  foregroundStyle("secondary"),
                  frame({ width: 24, height: 24 }),
                ]}
              />
            )}
            <VStack
              alignment="leading"
              spacing={large ? 3 : 1}
              modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
            >
              <Text
                modifiers={[
                  font({ size: large ? 14 : 12, weight: "semibold" }),
                  foregroundStyle("primary"),
                  lineLimit(1),
                ]}
              >
                {row.threadTitle}
              </Text>
              <Text
                modifiers={[
                  font({ size: large ? 12 : 11 }),
                  foregroundStyle("secondary"),
                  lineLimit(large ? 2 : 1),
                ]}
              >
                {row.summary || row.detail || fallback(row.phase)}
              </Text>
              <HStack spacing={4}>
                <Text modifiers={[font({ size: 10 }), foregroundStyle("secondary"), lineLimit(1)]}>
                  {row.projectTitle}
                </Text>
                <Spacer minLength={2} />
                <Text
                  modifiers={[
                    font({ size: large ? 12 : 10, weight: "semibold" }),
                    foregroundStyle(tint(row.phase)),
                    lineLimit(1),
                  ]}
                >
                  {label(row.phase)}
                </Text>
              </HStack>
            </VStack>
          </HStack>
        </Link>
      ))}
      {rows.length === 0 ? (
        <Text modifiers={[font({ size: 13 }), foregroundStyle("secondary"), lineLimit(3)]}>
          {props.activities === undefined ? copy.connectOverview : copy.caughtUp}
        </Text>
      ) : null}
      <Spacer minLength={0} />
      <HStack>
        <Text modifiers={[font({ size: 10 }), foregroundStyle("secondary"), lineLimit(1)]}>
          {delayed
            ? copy.delayed
            : activities.length > rows.length
              ? copy.moreThreads.replace("{value}", String(activities.length - rows.length))
              : copy.workOverview}
        </Text>
        <Spacer minLength={4} />
        {props.updatedAt ? (
          <Text
            date={new Date(props.updatedAt)}
            dateStyle="time"
            modifiers={[font({ size: 10 }), foregroundStyle("secondary")]}
          />
        ) : null}
      </HStack>
    </VStack>
  );
}
const widget = createWidget<AgentWidgetSnapshot>("PseudoCodeOverview", OverviewWidget);
export default widget;
