import {
  AccessoryWidgetBackground,
  HStack,
  Image,
  Link,
  Spacer,
  Text,
  VStack,
  ZStack,
} from "@expo/ui/swift-ui";
import type { ComponentProps } from "react";
import {
  accessibilityElement,
  accessibilityLabel,
  background,
  containerBackground,
  environment,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  padding,
  resizable,
  shapes,
  truncationMode,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";

import type { AgentActivityPhase } from "./AgentActivity";
import type { AgentStatusSnapshot, AgentStatusThread } from "./agentStatusSnapshot";

// Widget serialization excludes module helpers; use only imported view/modifier factories.
function AgentStatus(
  props: Partial<AgentStatusSnapshot> | undefined,
  widgetEnvironment: WidgetEnvironment & { showsContainerBackground?: boolean },
) {
  "widget";

  // Before the app's first publish the widget renders with no props.
  const snapshot: Partial<AgentStatusSnapshot> = props ?? {};
  type Foreground = Parameters<typeof foregroundStyle>[0];
  type SFName = NonNullable<ComponentProps<typeof Image>["systemName"]>;
  const primaryForeground = { type: "hierarchical", style: "primary" } as const;
  const secondaryForeground = { type: "hierarchical", style: "secondary" } as const;
  const tertiaryForeground = { type: "hierarchical", style: "tertiary" } as const;

  const family = widgetEnvironment.widgetFamily ?? "systemSmall";
  const accessory = family.startsWith("accessory");
  // Gallery snapshots can render an old timeline entry after it has expired.
  const now = Math.max(widgetEnvironment.date?.getTime() ?? 0, Date.now());
  // Tinted, clear, Lock Screen, and Always-On drop the phase colors; each mark's shape still names the state.
  const monochrome =
    widgetEnvironment.widgetRenderingMode !== "fullColor" ||
    widgetEnvironment.isLuminanceReduced === true;
  const mode = snapshot.theme?.mode;
  const appearance =
    mode === "light" || mode === "dark"
      ? mode
      : widgetEnvironment.colorScheme === "dark"
        ? "dark"
        : "light";
  // StandBy can remove the card even in full color; text must then follow the host.
  const palette =
    !accessory && !monochrome && widgetEnvironment.showsContainerBackground !== false
      ? snapshot.theme?.[appearance]
      : undefined;

  // The Live Activity's Terminal cursor marks, colors, and words, so both read as one system.
  const SIGNALS: Record<
    AgentActivityPhase,
    {
      readonly mark: { readonly text: string } | { readonly symbol: SFName };
      readonly light: string | null;
      readonly dark: string | null;
      readonly spoken: string;
      readonly label: string;
      readonly rank: number;
    }
  > = {
    waiting_for_approval: {
      mark: { symbol: "exclamationmark.shield.fill" },
      light: "#d97706",
      dark: "#fcd34d",
      spoken: "needs approval",
      label: "Needs approval",
      rank: 0,
    },
    waiting_for_input: {
      mark: { text: "›?" },
      light: "#4f46e5",
      dark: "#a5b4fc",
      spoken: "needs your input",
      label: "Needs your input",
      rank: 0,
    },
    failed: {
      mark: { symbol: "xmark.octagon.fill" },
      light: "#dc2626",
      dark: "#fca5a5",
      spoken: "failed",
      label: "Failed",
      rank: 1,
    },
    starting: {
      mark: { text: "›" },
      light: "#0284c7",
      dark: "#7dd3fc",
      spoken: "is starting",
      label: "Starting",
      rank: 2,
    },
    running: {
      mark: { text: "›_" },
      light: "#0284c7",
      dark: "#7dd3fc",
      spoken: "is working",
      label: "Working",
      rank: 2,
    },
    completed: {
      mark: { symbol: "checkmark" },
      light: "#059669",
      dark: "#6ee7b7",
      spoken: "is done",
      label: "Done",
      rank: 3,
    },
    stale: {
      mark: { symbol: "clock.arrow.circlepath" },
      light: null,
      dark: null,
      spoken: "status is out of date",
      label: "Out of date",
      rank: 3,
    },
  };

  const tintFor = (phase: AgentActivityPhase): Foreground => {
    const signal = SIGNALS[phase];
    const color = appearance === "light" ? signal.light : signal.dark;
    if (color === null) return secondaryForeground;
    return monochrome ? primaryForeground : color;
  };

  const published = snapshot.threads !== undefined && snapshot.checkedAt !== undefined;
  const checkedAt = snapshot.checkedAt ?? 0;
  const stale = published && now >= (snapshot.expiresAt ?? 0);
  // Once stale, in-flight rows cannot claim work or a pending request; outcomes stay true.
  // A phase this build does not know claims nothing either.
  const threads: ReadonlyArray<AgentStatusThread> = (snapshot.threads ?? [])
    .map((thread) =>
      SIGNALS[thread.phase] === undefined ||
      (stale && thread.phase !== "completed" && thread.phase !== "failed")
        ? { ...thread, phase: "stale" as const }
        : thread,
    )
    // Rank again after the stale mapping so failures lead, as in the Live Activity.
    .sort((a, b) => SIGNALS[a.phase].rank - SIGNALS[b.phase].rank);
  const hero = threads[0];
  const others = threads.slice(1);

  const counts = snapshot.counts ?? { needsYou: 0, working: 0, failed: 0, done: 0 };
  const total = counts.needsYou + counts.working + counts.failed + counts.done;
  const summaryParts = [
    stale ? "Out of date" : null,
    !stale && counts.needsYou > 0
      ? `${counts.needsYou} need${counts.needsYou === 1 ? "s" : ""} you`
      : null,
    !stale && counts.working > 0 ? `${counts.working} working` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    counts.done > 0 ? `${counts.done} done` : null,
  ].filter((part): part is string => part !== null);
  const summary = summaryParts.join(" · ");
  // A stale leading thread already says "Out of date"; its summary line need not repeat it.
  const heroSummary = (
    hero?.phase === "stale" ? summaryParts.filter((part) => part !== "Out of date") : summaryParts
  ).join(" · ");
  const asOf = published
    ? `As of ${new Date(checkedAt).toLocaleString(
        undefined,
        now - checkedAt < 12 * 60 * 60_000
          ? { hour: "numeric", minute: "2-digit" }
          : { month: "short", day: "numeric" },
      )}`
    : "";
  const emptyTitle = published ? "No agents running" : "Open T3 Code to see your agents";

  const describe = (thread: AgentStatusThread) =>
    `${thread.title.trim() || "A thread"} ${SIGNALS[thread.phase].spoken}`;
  const glanceLabel = [
    hero ? describe(hero) : published ? emptyTitle : `T3 Code. ${emptyTitle}`,
    summaryParts.length > 0 ? summaryParts.join(", ") : null,
    published ? asOf : null,
  ]
    .filter((part): part is string => part !== null)
    .join(". ");
  // The mark's own category, so a lone number beside it never needs a label.
  const heroCount = hero
    ? [counts.needsYou, counts.failed, counts.working, counts.done][SIGNALS[hero.phase].rank]
    : undefined;
  const heroCountShown = hero && hero.phase !== "stale" && heroCount ? heroCount : null;

  const tapURL = hero?.url ?? snapshot.url;
  const rootModifiers = [
    ...(tapURL ? [widgetURL(tapURL)] : []),
    ...(palette
      ? [containerBackground(palette.background, "widget"), environment("colorScheme", appearance)]
      : []),
  ];

  // SF Symbols ignore frame/foregroundStyle applied directly to the image; size and
  // tint them through a container the resizable image fills.
  const renderMark = (phase: AgentActivityPhase, size: number) => {
    const mark = SIGNALS[phase].mark;
    return (
      <HStack
        modifiers={[
          frame({ width: Math.round(size * 1.3), height: size }),
          foregroundStyle(tintFor(phase)),
        ]}
      >
        {"text" in mark ? (
          <Text
            modifiers={[
              font({ weight: "bold", size: Math.round(size * 0.95), design: "monospaced" }),
              lineLimit(1),
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
  const emptyPhase: AgentActivityPhase = stale ? "stale" : "starting";

  const renderLine = (text: string, size: number, foreground: Foreground, weight?: "semibold") => (
    <Text
      modifiers={[
        font(weight ? { size, weight } : { size }),
        foregroundStyle(foreground),
        lineLimit(1),
        truncationMode("tail"),
      ]}
    >
      {text}
    </Text>
  );

  if (family === "accessoryInline") {
    const mark = SIGNALS[hero?.phase ?? emptyPhase].mark;
    const words = summary || (hero ? SIGNALS[hero.phase].label : emptyTitle);
    return (
      <HStack
        modifiers={[
          accessibilityElement("ignore"),
          accessibilityLabel(glanceLabel),
          ...rootModifiers,
        ]}
      >
        {"symbol" in mark ? <Image systemName={mark.symbol} /> : null}
        <Text>{"text" in mark ? `${mark.text} ${words}` : words}</Text>
      </HStack>
    );
  }

  if (family === "accessoryCircular") {
    return (
      <ZStack
        modifiers={[
          accessibilityElement("ignore"),
          accessibilityLabel(glanceLabel),
          ...rootModifiers,
        ]}
      >
        <AccessoryWidgetBackground />
        <VStack spacing={1}>
          {renderMark(hero?.phase ?? emptyPhase, heroCountShown === null ? 22 : 17)}
          {heroCountShown === null ? null : (
            <Text modifiers={[font({ size: 15, weight: "bold", design: "rounded" })]}>
              {`${heroCountShown}`}
            </Text>
          )}
        </VStack>
      </ZStack>
    );
  }

  if (family === "accessoryRectangular") {
    return (
      <VStack
        alignment="leading"
        spacing={1}
        modifiers={[
          frame({ maxWidth: Infinity, alignment: "leading" }),
          accessibilityElement("ignore"),
          accessibilityLabel(glanceLabel),
          ...rootModifiers,
        ]}
      >
        <HStack spacing={4} alignment="center">
          {renderMark(hero?.phase ?? emptyPhase, 13)}
          {renderLine(hero?.title ?? emptyTitle, 15, primaryForeground, "semibold")}
        </HStack>
        {hero ? renderLine(SIGNALS[hero.phase].label, 13, primaryForeground, "semibold") : null}
        {renderLine(heroSummary || asOf, 13, secondaryForeground)}
      </VStack>
    );
  }

  if (family === "systemSmall") {
    return (
      <VStack
        alignment="leading"
        spacing={2}
        modifiers={[
          frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }),
          accessibilityElement("ignore"),
          accessibilityLabel(glanceLabel),
          ...rootModifiers,
        ]}
      >
        {renderMark(hero?.phase ?? emptyPhase, 30)}
        <Spacer minLength={4} />
        <Text
          modifiers={[
            font({ size: 15, weight: "semibold" }),
            foregroundStyle(primaryForeground),
            lineLimit(2),
            truncationMode("tail"),
          ]}
        >
          {hero?.title ?? emptyTitle}
        </Text>
        {hero ? renderLine(SIGNALS[hero.phase].label, 13, tintFor(hero.phase), "semibold") : null}
        {hero && heroSummary ? renderLine(heroSummary, 12, secondaryForeground) : null}
        {published ? renderLine(asOf, 11, tertiaryForeground) : null}
      </VStack>
    );
  }

  // Thread stack: each thread is an editor tab; the one that needs the user comes forward.
  const slots = family === "systemMedium" ? 2 : 7;
  const shown = others.length <= slots ? others : others.slice(0, slots - 1);
  // Counts cover every thread, including those the snapshot left out.
  const hidden = Math.max(total - 1 - shown.length, others.length - shown.length, 0);
  const renderLeadingTab = (thread: AgentStatusThread) => (
    <Link destination={thread.url}>
      <HStack
        spacing={10}
        alignment="center"
        modifiers={[
          padding({ vertical: 8, horizontal: 10 }),
          background(
            { type: "hierarchical", style: "quaternary" },
            shapes.roundedRectangle({ cornerRadius: 10 }),
          ),
          accessibilityElement("ignore"),
          accessibilityLabel(`${describe(thread)}, ${thread.project}`),
        ]}
      >
        {renderMark(thread.phase, 22)}
        <VStack alignment="leading" spacing={2}>
          {renderLine(thread.title, 15, primaryForeground, "semibold")}
          <HStack spacing={4} alignment="center">
            <Text
              modifiers={[
                font({ size: 12, weight: "semibold" }),
                foregroundStyle(tintFor(thread.phase)),
                lineLimit(1),
                layoutPriority(1),
              ]}
            >
              {SIGNALS[thread.phase].label}
            </Text>
            {renderLine(`· ${thread.project}`, 12, secondaryForeground)}
          </HStack>
        </VStack>
        <Spacer minLength={0} />
      </HStack>
    </Link>
  );
  const renderTab = (thread: AgentStatusThread) => (
    <Link key={thread.url} destination={thread.url}>
      <HStack
        spacing={8}
        alignment="center"
        modifiers={[
          padding({ horizontal: 10 }),
          accessibilityElement("ignore"),
          accessibilityLabel(`${describe(thread)}, ${thread.project}`),
        ]}
      >
        {renderMark(thread.phase, 12)}
        {renderLine(thread.title, 13, secondaryForeground)}
        <Spacer minLength={8} />
        <Text
          modifiers={[
            font({ size: 12 }),
            foregroundStyle(
              SIGNALS[thread.phase].rank === 0 ? tintFor(thread.phase) : tertiaryForeground,
            ),
            lineLimit(1),
            layoutPriority(1),
          ]}
        >
          {SIGNALS[thread.phase].label}
        </Text>
      </HStack>
    </Link>
  );

  return (
    <VStack
      alignment="leading"
      spacing={family === "systemMedium" ? 6 : 8}
      modifiers={[
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }),
        ...rootModifiers,
      ]}
    >
      <HStack
        spacing={6}
        alignment="center"
        modifiers={[
          accessibilityElement("ignore"),
          accessibilityLabel(
            [summaryParts.length > 0 ? summaryParts.join(", ") : emptyTitle, asOf]
              .filter(Boolean)
              .join(". "),
          ),
        ]}
      >
        <HStack modifiers={[frame({ width: 18, height: 12 }), foregroundStyle(primaryForeground)]}>
          <Image assetName="T3Mark" modifiers={[resizable()]} />
        </HStack>
        {renderLine(summary || "T3 Code", 12, secondaryForeground, "semibold")}
        <Spacer minLength={6} />
        {published ? renderLine(asOf, 11, tertiaryForeground) : null}
      </HStack>
      {hero ? (
        renderLeadingTab(hero)
      ) : (
        <HStack
          spacing={10}
          alignment="center"
          modifiers={[
            padding({ vertical: 8, horizontal: 10 }),
            accessibilityElement("ignore"),
            accessibilityLabel(emptyTitle),
          ]}
        >
          {renderMark(emptyPhase, 22)}
          {renderLine(emptyTitle, 15, primaryForeground, "semibold")}
        </HStack>
      )}
      {shown.map((thread) => renderTab(thread))}
      {hidden > 0 ? (
        <Text
          modifiers={[
            font({ size: 12 }),
            foregroundStyle(tertiaryForeground),
            padding({ horizontal: 10 }),
          ]}
        >
          {`+${hidden} more`}
        </Text>
      ) : null}
    </VStack>
  );
}

export default createWidget<Partial<AgentStatusSnapshot>>("AgentActivity", AgentStatus);
