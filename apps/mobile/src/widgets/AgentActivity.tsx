import { HStack, Image, Spacer, Text, VStack, ZStack } from "@expo/ui/swift-ui";
import type { ComponentProps } from "react";
import {
  activityBackgroundTint,
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
  environment: LiveActivityEnvironment,
): LiveActivityLayout {
  "widget";

  // Hierarchical styles inherit the system's foreground treatment, including
  // tinted and vibrant presentations, rather than resolving to a label color.
  type Foreground = Parameters<typeof foregroundStyle>[0];
  const primaryForeground = { type: "hierarchical", style: "primary" } as const;
  const secondaryForeground = { type: "hierarchical", style: "secondary" } as const;
  const monochrome =
    environment.widgetRenderingMode === "accented" || environment.widgetRenderingMode === "vibrant";

  // On iPhone the LA sits on a dark material, but macOS (iPhone Mirroring /
  // Mac notification center) renders it on a light one — so pick the web
  // palette's light (-600) or dark (-300) variant off the color scheme.
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
  // Past the stale date the system stops vouching for the content, so every
  // in-flight row degrades to "stale" rather than claiming an agent is still
  // working.
  const activities: ReadonlyArray<AgentActivityRowProps> = environment.isStale
    ? props.activities.map((row) =>
        row.phase === "completed" || row.phase === "failed"
          ? row
          : { ...row, phase: "stale", status: "Out of date" },
      )
    : props.activities;
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
  const headerTint = attentionRow
    ? phaseTint(attentionRow.phase)
    : failedRow
      ? phaseTint(failedRow.phase)
      : tint;

  const allDone = props.activeCount === 0;
  const doneLabel = failedRow ? "Failed" : "Done";
  const outcomeLabel = failedRow ? "Agent work failed" : "Agent work completed";

  const agentWord = props.activeCount === 1 ? "agent" : "agents";
  const agentsLabel = allDone
    ? outcomeLabel
    : environment.isStale
      ? "Agent status out of date"
      : `${props.activeCount} active ${agentWord}`;
  const attentionSuffix =
    attentionRows.length > 0
      ? `${attentionRows.length} need${attentionRows.length === 1 ? "s" : ""} attention`
      : "";
  const activeLabel = allDone
    ? doneLabel
    : environment.isStale
      ? "Out of date"
      : `${props.activeCount} active`;
  const summary = attentionSuffix || activeLabel;

  // Any registered scheme variant routes back to this app; taps are delivered
  // to the widget's containing app, so the prod scheme is safe for all builds.
  const deepLinkRow = attentionRow ?? row0;
  const deepLink =
    deepLinkRow && deepLinkRow.deepLink.startsWith("/") && !deepLinkRow.deepLink.startsWith("//")
      ? `t3code://${deepLinkRow.deepLink.slice(1)}`
      : null;
  const linkModifiers = deepLink ? [widgetURL(deepLink)] : [];

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
  const renderGlyph = (
    systemName: SFName,
    size: number,
    color: Foreground,
    modifiers: typeof linkModifiers = [],
  ) => (
    <HStack
      modifiers={[frame({ width: size, height: size }), foregroundStyle(color), ...modifiers]}
    >
      <Image systemName={systemName} modifiers={[resizable()]} />
    </HStack>
  );

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
          truncate together. */}
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

  // Image views only honor `resizable` directly (frame/foregroundStyle are
  // dropped), so we size it via a container frame the resizable image fills and
  // tint it through the container's foreground style, which the template image
  // inherits.
  const renderLogo = (height: number, color: Foreground, modifiers: typeof linkModifiers = []) => (
    <HStack
      modifiers={[frame({ width: height * 1.5, height }), foregroundStyle(color), ...modifiers]}
    >
      <Image assetName="T3Mark" modifiers={[resizable()]} />
    </HStack>
  );

  return {
    banner: (
      <VStack
        alignment="leading"
        spacing={6}
        modifiers={[
          padding({ all: 14 }),
          // A clear tint reveals iOS 26's glass material; older hosts keep the standard surface.
          activityBackgroundTint(environment.isLiquidGlassAvailable ? "clear" : null),
          ...(deepLink ? [widgetURL(deepLink)] : []),
        ]}
      >
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
    ),
    bannerSmall: (
      <VStack alignment="leading" spacing={5} modifiers={[padding({ all: 10 })]}>
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
    ),
    compactLeading: renderLogo(14, tint, linkModifiers),
    compactTrailing: (
      <Text
        modifiers={[
          font({ weight: "semibold", size: 11 }),
          foregroundStyle(tint),
          ...linkModifiers,
        ]}
      >
        {attentionRow
          ? attentionRow.phase === "waiting_for_approval"
            ? "Approval"
            : "Input"
          : activeLabel}
      </Text>
    ),
    minimal:
      (attentionRow || failedRow || allDone) && heroRow
        ? renderGlyph(phaseSymbol(heroRow.phase), 13, phaseTint(heroRow.phase), linkModifiers)
        : renderLogo(11, tint, linkModifiers),
    expandedLeading: (
      <HStack spacing={5} alignment="center" modifiers={[padding({ leading: 4, vertical: 4 })]}>
        {renderLogo(15, tint)}
        <Text modifiers={[font({ weight: "bold", size: 13 }), foregroundStyle(tint)]}>
          {allDone ? doneLabel : `${props.activeCount}`}
        </Text>
      </HStack>
    ),
    expandedCenter: null,
    expandedTrailing: null,
    expandedBottom: (
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
