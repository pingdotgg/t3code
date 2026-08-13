import { Divider, HStack, Image, Spacer, Text, VStack, ZStack } from "@expo/ui/swift-ui";
import type { ComponentProps, JSX } from "react";
import {
  containerBackground,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  padding,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import {
  createLiveActivity,
  createWidget,
  type LiveActivityEnvironment,
  type LiveActivityLayout,
  type WidgetEnvironment,
} from "expo-widgets";

export type AgentActivityPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentActivityRowProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly modelTitle: string;
  readonly phase: AgentActivityPhase;
  readonly status: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface AgentActivityProps {
  readonly title: string;
  readonly subtitle: string;
  readonly activeCount: number;
  readonly updatedAt: string;
  readonly activities: ReadonlyArray<AgentActivityRowProps>;
}

// This function is serialized into the widget extension's JS bundle, so it
// must stay self-contained: no references to module-scope helpers, only the
// imported view/modifier factories.
export function AgentActivity(
  props: AgentActivityProps,
  environment: WidgetEnvironment,
): JSX.Element;
export function AgentActivity(
  props: AgentActivityProps,
  environment: LiveActivityEnvironment,
): LiveActivityLayout;
export function AgentActivity(
  props: AgentActivityProps,
  environment: WidgetEnvironment | LiveActivityEnvironment,
): JSX.Element | LiveActivityLayout {
  "widget";

  // Placeholder / first-paint entries arrive with empty props. Treat missing
  // fields as idle rather than throwing inside the widget JS runtime.
  const activities = Array.isArray(props.activities) ? props.activities : [];
  const activeCount = typeof props.activeCount === "number" ? props.activeCount : 0;
  const widgetFamily = "widgetFamily" in environment ? environment.widgetFamily : undefined;

  // Use SwiftUI's semantic label colors rather than fixed hex keyed off the
  // device color scheme. A Live Activity banner always renders over a dark
  // system material regardless of the device's light/dark setting, so
  // scheme-derived dark text read as unreadable dark-on-dark on the lock
  // screen. Semantic colors adapt to whatever material the OS places them on:
  // the dark LA banner and the (light or dark) home-screen widget alike.
  const primaryForeground = "primary";
  const secondaryForeground = "secondary";

  // Status tints mirror the web sidebar's pills
  // (apps/web/src/components/Sidebar.logic.ts resolveThreadStatusPill): amber
  // for approval, indigo for input, sky for working, emerald for completed.
  // On iPhone the LA sits on a dark material, but macOS (iPhone Mirroring /
  // Mac notification center) renders it on a light one — so pick the web
  // palette's light (-600) or dark (-300) variant off the color scheme.
  const isLightScheme = environment.colorScheme === "light";
  const phaseTint = (phase: AgentActivityPhase | undefined): string => {
    if (environment.isLuminanceReduced) {
      return secondaryForeground;
    }
    switch (phase) {
      case "waiting_for_approval":
        return isLightScheme ? "#d97706" : "#fcd34d"; // amber-600 / amber-300
      case "waiting_for_input":
        return isLightScheme ? "#4f46e5" : "#a5b4fc"; // indigo-600 / indigo-300
      case "failed":
        return isLightScheme ? "#dc2626" : "#fca5a5"; // red-600 / red-300
      case "completed":
        return isLightScheme ? "#059669" : "#6ee7b7"; // emerald-600 / emerald-300
      case "starting":
      case "running":
      default:
        return isLightScheme ? "#0284c7" : "#7dd3fc"; // sky-600 / sky-300
    }
  };

  // Order attention-first so whatever needs the user floats to the top of every
  // presentation, then failures, then in-flight work, then finished/stale.
  const phasePriority = (phase: AgentActivityPhase): number => {
    if (phase === "waiting_for_approval" || phase === "waiting_for_input") return 0;
    if (phase === "failed") return 1;
    if (phase === "running" || phase === "starting") return 2;
    return 3;
  };
  const ordered = [...activities].sort((a, b) => phasePriority(a.phase) - phasePriority(b.phase));
  const row0 = ordered[0];
  const row1 = ordered[1];
  const row2 = ordered[2];
  const row3 = ordered[3];
  const row4 = ordered[4];

  const attentionRows = activities.filter(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
  const attentionRow = attentionRows[0];
  const failedRow = activities.find((row) => row.phase === "failed");
  const heroRow = attentionRow ?? failedRow ?? row0;
  const tint = phaseTint(heroRow?.phase);
  // Headline count leans on the accent when a human is actually blocked.
  const headerTint = attentionRow
    ? phaseTint(attentionRow.phase)
    : failedRow
      ? phaseTint(failedRow.phase)
      : tint;

  // With nothing active the aggregate only carries recently finished work, so
  // "0 active agents" (and a lone "0" in the expanded island) read as broken.
  // Lead with the outcome instead. The outcome is derived here from the rows
  // rather than taken from the server subtitle (which keys off the newest
  // terminal row): every presentation — header text, tint, count slots,
  // minimal glyph — must agree, and a failure anywhere should dominate a
  // newer success.
  const allDone = activeCount === 0;
  const hasRows = activities.length > 0;
  const doneLabel = failedRow ? "Failed" : hasRows ? "Done" : "Idle";
  const outcomeLabel = failedRow
    ? "Agent work failed"
    : hasRows
      ? "Agent work completed"
      : "No active agents";

  // Header copy: "5 active agents" + (", 1 needs attention"). The banner renders
  // the two parts in-line so the attention half can carry the accent color;
  // `summary` is the short form for tight spots (expanded center, watch card).
  const agentWord = activeCount === 1 ? "agent" : "agents";
  const agentsLabel = allDone ? outcomeLabel : `${activeCount} active ${agentWord}`;
  const attentionSuffix =
    attentionRows.length > 0
      ? `${attentionRows.length} need${attentionRows.length === 1 ? "s" : ""} attention`
      : "";
  const activeLabel = allDone ? doneLabel : `${activeCount} active`;
  const summary = attentionSuffix || activeLabel;

  // Any registered scheme variant routes back to this app; taps are delivered
  // to the widget's containing app, so the prod scheme is safe for all builds.
  const deepLinkRow = attentionRow ?? row0;
  const deepLink =
    deepLinkRow && deepLinkRow.deepLink.startsWith("/") && !deepLinkRow.deepLink.startsWith("//")
      ? `t3code://${deepLinkRow.deepLink.slice(1)}`
      : null;

  // A scannable status glyph per phase — reads faster than colored words and
  // ties the compact / expanded / banner / watch presentations together.
  type SFName = NonNullable<ComponentProps<typeof Image>["systemName"]>;
  const phaseSymbol = (phase: AgentActivityPhase): SFName => {
    switch (phase) {
      case "waiting_for_approval":
        return "exclamationmark.circle.fill";
      case "waiting_for_input":
        return "questionmark.circle.fill";
      case "failed":
        return "xmark.octagon.fill";
      case "completed":
        return "checkmark.circle.fill";
      case "starting":
        return "circle.dotted";
      case "stale":
        return "clock.arrow.circlepath";
      case "running":
      default:
        return "arrow.triangle.2.circlepath";
    }
  };

  // SF Symbols, like the logo, ignore frame/foregroundStyle applied directly to
  // the image; size + tint them through a container the resizable symbol fills.
  const renderGlyph = (systemName: SFName, size: number, color: string) => (
    <HStack modifiers={[frame({ width: size, height: size }), foregroundStyle(color)]}>
      <Image systemName={systemName} modifiers={[resizable()]} />
    </HStack>
  );

  // Single-line row used by every presentation: glyph, title, inline project,
  // status. The project and status carry layoutPriority(1) so when space runs
  // out it's the title that truncates, never the (short) project name or the
  // status label. Single-line keeps rows inside the expanded island's hard
  // height budget (~160pt) and lets the banner fit more agents.
  const renderCompactRow = (row: AgentActivityRowProps) => (
    <HStack spacing={7} alignment="center">
      <Text
        modifiers={[
          font({ weight: "semibold", size: 13 }),
          foregroundStyle(primaryForeground),
          lineLimit(1),
        ]}
      >
        {row.threadTitle}
      </Text>
      {/* No layoutPriority and no frame on the project: two bare texts take
          their ideal width when it fits and shrink proportionally only when it
          doesn't — so short rows never truncate, and long title + long project
          truncate together. (A maxWidth frame is greedy and reserved its full
          width even for short names; layoutPriority let the project starve the
          title.) */}
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

  // The branded T3 mark. `assetName` resolves the template image set bundled in
  // the widget extension's asset catalog. Image views only honor `resizable`
  // directly (frame/foregroundStyle are dropped), so we size it via a container
  // frame the resizable image fills and tint it through the container's
  // foreground style, which the template image inherits. The 3:2 frame matches
  // the glyph's aspect ratio so it never distorts.
  const renderLogo = (height: number, color: string) => (
    <HStack modifiers={[frame({ width: height * 1.5, height }), foregroundStyle(color)]}>
      <Image assetName="T3Mark" modifiers={[resizable()]} />
    </HStack>
  );

  // Compact card for the watchOS Smart Stack + CarPlay (the `.small` family)
  // and lock-screen accessory widgets.
  const renderCompactLayout = () => (
    <VStack
      alignment="leading"
      spacing={5}
      modifiers={[
        padding({ all: 10 }),
        ...(deepLink ? [widgetURL(deepLink)] : []),
        ...(widgetFamily ? [containerBackground("clear", "widget")] : []),
      ]}
    >
      <HStack spacing={7} alignment="center">
        {renderLogo(14, primaryForeground)}
        <Text
          modifiers={[
            font({ weight: "bold", size: 13 }),
            foregroundStyle(headerTint),
            lineLimit(1),
          ]}
        >
          {attentionRows.length > 0 ? summary : activeLabel}
        </Text>
        <Spacer minLength={6} />
      </HStack>
      {row0 ? (
        <HStack spacing={7} alignment="center">
          <Text
            modifiers={[
              font({ weight: "semibold", size: 12 }),
              foregroundStyle(primaryForeground),
              lineLimit(1),
            ]}
          >
            {row0.threadTitle}
          </Text>
          <Spacer minLength={6} />
          <Text modifiers={[font({ size: 11 }), foregroundStyle(phaseTint(row0.phase))]}>
            {row0.status}
          </Text>
        </HStack>
      ) : null}
    </VStack>
  );

  if (
    widgetFamily === "accessoryCircular" ||
    widgetFamily === "accessoryInline" ||
    widgetFamily === "accessoryRectangular"
  ) {
    return renderCompactLayout();
  }

  if (widgetFamily) {
    // iOS supplies content margins for home-screen widgets, so adding explicit
    // padding here would double-inset the layout.
    const widgetModifiers = [
      ...(deepLink ? [widgetURL(deepLink)] : []),
      containerBackground("clear", "widget"),
    ];
    const homeSummaryTint = allDone && !hasRows ? secondaryForeground : headerTint;
    const homeSummary = attentionSuffix || agentsLabel;
    const renderHomeProjectIcon = (size: number) =>
      renderGlyph("folder.fill", size, secondaryForeground);

    if (widgetFamily === "systemSmall") {
      return (
        <VStack alignment="leading" spacing={5} modifiers={widgetModifiers}>
          <HStack spacing={5} alignment="center" modifiers={[padding({ bottom: 3 })]}>
            {renderLogo(12, primaryForeground)}
            <Text
              modifiers={[
                font({ weight: "medium", size: 12 }),
                foregroundStyle(secondaryForeground),
              ]}
            >
              Code
            </Text>
            <Spacer minLength={4} />
            {renderGlyph("arrow.up.right", 10, secondaryForeground)}
          </HStack>
          <Text
            modifiers={[
              font({ weight: "bold", size: 15 }),
              foregroundStyle(homeSummaryTint),
              lineLimit(1),
            ]}
          >
            {homeSummary}
          </Text>
          {heroRow ? (
            <Text
              modifiers={[
                font({ weight: "semibold", size: 12 }),
                foregroundStyle(primaryForeground),
                lineLimit(2),
              ]}
            >
              {heroRow.threadTitle}
            </Text>
          ) : (
            <Text modifiers={[font({ size: 11 }), foregroundStyle(secondaryForeground)]}>
              {outcomeLabel}
            </Text>
          )}
          {heroRow ? (
            <HStack spacing={5} alignment="center">
              {renderHomeProjectIcon(11)}
              <Text
                modifiers={[font({ size: 11 }), foregroundStyle(secondaryForeground), lineLimit(1)]}
              >
                {heroRow.projectTitle}
              </Text>
              <Spacer minLength={4} />
              <Text
                modifiers={[
                  font({ weight: "semibold", size: 11 }),
                  foregroundStyle(phaseTint(heroRow.phase)),
                  lineLimit(1),
                  layoutPriority(1),
                ]}
              >
                {heroRow.status}
              </Text>
            </HStack>
          ) : null}
          <Spacer minLength={0} />
        </VStack>
      );
    }

    const renderHomeRow = (row: AgentActivityRowProps) => (
      <HStack spacing={9} alignment="center">
        {renderHomeProjectIcon(17)}
        <VStack alignment="leading" spacing={1}>
          <Text
            modifiers={[
              font({ weight: "semibold", size: 13 }),
              foregroundStyle(primaryForeground),
              lineLimit(1),
            ]}
          >
            {row.threadTitle}
          </Text>
          <Text
            modifiers={[font({ size: 11 }), foregroundStyle(secondaryForeground), lineLimit(1)]}
          >
            {row.projectTitle}
          </Text>
        </VStack>
        <Spacer minLength={8} />
        <Text
          modifiers={[
            font({ weight: "semibold", size: 12 }),
            foregroundStyle(phaseTint(row.phase)),
            layoutPriority(1),
          ]}
        >
          {row.status}
        </Text>
      </HStack>
    );

    return (
      <VStack alignment="leading" spacing={0} modifiers={widgetModifiers}>
        <HStack spacing={5} alignment="center" modifiers={[padding({ bottom: 10 })]}>
          {renderLogo(13, primaryForeground)}
          <Text
            modifiers={[font({ weight: "medium", size: 13 }), foregroundStyle(secondaryForeground)]}
          >
            Code
          </Text>
          <Spacer minLength={8} />
          <Text
            modifiers={[
              font({ weight: "semibold", size: 12 }),
              foregroundStyle(homeSummaryTint),
              lineLimit(1),
              layoutPriority(1),
            ]}
          >
            {homeSummary}
          </Text>
          {renderGlyph("arrow.up.right", 10, secondaryForeground)}
        </HStack>
        {row0 ? (
          renderHomeRow(row0)
        ) : (
          <Text
            modifiers={[
              font({ weight: "semibold", size: 14 }),
              foregroundStyle(secondaryForeground),
            ]}
          >
            {outcomeLabel}
          </Text>
        )}
        {row1 ? <Divider modifiers={[padding({ vertical: 7, leading: 26 })]} /> : null}
        {row1 ? renderHomeRow(row1) : null}
        <Spacer minLength={0} />
      </VStack>
    );
  }

  const banner = (
    <VStack
      alignment="leading"
      spacing={6}
      modifiers={[padding({ all: 14 }), ...(deepLink ? [widgetURL(deepLink)] : [])]}
    >
      {/* Logo pinned to the leading edge; the status texts centered across the
          full width (ZStack so the logo doesn't skew the centering). No footer —
          overflow beyond the visible rows is inferable from the count. */}
      <ZStack>
        <HStack spacing={0} alignment="center">
          {renderLogo(13, primaryForeground)}
          <Spacer minLength={0} />
        </HStack>
        <HStack spacing={6} alignment="center">
          <Spacer minLength={0} />
          <Text
            modifiers={[
              font({ weight: "semibold", size: 13 }),
              // The all-done header carries the outcome tint (emerald /
              // red) the way the Done/Failed status labels do.
              foregroundStyle(allDone ? headerTint : primaryForeground),
              lineLimit(1),
            ]}
          >
            {agentsLabel}
          </Text>
          {attentionSuffix ? (
            <Text modifiers={[font({ size: 13 }), foregroundStyle(secondaryForeground)]}>·</Text>
          ) : null}
          {attentionSuffix ? (
            <Text
              modifiers={[
                font({ weight: "semibold", size: 13 }),
                foregroundStyle(headerTint),
                lineLimit(1),
              ]}
            >
              {attentionSuffix}
            </Text>
          ) : null}
          <Spacer minLength={0} />
        </HStack>
      </ZStack>
      {row0 ? renderCompactRow(row0) : null}
      {row1 ? renderCompactRow(row1) : null}
      {row2 ? renderCompactRow(row2) : null}
      {row3 ? renderCompactRow(row3) : null}
      {row4 ? renderCompactRow(row4) : null}
    </VStack>
  );

  return {
    banner,
    bannerSmall: renderCompactLayout(),
    compactLeading: renderLogo(14, tint),
    compactTrailing: (
      <Text modifiers={[font({ weight: "semibold", size: 11 }), foregroundStyle(tint)]}>
        {attentionRow
          ? attentionRow.phase === "waiting_for_approval"
            ? "Approval"
            : "Input"
          : activeLabel}
      </Text>
    ),
    // The shared/minimal form is a ~22pt circle — a single signal reads there,
    // the wordmark does not. Show the blocking/outcome phase glyph, else the
    // mark (all-done shows the hero row's checkmark/cross).
    minimal:
      (attentionRow || failedRow || allDone) && heroRow
        ? renderGlyph(phaseSymbol(heroRow.phase), 13, phaseTint(heroRow.phase))
        : renderLogo(11, tint),
    expandedLeading: (
      <HStack spacing={5} alignment="center" modifiers={[padding({ leading: 4, vertical: 4 })]}>
        {renderLogo(15, tint)}
        <Text modifiers={[font({ weight: "bold", size: 13 }), foregroundStyle(tint)]}>
          {allDone ? doneLabel : `${activeCount}`}
        </Text>
      </HStack>
    ),
    // No center content: the phase glyphs + statuses in expandedBottom already
    // carry the attention signal, and the expanded island's height budget is
    // tight enough that a summary line there pushed the third row off.
    expandedCenter: null,
    // No trailing content: a timestamp is glanceable-lock-screen info, not
    // useful in a view the user is actively holding open — and the trailing
    // region hugs the island's corner radius, which clipped it anyway.
    expandedTrailing: null,
    expandedBottom: (
      // Vertical padding only: the expanded region provides its own horizontal
      // content margins, so `all` padding double-indented the rows.
      // Horizontal padding keeps both edges clear of the island's corner
      // curvature (right edge clipped status labels; titles hugged the left).
      <VStack
        alignment="leading"
        spacing={5}
        modifiers={
          deepLink
            ? [padding({ vertical: 2, horizontal: 8 }), widgetURL(deepLink)]
            : [padding({ vertical: 2, horizontal: 8 })]
        }
      >
        {row0 ? renderCompactRow(row0) : null}
        {row1 ? renderCompactRow(row1) : null}
        {row2 ? renderCompactRow(row2) : null}
      </VStack>
    ),
  };
}

export const AgentActivityWidget = createWidget<AgentActivityProps>("AgentActivity", AgentActivity);

export function publishAgentActivityWidget(props: AgentActivityProps): void {
  try {
    AgentActivityWidget.updateSnapshot(props);
  } catch {
    // Personal-team and Android builds have no widget extension.
  }
}

export default createLiveActivity<AgentActivityProps>("AgentActivity", AgentActivity);
