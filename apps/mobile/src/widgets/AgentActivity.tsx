import { HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import type { ComponentProps, ReactNode } from "react";
import {
  Animation,
  accessibilityElement,
  accessibilityLabel,
  activityBackgroundTint,
  animation,
  contentTransition,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  padding,
  resizable,
  truncationMode,
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

// Widget serialization excludes module helpers; use only imported view/modifier factories.
function AgentActivity(
  props: AgentActivityProps,
  environment: LiveActivityEnvironment,
): LiveActivityLayout {
  "widget";

  type Foreground = Parameters<typeof foregroundStyle>[0];
  type SFName = NonNullable<ComponentProps<typeof Image>["systemName"]>;
  // Hierarchical foregrounds inherit system tint and vibrancy.
  const primaryForeground = { type: "hierarchical", style: "primary" } as const;
  const secondaryForeground = { type: "hierarchical", style: "secondary" } as const;
  const tertiaryForeground = { type: "hierarchical", style: "tertiary" } as const;
  // Monochrome and Always-On drop the phase colors; each mark's shape still names the state.
  const colorless =
    environment.isLuminanceReduced === true ||
    environment.widgetRenderingMode === "accented" ||
    environment.widgetRenderingMode === "vibrant";
  // iPhone uses dark Live Activity material, macOS light; choose the web palette variant by color scheme.
  const isLightScheme = environment.colorScheme === "light";

  // A terminal prompt that changes its cursor: ›_ works, ›? asks, a shield asks permission.
  const SIGNALS: Record<
    AgentActivityPhase,
    {
      readonly mark: { readonly text: string } | { readonly symbol: SFName };
      readonly light: string | null;
      readonly dark: string | null;
      readonly spoken: string;
      readonly need: string | null;
      readonly rank: number;
      readonly index: number;
    }
  > = {
    waiting_for_approval: {
      mark: { symbol: "exclamationmark.shield.fill" },
      light: "#d97706",
      dark: "#fcd34d",
      spoken: "needs approval",
      need: "Needs approval",
      rank: 0,
      index: 3,
    },
    waiting_for_input: {
      mark: { text: "›?" },
      light: "#4f46e5",
      dark: "#a5b4fc",
      spoken: "needs your input",
      need: "Needs your input",
      rank: 0,
      index: 4,
    },
    failed: {
      mark: { symbol: "xmark.octagon.fill" },
      light: "#dc2626",
      dark: "#fca5a5",
      spoken: "failed",
      need: null,
      rank: 1,
      index: 6,
    },
    starting: {
      mark: { text: "›" },
      light: "#0284c7",
      dark: "#7dd3fc",
      spoken: "is starting",
      need: null,
      rank: 2,
      index: 1,
    },
    running: {
      mark: { text: "›_" },
      light: "#0284c7",
      dark: "#7dd3fc",
      spoken: "is working",
      need: null,
      rank: 2,
      index: 2,
    },
    completed: {
      mark: { symbol: "checkmark" },
      light: "#059669",
      dark: "#6ee7b7",
      spoken: "is done",
      need: null,
      rank: 3,
      index: 5,
    },
    stale: {
      mark: { symbol: "clock.arrow.circlepath" },
      light: null,
      dark: null,
      spoken: "status is out of date",
      need: null,
      rank: 3,
      index: 7,
    },
  };
  // A phase from a newer relay reads as stale: it claims neither work nor a need,
  // and its row keeps the relay's own status text.
  const signalFor = (phase: AgentActivityPhase) => SIGNALS[phase] ?? SIGNALS.stale;

  const tintFor = (phase: AgentActivityPhase): Foreground => {
    const signal = signalFor(phase);
    const color = isLightScheme ? signal.light : signal.dark;
    if (color === null) return secondaryForeground;
    return colorless ? primaryForeground : color;
  };

  // Mark in-flight rows stale after expiry so they cannot claim agents still work.
  const activities: ReadonlyArray<AgentActivityRowProps> = props.activities.map((row) =>
    row.phase === "stale" ||
    (environment.isStale && row.phase !== "completed" && row.phase !== "failed")
      ? { ...row, phase: "stale", status: "Out of date" }
      : row,
  );
  // Stable sort: the thread that needs the user leads, then failures, work, and outcomes.
  const ordered = [...activities].sort((a, b) => signalFor(a.phase).rank - signalFor(b.phase).rank);
  const hero = ordered[0];
  const others = ordered.slice(1);
  const other0 = others[0];
  const other1 = others[1];
  const other2 = others[2];

  const needsYouCount = activities.filter((row) => signalFor(row.phase).rank === 0).length;
  // Count only rows the relay sent: it caps rows after putting needs-you first, so a thread
  // it left out may be waiting on the user. Those threads show only as "+N more".
  const workingCount = activities.filter((row) => signalFor(row.phase).rank === 2).length;
  const staleCount = activities.filter((row) => row.phase === "stale").length;
  const failedCount = activities.filter((row) => row.phase === "failed").length;
  const doneCount = activities.filter((row) => row.phase === "completed").length;
  const summaryParts = [
    needsYouCount > 0 ? `${needsYouCount} need${needsYouCount === 1 ? "s" : ""} you` : null,
    workingCount > 0 ? `${workingCount} working` : null,
    staleCount > 0 ? "Out of date" : null,
    failedCount > 0 ? `${failedCount} failed` : null,
    doneCount > 0 ? `${doneCount} done` : null,
  ].filter((part): part is string => part !== null);
  const summary = summaryParts.join(" · ");
  // Count threads, not rows: the relay sends only the rows that fit.
  const threadCount = Math.max(props.activeCount + failedCount + doneCount, ordered.length);
  const unsentCount = threadCount - ordered.length;

  const describe = (row: AgentActivityRowProps) =>
    `${row.threadTitle.trim() || "A thread"} ${signalFor(row.phase).spoken}`;
  // Speak the summary whenever it covers more threads than the leading one, as the glance shows it.
  const coversOthers = ordered.length > 1;
  const glanceLabel = hero
    ? coversOthers
      ? `${describe(hero)}. ${summaryParts.join(", ")}`
      : describe(hero)
    : "T3 Code";
  const cardLabel = [
    "T3 Code",
    ...ordered.map((row) => `${describe(row)}, ${row.projectTitle}`),
    ...(unsentCount > 0 ? [`${unsentCount} more`] : []),
  ].join(". ");

  // Widget taps target the containing app, so its production scheme is safe in every build.
  const deepLink =
    hero && hero.deepLink.startsWith("/") && !hero.deepLink.startsWith("//")
      ? `t3code://${hero.deepLink.slice(1)}`
      : null;
  const linkModifiers = deepLink ? [widgetURL(deepLink)] : [];

  // SF Symbols and the logo ignore frame/foregroundStyle applied directly to the
  // image; size + tint them through a container the resizable image fills.
  const renderMark = (row: AgentActivityRowProps, size: number, animated: boolean) => {
    const mark = signalFor(row.phase).mark;
    const tint = tintFor(row.phase);
    // One quick in-place swap when the phase changes; nothing moves or repeats.
    const motion = animated
      ? [animation(Animation.easeOut({ duration: 0.3 }), signalFor(row.phase).index)]
      : [];
    return (
      <HStack
        modifiers={[
          frame({ width: Math.round(size * 1.3), height: size }),
          foregroundStyle(tint),
          ...motion,
        ]}
      >
        {"text" in mark ? (
          <Text
            modifiers={[
              font({ weight: "bold", size: Math.round(size * 0.95), design: "monospaced" }),
              lineLimit(1),
              contentTransition("interpolate"),
            ]}
          >
            {mark.text}
          </Text>
        ) : (
          <HStack modifiers={[frame({ width: size * 0.9, height: size * 0.9 })]}>
            <Image systemName={mark.symbol} modifiers={[resizable()]} />
          </HStack>
        )}
      </HStack>
    );
  };

  const renderLogo = (height: number) => (
    <HStack
      modifiers={[
        frame({ width: height * 1.5, height }),
        foregroundStyle(primaryForeground),
        accessibilityLabel("T3 Code"),
      ]}
    >
      <Image assetName="T3Mark" modifiers={[resizable()]} />
    </HStack>
  );

  const renderNeed = (row: AgentActivityRowProps, label: string, size: number) => (
    <Text
      modifiers={[
        font({ weight: "semibold", size }),
        foregroundStyle(tintFor(row.phase)),
        lineLimit(1),
        layoutPriority(1),
      ]}
    >
      {label}
    </Text>
  );

  const renderCaption = (row: AgentActivityRowProps) => (
    <HStack spacing={4} alignment="center">
      {renderNeed(row, signalFor(row.phase).need ?? row.status, 12)}
      <Text modifiers={[font({ size: 12 }), foregroundStyle(secondaryForeground), lineLimit(1)]}>
        {`· ${row.projectTitle}`}
      </Text>
      <Spacer minLength={0} />
    </HStack>
  );

  const renderHero = (
    row: AgentActivityRowProps,
    markSize: number,
    titleSize: number,
    caption: ReactNode,
  ) => (
    <HStack spacing={Math.round(markSize * 0.4)} alignment="center">
      {renderMark(row, markSize, true)}
      <VStack alignment="leading" spacing={2}>
        <Text
          modifiers={[
            font({ weight: "semibold", size: titleSize }),
            foregroundStyle(primaryForeground),
            lineLimit(1),
            truncationMode("tail"),
          ]}
        >
          {row.threadTitle}
        </Text>
        {caption}
      </VStack>
      <Spacer minLength={0} />
    </HStack>
  );

  const renderOther = (row: AgentActivityRowProps) => (
    <HStack spacing={8} alignment="center">
      {renderMark(row, 12, false)}
      <Text
        modifiers={[
          font({ weight: "medium", size: 13 }),
          foregroundStyle(secondaryForeground),
          lineLimit(1),
          truncationMode("tail"),
        ]}
      >
        {row.threadTitle}
      </Text>
      <Spacer minLength={8} />
      <Text
        modifiers={[
          font({ weight: "semibold", size: 12 }),
          foregroundStyle(
            signalFor(row.phase).rank === 0 ? tintFor(row.phase) : secondaryForeground,
          ),
          lineLimit(1),
          layoutPriority(1),
        ]}
      >
        {row.status}
      </Text>
    </HStack>
  );

  const hiddenCount = (capacity: number) =>
    Math.max(threadCount - 1 - Math.min(capacity, others.length), 0);
  const renderMore = (capacity: number) =>
    hiddenCount(capacity) > 0 ? (
      <Text modifiers={[font({ size: 12 }), foregroundStyle(tertiaryForeground)]}>
        {`+${hiddenCount(capacity)} more`}
      </Text>
    ) : null;

  const renderHeader = (size: number, withSummary = true) => (
    <HStack spacing={Math.round(size * 0.7)} alignment="center">
      {renderLogo(size)}
      {withSummary && summary ? (
        <Text modifiers={[font({ size }), foregroundStyle(secondaryForeground), lineLimit(1)]}>
          {summary}
        </Text>
      ) : null}
      <Spacer minLength={0} />
    </HStack>
  );

  // StandBy spreads the banner across the screen, read from across a desk.
  const standBy = environment.isActivityFullscreen === true;
  const standByNeed = hero ? (signalFor(hero.phase).need ?? hero.status) : null;
  // StandBy drops a one-part summary that only repeats the need line.
  const standBySummary =
    summaryParts.length > 1 || (coversOthers && summaryParts[0] !== standByNeed);
  // The small family (Apple Watch Smart Stack, CarPlay) has room for one fact.
  const glanceNeed = hero
    ? (signalFor(hero.phase).need ??
      (signalFor(hero.phase).rank === 2 && workingCount > 0
        ? `${workingCount} working`
        : hero.status))
    : null;

  // While agents only work, the compact island stays a quiet prompt; words appear
  // only when a thread needs the user or failed.
  const heroSpeaks = hero ? signalFor(hero.phase).rank <= 1 : false;

  return {
    banner: (
      <VStack
        alignment="leading"
        spacing={standBy ? 14 : 10}
        modifiers={[
          padding({ all: standBy ? 18 : 14 }),
          // A clear tint reveals iOS 26's glass material; older hosts keep the standard surface.
          activityBackgroundTint(environment.isLiquidGlassAvailable ? "clear" : null),
          accessibilityElement("ignore"),
          accessibilityLabel(standBy ? glanceLabel : cardLabel),
          ...linkModifiers,
        ]}
      >
        {standBy ? null : renderHeader(12)}
        {hero
          ? standBy
            ? renderHero(hero, 44, 22, renderNeed(hero, standByNeed ?? hero.status, 17))
            : renderHero(hero, 24, 15, renderCaption(hero))
          : null}
        {standBy ? renderHeader(15, standBySummary) : null}
        {!standBy && (other0 || other1 || other2) ? (
          <VStack alignment="leading" spacing={6}>
            {other0 ? renderOther(other0) : null}
            {other1 ? renderOther(other1) : null}
            {other2 ? renderOther(other2) : null}
            {renderMore(3)}
          </VStack>
        ) : null}
      </VStack>
    ),
    bannerSmall: (
      <VStack
        alignment="leading"
        spacing={4}
        modifiers={[
          padding({ all: 10 }),
          accessibilityElement("ignore"),
          accessibilityLabel(glanceLabel),
          ...linkModifiers,
        ]}
      >
        <HStack spacing={6} alignment="center">
          {hero ? renderMark(hero, 20, true) : renderLogo(16)}
          {hero && glanceNeed !== null ? renderNeed(hero, glanceNeed, 15) : null}
          <Spacer minLength={0} />
        </HStack>
        {hero ? (
          <Text
            modifiers={[
              font({ weight: "semibold", size: 16 }),
              foregroundStyle(primaryForeground),
              lineLimit(1),
              truncationMode("tail"),
            ]}
          >
            {hero.threadTitle}
          </Text>
        ) : null}
      </VStack>
    ),
    compactLeading: (
      <HStack modifiers={[padding({ leading: 2 }), ...linkModifiers]}>{renderLogo(14)}</HStack>
    ),
    compactTrailing: hero ? (
      <HStack
        spacing={4}
        alignment="center"
        modifiers={[
          padding({ trailing: 2 }),
          accessibilityElement("ignore"),
          accessibilityLabel(glanceLabel),
          ...linkModifiers,
        ]}
      >
        {renderMark(hero, 14, true)}
        {heroSpeaks ? (
          <Text
            modifiers={[
              font({ weight: "semibold", size: 12 }),
              foregroundStyle(tintFor(hero.phase)),
              lineLimit(1),
            ]}
          >
            {hero.status}
          </Text>
        ) : null}
      </HStack>
    ) : null,
    minimal: hero ? (
      <HStack
        modifiers={[
          accessibilityElement("ignore"),
          accessibilityLabel(glanceLabel),
          ...linkModifiers,
        ]}
      >
        {renderMark(hero, 14, true)}
      </HStack>
    ) : (
      <HStack modifiers={linkModifiers}>{renderLogo(11)}</HStack>
    ),
    expandedLeading: (
      <HStack modifiers={[padding({ leading: 4, vertical: 4 }), ...linkModifiers]}>
        {renderLogo(15)}
      </HStack>
    ),
    expandedCenter: null,
    expandedTrailing: null,
    expandedBottom: (
      <VStack
        alignment="leading"
        spacing={8}
        modifiers={[
          padding({ vertical: 2, horizontal: 8 }),
          accessibilityElement("ignore"),
          accessibilityLabel(cardLabel),
          ...linkModifiers,
        ]}
      >
        {hero ? renderHero(hero, 24, 15, renderCaption(hero)) : null}
        {other0 || other1 ? (
          <VStack alignment="leading" spacing={5}>
            {other0 ? renderOther(other0) : null}
            {other1 ? renderOther(other1) : null}
            {renderMore(2)}
          </VStack>
        ) : null}
      </VStack>
    ),
  };
}

export default createLiveActivity<AgentActivityProps>("AgentActivity", AgentActivity);
