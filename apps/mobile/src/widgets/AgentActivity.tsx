import { HStack, Image, Spacer, Text, VStack, ZStack } from "@expo/ui/swift-ui";
import type { ComponentProps } from "react";
import {
  accessibilityElement,
  accessibilityLabel,
  activityBackgroundTint,
  aspectRatio,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  minimumScaleFactor,
  multilineTextAlignment,
  padding,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import {
  createLiveActivity,
  type LiveActivityComponent,
  type LiveActivityLayout,
} from "expo-widgets";

type LiveActivityEnvironment = Parameters<LiveActivityComponent<AgentActivityProps>>[1];

export type AgentActivityPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale"
  | "woke";

export interface AgentActivityRowProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly modelTitle: string;
  readonly phase: AgentActivityPhase;
  readonly unread?: boolean;
  readonly completedAt?: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface AgentActivityProps {
  readonly title: string;
  readonly subtitle: string;
  readonly activeCount: number;
  readonly workingCount?: number | null;
  readonly attentionCount?: number | null;
  readonly totalCount?: number | null;
  readonly unreadCount?: number | null;
  readonly pendingCount?: number | null;
  readonly updatedAt: string;
  readonly activities: ReadonlyArray<AgentActivityRowProps>;
}

// Widget serialization excludes module helpers; use only imported view/modifier factories.
function AgentActivity(
  props: AgentActivityProps,
  environment: LiveActivityEnvironment,
): LiveActivityLayout {
  "widget";

  // Placeholder / first-paint entries arrive with empty props. Treat missing
  // fields as idle rather than throwing inside the widget JS runtime.
  const receivedActivities = Array.isArray(props.activities) ? props.activities : [];
  const activeCount =
    props.activeCount === null || (typeof props.activeCount === "number" && props.activeCount < 0)
      ? null
      : typeof props.activeCount === "number"
        ? props.activeCount
        : 0;
  const visibleActiveCount = receivedActivities.filter(
    (row) => row.phase !== "completed" && row.phase !== "failed",
  ).length;
  const countsComplete = activeCount !== null && activeCount === visibleActiveCount;
  const workingCount =
    typeof props.workingCount === "number" && props.workingCount >= 0
      ? props.workingCount
      : countsComplete
        ? receivedActivities.filter((row) => row.phase === "running" || row.phase === "starting")
            .length
        : null;
  const attentionCount =
    typeof props.attentionCount === "number" && props.attentionCount >= 0
      ? props.attentionCount
      : countsComplete
        ? receivedActivities.filter(
            (row) =>
              row.phase === "waiting_for_input" ||
              row.phase === "waiting_for_approval" ||
              row.phase === "woke",
          ).length
        : null;
  const totalCount =
    typeof props.totalCount === "number" && props.totalCount >= receivedActivities.length
      ? props.totalCount
      : null;
  const unreadCount =
    typeof props.unreadCount === "number" && props.unreadCount >= 0
      ? props.unreadCount
      : totalCount === receivedActivities.length
        ? receivedActivities.filter((row) => row.phase === "completed" && row.unread !== false)
            .length
        : null;

  // Hierarchical foregrounds inherit system tint and vibrancy.
  type Foreground = Parameters<typeof foregroundStyle>[0];
  const primaryForeground = { type: "hierarchical", style: "primary" } as const;
  const secondaryForeground = { type: "hierarchical", style: "secondary" } as const;
  const monochrome =
    environment.widgetRenderingMode === "accented" || environment.widgetRenderingMode === "vibrant";

  // iPhone uses dark Live Activity material, macOS light; choose the web palette variant by color scheme.
  const isLightScheme = environment.colorScheme === "light";
  const phaseTint = (phase: AgentActivityPhase | undefined): Foreground => {
    if (environment.isLuminanceReduced) {
      return secondaryForeground;
    }
    if (monochrome) {
      return primaryForeground;
    }
    switch (phase) {
      case "waiting_for_approval":
      case "waiting_for_input":
      case "woke":
        return isLightScheme ? "#d97706" : "#fcd34d"; // amber-600 / amber-300
      case "failed":
        return isLightScheme ? "#dc2626" : "#fca5a5"; // red-600 / red-300
      case "completed":
        return isLightScheme ? "#059669" : "#6ee7b7"; // emerald-600 / emerald-300
      case "stale":
        return secondaryForeground;
      case "starting":
      case "running":
      default:
        return isLightScheme ? "#0284c7" : "#7dd3fc"; // sky-600 / sky-300
    }
  };

  const phasePriority = (row: AgentActivityRowProps): number => {
    if (
      row.phase === "waiting_for_approval" ||
      row.phase === "waiting_for_input" ||
      row.phase === "woke"
    )
      return 0;
    if (row.phase === "failed") return 1;
    if (row.phase === "completed" && row.unread !== false) return 2;
    if (row.phase === "running" || row.phase === "starting") return 3;
    return 4;
  };
  // Past a Live Activity's stale date the system stops vouching for the
  // content, so every in-flight row degrades to "stale" rather than claiming
  // an agent is still working. Terminal phases keep their own state.
  const isSystemStale = "isStale" in environment && environment.isStale === true;
  const activities: ReadonlyArray<AgentActivityRowProps> = isSystemStale
    ? receivedActivities.map((row) =>
        row.phase === "completed" || row.phase === "failed" || row.phase === "woke"
          ? row
          : { ...row, phase: "stale", status: "Out of date" },
      )
    : receivedActivities;
  const ordered = [...activities].sort(
    (a, b) =>
      phasePriority(a) - phasePriority(b) ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.environmentId.localeCompare(b.environmentId) ||
      a.threadId.localeCompare(b.threadId),
  );
  const row0 = ordered[0];
  const row1 = ordered[1];
  const row2 = ordered[2];
  const row3 = ordered[3];
  const row4 = ordered[4];

  const attentionRow = ordered.find(
    (row) =>
      row.phase === "waiting_for_approval" ||
      row.phase === "waiting_for_input" ||
      row.phase === "woke",
  );
  const failedRow = activities.find((row) => row.phase === "failed");
  const heroRow = attentionRow ?? failedRow ?? row0;
  const tint =
    heroRow?.phase === "completed" && heroRow.unread === false
      ? secondaryForeground
      : phaseTint(heroRow?.phase);
  // Headline count leans on the accent when a human is actually blocked.
  const headerTint = attentionRow
    ? phaseTint(attentionRow.phase)
    : failedRow
      ? phaseTint(failedRow.phase)
      : tint;

  // Derive terminal outcomes from all rows so a failure dominates a newer success in every presentation.
  const allDone =
    typeof props.pendingCount === "number" && props.pendingCount >= 0
      ? props.pendingCount === 0
      : activeCount === 0 && (unreadCount === 0 || unreadCount === null);
  const hasRows = activities.length > 0;
  const doneLabel = failedRow ? "Failed" : hasRows ? "Done" : "Idle";
  const outcomeLabel = failedRow
    ? "Agent work failed"
    : hasRows
      ? "All caught up"
      : "No active agents";

  const countLabel = allDone
    ? outcomeLabel
    : isSystemStale
      ? "Agent status out of date"
      : workingCount === null
        ? "Working count unavailable"
        : workingCount > 0
          ? `${workingCount} working`
          : failedRow
            ? "Agent work failed"
            : "";
  const agentsLabel = countLabel;
  const attentionSuffix =
    !isSystemStale && attentionCount !== null && attentionCount > 0
      ? `${attentionCount} need${attentionCount === 1 ? "s" : ""} you`
      : "";
  const doneSuffix = unreadCount !== null && unreadCount > 0 ? `${unreadCount} done` : "";
  const currentLabel = allDone
    ? doneLabel
    : isSystemStale
      ? "Out of date"
      : workingCount === null
        ? "Count unavailable"
        : workingCount > 0
          ? `${workingCount} working`
          : failedRow
            ? "Failed"
            : "";
  const activeLabel = currentLabel;
  const showCompactGlyph = !attentionRow && !failedRow && !doneSuffix && !allDone && !isSystemStale;
  const summary = attentionSuffix || doneSuffix || activeLabel;

  // Widget taps target the containing app, so its production scheme is safe in every build.
  const deepLinkRow = attentionRow ?? row0;
  const deepLink =
    deepLinkRow && deepLinkRow.deepLink.startsWith("/") && !deepLinkRow.deepLink.startsWith("//")
      ? `t3code://${deepLinkRow.deepLink.slice(1)}`
      : null;

  const linkModifiers = deepLink ? [widgetURL(deepLink)] : [];

  // A scannable status glyph per phase — reads faster than colored words and
  // ties the compact / expanded / banner / watch presentations together.
  type SFName = NonNullable<ComponentProps<typeof Image>["systemName"]>;
  const phaseSymbol = (phase: AgentActivityPhase): SFName => {
    switch (phase) {
      case "waiting_for_approval":
        return "exclamationmark.circle.fill";
      case "waiting_for_input":
        return "questionmark.circle.fill";
      case "woke":
        return "alarm.fill";
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
        // Matches the thread list's Working indicator.
        return "circle.dashed";
    }
  };

  // SF Symbols, like the logo, ignore frame/foregroundStyle applied directly to
  // the image; size + tint them through a container. Preserve the symbol's
  // intrinsic aspect ratio when the resizable image fills that frame.
  const renderGlyph = (
    systemName: SFName,
    size: number,
    color: Foreground,
    modifiers: typeof linkModifiers = [],
  ) => (
    <HStack
      modifiers={[frame({ width: size, height: size }), foregroundStyle(color), ...modifiers]}
    >
      <Image
        systemName={systemName}
        modifiers={[resizable(), aspectRatio({ contentMode: "fit" })]}
      />
    </HStack>
  );

  const isRead = (row: AgentActivityRowProps) => row.phase === "completed" && row.unread === false;
  const isEmphasized = (row: AgentActivityRowProps) =>
    row.phase === "woke" ||
    row.phase === "waiting_for_input" ||
    row.phase === "waiting_for_approval" ||
    (row.phase === "completed" && row.unread !== false);
  const renderRowStatus = (row: AgentActivityRowProps) =>
    isRead(row) ? (
      <Text
        date={new Date(row.completedAt ?? row.updatedAt)}
        dateStyle="relativeMinutes"
        modifiers={[
          font({ size: 11 }),
          foregroundStyle(secondaryForeground),
          lineLimit(1),
          minimumScaleFactor(0.7),
          multilineTextAlignment("trailing"),
          // Relative dates accept all proposed width; bound them so they cannot erase the titles.
          frame({ maxWidth: 136, alignment: "trailing" }),
        ]}
      />
    ) : (
      <Text
        modifiers={[
          font({ weight: "semibold", size: 11 }),
          foregroundStyle(phaseTint(row.phase)),
          layoutPriority(1),
        ]}
      >
        {row.status}
      </Text>
    );

  // Single-line rows fit the expanded island height budget; protect project and status from truncation.
  const renderCompactRow = (row: AgentActivityRowProps) => (
    <HStack spacing={7} alignment="center">
      {row.phase === "completed" && row.unread !== false ? (
        <Text modifiers={[font({ size: 8 }), foregroundStyle(phaseTint("completed"))]}>●</Text>
      ) : null}
      <Text
        modifiers={[
          font({ weight: isEmphasized(row) ? "semibold" : "regular", size: 13 }),
          foregroundStyle(isRead(row) ? secondaryForeground : primaryForeground),
          lineLimit(1),
        ]}
      >
        {row.threadTitle}
      </Text>
      {/* Bare texts share shrinkage proportionally; project frames or layoutPriority would prevent balanced truncation. */}
      <Text modifiers={[font({ size: 11 }), foregroundStyle(secondaryForeground), lineLimit(1)]}>
        {row.projectTitle}
      </Text>
      <Spacer minLength={8} />
      {renderRowStatus(row)}
    </HStack>
  );

  // Widget Image ignores frame/foregroundStyle; size and tint its resizable template through a 3:2 container.
  const renderLogo = (height: number, color: Foreground, modifiers: typeof linkModifiers = []) => (
    <HStack
      modifiers={[frame({ width: height * 1.5, height }), foregroundStyle(color), ...modifiers]}
    >
      <Image assetName="T3Mark" modifiers={[resizable()]} />
    </HStack>
  );

  // Compact card for the watchOS Smart Stack + CarPlay (the `.small` family)
  // and lock-screen accessory widgets.
  const renderCompactLayout = () => (
    <VStack
      alignment="leading"
      spacing={5}
      modifiers={[padding({ all: 10 }), ...(deepLink ? [widgetURL(deepLink)] : [])]}
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
          {activeCount === null ? activeLabel : summary}
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
          {renderRowStatus(row0)}
        </HStack>
      ) : null}
    </VStack>
  );

  const banner = (
    <VStack
      alignment="leading"
      spacing={6}
      modifiers={[
        padding({ all: 14 }),
        // A clear tint reveals iOS 26's glass material; older hosts keep the standard surface.
        activityBackgroundTint(
          "isLiquidGlassAvailable" in environment && environment.isLiquidGlassAvailable
            ? "clear"
            : null,
        ),
        ...(deepLink ? [widgetURL(deepLink)] : []),
      ]}
    >
      {/* Keep the status centered independently of the logo. */}
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
          {attentionSuffix && agentsLabel ? (
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
          {doneSuffix ? (
            <Text
              modifiers={[
                font({ weight: "semibold", size: 13 }),
                foregroundStyle(phaseTint("completed")),
                lineLimit(1),
              ]}
            >
              {`${agentsLabel || attentionSuffix ? "· " : ""}${doneSuffix}`}
            </Text>
          ) : null}
          <Spacer minLength={0} />
        </HStack>
      </ZStack>
      {row0 ? renderCompactRow(row0) : null}
      {row1 ? renderCompactRow(row1) : null}
      {row2 ? renderCompactRow(row2) : null}
      {row3 ? renderCompactRow(row3) : null}
      {totalCount !== null && totalCount > 5 ? (
        <Text modifiers={[font({ size: 11 }), foregroundStyle(secondaryForeground), lineLimit(1)]}>
          {`${totalCount - 4} more threads · Open T3`}
        </Text>
      ) : row4 ? (
        renderCompactRow(row4)
      ) : null}
    </VStack>
  );

  return {
    banner,
    bannerSmall: renderCompactLayout(),
    compactLeading: renderLogo(14, tint, linkModifiers),
    // While agents are only working, stay quiet: the thread list's Working
    // glyph marks the activity without a count. Labels appear only for
    // attention or outcomes.
    compactTrailing: showCompactGlyph ? (
      <HStack
        modifiers={[
          padding({ trailing: 2 }),
          accessibilityElement("ignore"),
          accessibilityLabel(agentsLabel),
          ...linkModifiers,
        ]}
      >
        {renderGlyph(phaseSymbol(heroRow?.phase ?? "running"), 14, tint)}
      </HStack>
    ) : (
      <Text
        modifiers={[
          font({ weight: "semibold", size: 11 }),
          foregroundStyle(tint),
          lineLimit(1),
          minimumScaleFactor(0.5),
          ...linkModifiers,
        ]}
      >
        {attentionRow
          ? attentionRow.phase === "waiting_for_approval"
            ? "Approval"
            : attentionRow.phase === "woke"
              ? "Woke"
              : "Input"
          : failedRow
            ? "Failed"
            : doneSuffix || activeLabel}
      </Text>
    ),
    minimal: heroRow
      ? renderGlyph(phaseSymbol(heroRow.phase), 13, phaseTint(heroRow.phase), linkModifiers)
      : renderLogo(11, tint, linkModifiers),
    expandedLeading: (
      <HStack spacing={5} alignment="center" modifiers={[padding({ leading: 4, vertical: 4 })]}>
        {renderLogo(15, tint)}
        <Text modifiers={[font({ weight: "bold", size: 13 }), foregroundStyle(tint)]}>
          {isSystemStale ? "Out of date" : allDone ? doneLabel : summary}
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

export default createLiveActivity<AgentActivityProps>("AgentActivity", AgentActivity);
