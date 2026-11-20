import { HStack, Image, Link, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  activityBackgroundTint,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  padding,
  privacySensitive,
  resizable,
} from "@expo/ui/swift-ui/modifiers";
import { createLiveActivity, type LiveActivityComponent } from "expo-widgets";
import type { ReactElement } from "react";
import type { AgentActivityProps } from "../AgentActivity";

export type WorkLiveActivityProps = AgentActivityProps & { readonly appScheme?: string };

export const WorkLiveActivity: LiveActivityComponent<WorkLiveActivityProps> = (
  props,
  environment,
) => {
  "widget";

  const { text, activities, activeCount } = props;
  const stale = environment.isStale && activeCount > 0;
  const waiting = stale ? [] : activities.filter((row) => row.phase.startsWith("waiting"));
  const request = waiting[0];
  const running = activities.find((row) => row.phase === "running" || row.phase === "starting");
  const failed = activities.find((row) => row.phase === "failed");
  const finished = activities.find((row) => row.phase === "completed");
  const outcome = failed ?? finished;
  const hero = request ?? (activeCount > 0 ? running : outcome) ?? activities[0];
  const capped = waiting.length > 0 && !running && activeCount > waiting.length;
  const needCount = `${waiting.length}${capped ? "+" : ""}`;
  const done = activeCount === 0;
  const activeLabel = text?.active[String(activeCount)] ?? `${activeCount} active`;
  const needsLabel = capped
    ? `${needCount} need attention`
    : (text?.needAttention[String(waiting.length)] ??
      `${needCount} ${waiting.length === 1 ? "needs" : "need"} attention`);
  const headline = stale
    ? (text?.statusOutOfDate ?? "Agent status out of date")
    : request
      ? request.phase === "waiting_for_approval"
        ? (text?.approval ?? "Approval needed")
        : (text?.input ?? "Input needed")
      : done
        ? failed
          ? (text?.workFailed ?? "Agent work failed")
          : (text?.workCompleted ?? "Agent work completed")
        : activeLabel;
  const detail = request
    ? [needsLabel, activeLabel].join(" · ")
    : !done && !stale && outcome
      ? `${failed ? (text?.failed ?? "Failed") : (text?.done ?? "Done")} · ${outcome.threadTitle}`
      : undefined;
  const compactDescription = request ? needsLabel : headline;
  const compactCount = request ? needCount : String(activeCount);
  const phase = stale
    ? "stale"
    : (request?.phase ?? (done ? (failed?.phase ?? "completed") : "running"));
  const symbol =
    phase === "waiting_for_input"
      ? "questionmark.circle"
      : phase === "waiting_for_approval"
        ? "exclamationmark.circle"
        : phase === "failed"
          ? "xmark.octagon"
          : phase === "completed"
            ? "checkmark.circle"
            : phase === "stale"
              ? "clock.arrow.circlepath"
              : "circle.dashed";
  const dark = environment.colorScheme !== "light";
  const tint =
    environment.isLuminanceReduced ||
    environment.widgetRenderingMode === "accented" ||
    environment.widgetRenderingMode === "vibrant" ||
    phase === "stale"
      ? "secondary"
      : phase === "waiting_for_approval"
        ? dark
          ? "#ffd08a"
          : "#854b0b"
        : phase === "waiting_for_input"
          ? dark
            ? "#d4bbff"
            : "#60399b"
          : phase === "failed"
            ? dark
              ? "#ffa1ae"
              : "#a82442"
            : phase === "completed"
              ? dark
                ? "#82e4c0"
                : "#086445"
              : dark
                ? "#91ccff"
                : "#235e9a";
  const path = hero?.deepLink;
  const destination =
    !stale && path?.startsWith("/threads/") && !path.includes("?") && !path.includes("#")
      ? `${props.appScheme ?? "t3code"}://${path.slice(1)}`
      : undefined;
  const link = (content: ReactElement) =>
    destination ? <Link destination={destination}>{content}</Link> : content;

  const logo = (size: number) => (
    <HStack modifiers={[frame({ width: size, height: size })]}>
      <Image assetName="AppMark" modifiers={[resizable()]} />
    </HStack>
  );
  const glyph = (size: number) => (
    <HStack modifiers={[frame({ width: size, height: size }), foregroundStyle(tint)]}>
      <Image systemName={symbol} modifiers={[resizable()]} />
    </HStack>
  );
  const heading = (size: number) => (
    <Text modifiers={[font({ size, weight: "bold" }), foregroundStyle(tint), lineLimit(1)]}>
      {headline}
    </Text>
  );
  const subject = (size: number) =>
    hero && !stale ? (
      <Text
        modifiers={[
          font({ size, weight: "semibold" }),
          foregroundStyle("primary"),
          lineLimit(1),
          privacySensitive(),
        ]}
      >
        {hero.threadTitle}
      </Text>
    ) : null;
  const metadata = (value: string | undefined) =>
    value ? (
      <Text
        modifiers={[
          font({ size: 12 }),
          foregroundStyle("secondary"),
          lineLimit(1),
          privacySensitive(),
        ]}
      >
        {value}
      </Text>
    ) : null;

  return {
    banner: link(
      <VStack
        alignment="leading"
        spacing={6}
        modifiers={[
          padding({ all: 14 }),
          activityBackgroundTint(environment.isLiquidGlassAvailable ? "clear" : null),
        ]}
      >
        <HStack spacing={8}>
          {glyph(16)}
          {heading(17)}
          <Spacer minLength={4} />
          {logo(18)}
        </HStack>
        {subject(15)}
        {metadata(detail ?? (stale ? undefined : hero?.projectTitle))}
      </VStack>,
    ),
    bannerSmall: link(
      <VStack alignment="leading" spacing={4} modifiers={[padding({ all: 10 })]}>
        <HStack spacing={6}>
          {logo(13)}
          {heading(13)}
        </HStack>
        {subject(12)}
      </VStack>,
    ),
    compactLeading: <HStack>{logo(14)}</HStack>,
    compactTrailing: (
      <HStack spacing={3} modifiers={[accessibilityLabel(compactDescription)]}>
        {glyph(13)}
        {!done && !stale ? (
          <Text
            modifiers={[font({ size: 11, weight: "bold" }), foregroundStyle(tint), lineLimit(1)]}
          >
            {compactCount}
          </Text>
        ) : null}
      </HStack>
    ),
    minimal: <HStack modifiers={[accessibilityLabel(compactDescription)]}>{glyph(13)}</HStack>,
    expandedLeading: <HStack modifiers={[padding({ leading: 6, vertical: 4 })]}>{logo(17)}</HStack>,
    expandedCenter: null,
    expandedTrailing: (
      <HStack modifiers={[padding({ trailing: 6, vertical: 4 })]}>{glyph(16)}</HStack>
    ),
    expandedBottom: link(
      <VStack alignment="leading" spacing={4} modifiers={[padding({ horizontal: 8, bottom: 4 })]}>
        {heading(15)}
        {subject(13)}
        {metadata(detail ?? (stale ? undefined : hero?.projectTitle))}
      </VStack>,
    ),
  };
};

export default createLiveActivity<WorkLiveActivityProps>("AgentActivity", WorkLiveActivity);
