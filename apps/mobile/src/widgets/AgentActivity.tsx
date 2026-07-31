import { Circle, HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import type { ComponentProps } from "react";
import {
  background,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  padding,
  resizable,
  shapes,
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
  readonly providerName?: string;
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

  // Use SwiftUI's semantic label colors rather than fixed hex keyed off the
  // device color scheme. A Live Activity banner always renders over a dark
  // system material regardless of the device's light/dark setting, so
  // scheme-derived dark text read as unreadable dark-on-dark on the lock
  // screen. Semantic colors adapt to whatever material the OS places them on,
  // including the dark iPhone material and light macOS notification surface.
  //
  // For the same reason there is no `activityBackgroundTint` here: a forced
  // black panel would pin the background while the labels keep adapting to the
  // material, which is how you get black-on-black on macOS.
  // The iPhone lock screen's own material is already near-black.
  const primaryForeground = "primary";
  const secondaryForeground = "secondary";

  // The phase palette uses cyan for working, orange for blocked, green for done,
  // red for failed, and gray for stale, expressed as Apple's system colors.
  // On iPhone the Live Activity sits on a dark material, but
  // macOS (iPhone Mirroring / Mac notification center) renders it on a light
  // one, so pick the light or dark variant off the color scheme.
  const isLightScheme = environment.colorScheme === "light";
  const phaseTint = (phase: AgentActivityPhase | undefined): string => {
    if (environment.isLuminanceReduced) {
      return secondaryForeground;
    }
    switch (phase) {
      // Approval and input share a color; the glyph and status label carry the
      // difference.
      case "waiting_for_approval":
      case "waiting_for_input":
        return isLightScheme ? "#ff9500" : "#ff9f0a"; // systemOrange
      case "failed":
        return isLightScheme ? "#ff3b30" : "#ff453a"; // systemRed
      case "completed":
        return isLightScheme ? "#34c759" : "#30d158"; // systemGreen
      case "stale":
        return isLightScheme ? "#8e8e93" : "#98989d"; // systemGray
      case "starting":
      case "running":
      default:
        return isLightScheme ? "#32ade6" : "#64d2ff"; // systemCyan
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
  const ordered = [...props.activities].sort(
    (a, b) => phasePriority(a.phase) - phasePriority(b.phase),
  );
  const topRow = ordered[0];
  // `activities` is capped by the relay, but `activeCount` is not. Include
  // active rows omitted upstream as well as any terminal rows riding along.
  const representedActiveCount = ordered.filter(
    (row) => row.phase !== "completed" && row.phase !== "failed",
  ).length;
  const representedTerminalCount = ordered.length - representedActiveCount;
  const totalRowCount =
    Math.max(props.activeCount, representedActiveCount) + representedTerminalCount;

  const attentionRows = props.activities.filter(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
  const attentionRow = attentionRows[0];
  const failedRow = props.activities.find((row) => row.phase === "failed");
  const activeRow = ordered.find((row) => row.phase !== "completed" && row.phase !== "failed");

  // With nothing active the aggregate only carries recently finished work, so
  // "0 active agents" (and a lone "0" in the expanded island) read as broken.
  // Lead with the outcome instead.
  const allDone = props.activeCount === 0;
  // A recently failed row can remain in the aggregate while other work is
  // active. It should stay visible in the list, but must not replace the
  // compact/Watch status of the active work.
  const heroRow = attentionRow ?? (allDone ? (failedRow ?? topRow) : activeRow);
  const tint = phaseTint(heroRow?.phase);
  // Headline count leans on the accent when a human is actually blocked.
  const headerTint = attentionRow ? phaseTint(attentionRow.phase) : tint;

  // The outcome is derived here from the rows rather than taken from the
  // server subtitle (which keys off the newest terminal row): every
  // presentation — header text, tint, count slots, minimal glyph — must agree,
  // and a failure anywhere should dominate a newer success once all work has
  // stopped.
  const doneLabel = failedRow ? "Failed" : "Done";
  const outcomeLabel = failedRow ? "Agent work failed" : "Agent work completed";

  // Header copy: "5 active agents" + (", 1 needs attention"). The banner renders
  // the two parts in-line so the attention half can carry the accent color.
  const agentWord = props.activeCount === 1 ? "agent" : "agents";
  const agentsLabel = allDone ? outcomeLabel : `${props.activeCount} active ${agentWord}`;
  const attentionSuffix =
    attentionRows.length > 0
      ? `${attentionRows.length} need${attentionRows.length === 1 ? "s" : ""} attention`
      : "";

  // Keep phase labels terse because both island regions are only ~50pt wide —
  // the long forms truncated to "Needs a...". This also matches the
  // status the relay puts on each row (AgentActivityPublisher statusForPhase),
  // so the pill and the cards read the same words.
  const pillHeadline = (phase: AgentActivityPhase | undefined): string => {
    switch (phase) {
      case "starting":
        return "Starting";
      case "waiting_for_approval":
        return "Approval";
      case "waiting_for_input":
        return "Input";
      case "completed":
        return "Done";
      case "failed":
        return "Failed";
      case "stale":
        return "Stale";
      case "running":
        return "Working";
      default:
        return "Idle";
    }
  };
  const pillLabel = allDone ? doneLabel : pillHeadline(heroRow?.phase);

  // Any registered scheme variant routes back to this app; taps are delivered
  // to the widget's containing app, so the prod scheme is safe for all builds.
  const deepLinkRow = heroRow;
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

  // The status dot does not breathe the way a desktop pulse can: a Live Activity
  // cannot animate between pushes, and a repainting view would
  // burn the update budget for no signal.
  const renderDot = (size: number, color: string) => (
    <Circle
      key={`dot-${color}`}
      modifiers={[frame({ width: size, height: size }), foregroundStyle(color)]}
    />
  );

  // Use a plain bold count rather than a white pill: `background` on a Text,
  // on a wrapping HStack, and a Capsule view behind the label all rendered as a
  // bare glyph in the island regions, so the pill is not worth more machinery.
  const renderCountBadge = (count: number) => (
    <Text
      key="count"
      modifiers={[
        font({ weight: "bold", size: 12, design: "rounded" }),
        foregroundStyle(primaryForeground),
      ]}
    >
      {`${count}`}
    </Text>
  );

  // A provider mark and brand tint head each card. Provider identity comes
  // from the orchestration session rather than the model title: Cursor and
  // Claude can both run GPT-named models without becoming Codex.
  const brandFor = (
    providerName: string | undefined,
  ): { readonly asset: string; readonly tint: string; readonly label: string } => {
    const raw = providerName?.toLowerCase() ?? "";
    // Tints match apps/web's provider icons; each mark is a template image, so
    // the container's foreground style is what colours it.
    if (raw.startsWith("claude") || raw.includes("anthropic") || raw.startsWith("opus")) {
      return { asset: "Claude", tint: "#d97757", label: "Claude" };
    }
    if (raw.startsWith("cursor") || raw.startsWith("composer")) {
      return { asset: "Cursor", tint: primaryForeground, label: "Cursor" };
    }
    if (raw.startsWith("opencode")) {
      return { asset: "OpenCode", tint: primaryForeground, label: "OpenCode" };
    }
    if (raw.startsWith("grok") || raw.startsWith("xai")) {
      return { asset: "Grok", tint: primaryForeground, label: "Grok" };
    }
    if (
      raw.startsWith("gpt") ||
      raw.startsWith("o1") ||
      raw.startsWith("o3") ||
      raw.startsWith("o4") ||
      raw.includes("codex") ||
      raw.includes("openai")
    ) {
      return { asset: "Codex", tint: primaryForeground, label: "Codex" };
    }
    // Nothing recognizable: fall back to the T3 mark rather than an empty slot.
    return { asset: "T3Mark", tint: secondaryForeground, label: "Agent" };
  };

  // Same container trick as the T3 mark: Image only honors `resizable`, so the
  // frame sizes it and the container's foreground style tints the template.
  // Square frame — the provider marks are all roughly 1:1, unlike the wordmark.
  const renderMark = (assetName: string, size: number, color: string) => (
    <HStack modifiers={[frame({ width: size, height: size }), foregroundStyle(color)]}>
      <Image assetName={assetName} modifiers={[resizable()]} />
    </HStack>
  );

  // Use one neutral gray slab for every row rather than tinting blocked rows,
  // which muddied the card without saying anything the
  // phase dot and the status label do not already say. Grey rather than
  // white-with-alpha, because the same slab has to read on the lock screen's
  // dark material and on macOS's light one.
  const cardFill = "#8e8e9333";

  // One line per agent: provider mark, thread title, the project it lives in,
  // then the phase dot and status. Two-line cards only fitted two and a bit in
  // the expanded island, and the mark already says what the model text did.
  // The status carries layoutPriority(1) so the title is what truncates.
  const renderCard = (row: AgentActivityRowProps, key: string) => (
    <HStack
      key={key}
      spacing={6}
      alignment="center"
      modifiers={[
        padding({ horizontal: 8, vertical: 3 }),
        background(
          cardFill,
          shapes.roundedRectangle({ cornerRadius: 9, roundedCornerStyle: "continuous" }),
        ),
      ]}
    >
      {renderMark(brandFor(row.providerName).asset, 11, brandFor(row.providerName).tint)}
      <Text
        modifiers={[
          font({ weight: "semibold", size: 12, design: "rounded" }),
          foregroundStyle(primaryForeground),
          lineLimit(1),
        ]}
      >
        {row.threadTitle}
      </Text>
      {/* Which project this agent is working in, kept grey and small so it reads
          as a qualifier on the title rather than competing with it. */}
      <Text
        modifiers={[
          font({ size: 10, design: "rounded" }),
          foregroundStyle(secondaryForeground),
          lineLimit(1),
        ]}
      >
        {row.projectTitle}
      </Text>
      <Spacer minLength={6} />
      {renderDot(4, phaseTint(row.phase))}
      <Text
        modifiers={[
          font({ weight: "semibold", size: 10, design: "rounded" }),
          foregroundStyle(phaseTint(row.phase)),
          lineLimit(1),
          layoutPriority(1),
        ]}
      >
        {row.status}
      </Text>
    </HStack>
  );

  // Four rows is what the expanded island's ~110pt of content height allows at
  // one line each; the rest are counted off rather than silently dropped.
  const renderCards = (limit: number) => {
    const nodes = [];
    const shown = ordered.slice(0, limit);
    for (let index = 0; index < shown.length; index++) {
      nodes.push(renderCard(shown[index]!, `card-${index}`));
    }
    const overflow = totalRowCount - shown.length;
    if (overflow > 0) {
      nodes.push(
        <Text
          key="overflow"
          modifiers={[
            font({ weight: "medium", size: 10, design: "rounded" }),
            foregroundStyle(secondaryForeground),
          ]}
        >
          {`+${overflow} more`}
        </Text>,
      );
    }
    return nodes;
  };

  // The branded T3 mark. `assetName` resolves the template image set bundled in
  // the widget extension's asset catalog. Image views only honor `resizable`
  // directly (frame/foregroundStyle are dropped), so we size it via a container
  // frame the resizable image fills and tint it through the container's
  // foreground style, which the template image inherits. The 3:2 frame matches
  // the glyph's aspect ratio so it never distorts.
  const renderLogo = (height: number, color: string) => (
    <HStack key="logo" modifiers={[frame({ width: height * 1.5, height }), foregroundStyle(color)]}>
      <Image assetName="T3Mark" modifiers={[resizable()]} />
    </HStack>
  );

  // The top strip places the mark and phase dot on the leading edge, and on the
  // trailing shoulder whatever needs a human plus the agent count. The
  // label is plain white like the desktop strip's — the colour lives in the dot
  // and in the per-card status, so a glance reads phase from one place.
  const renderStrip = (logoHeight: number, label: string, withCount: boolean) => {
    // Built as an array rather than JSX with conditionals: a child that resolves
    // to null leaves a hole in the serialized children and the native walk stops
    // there, so an unblocked aggregate lost the count that followed the absent
    // attention line.
    const cells = [
      renderLogo(logoHeight, primaryForeground),
      renderDot(5, tint),
      <Text
        key="label"
        modifiers={[
          font({ weight: "semibold", size: 13, design: "rounded" }),
          foregroundStyle(primaryForeground),
          lineLimit(1),
        ]}
      >
        {label}
      </Text>,
      <Spacer key="gap" minLength={8} />,
    ];
    if (attentionSuffix) {
      cells.push(
        <Text
          key="attention"
          modifiers={[
            font({ weight: "semibold", size: 12, design: "rounded" }),
            foregroundStyle(headerTint),
            lineLimit(1),
            layoutPriority(1),
          ]}
        >
          {attentionSuffix}
        </Text>,
      );
    }
    // The banner's headline already reads "5 active agents", so repeating the
    // number on the shoulder is just two 5s. The island keeps it: there the
    // label is only the phase word.
    if (withCount && props.activeCount > 1) {
      cells.push(renderCountBadge(props.activeCount));
    }
    return (
      <HStack key="strip" spacing={6} alignment="center">
        {cells}
      </HStack>
    );
  };

  // The watchOS Smart Stack is substantially narrower than the Lock Screen
  // banner. Reusing the full strip there made the phase label collapse to an
  // ellipsis between the logo and "1 needs attention", while the row repeated
  // the same phase and sacrificed most of the useful thread title.
  const watchHeadline = attentionRow ? "Needs attention" : allDone ? doneLabel : "Agents active";
  const renderWatchStrip = () => (
    <HStack key="watch-strip" spacing={6} alignment="center">
      {renderLogo(13, primaryForeground)}
      {renderDot(5, tint)}
      <Text
        modifiers={[
          font({ weight: "semibold", size: 12, design: "rounded" }),
          foregroundStyle(headerTint),
          lineLimit(1),
          layoutPriority(1),
        ]}
      >
        {watchHeadline}
      </Text>
      <Spacer minLength={4} />
      {props.activeCount > 0 ? renderCountBadge(props.activeCount) : null}
    </HStack>
  );

  // A dedicated two-line Watch row gives the task title the entire first line.
  // Project and phase become compact metadata underneath instead of four peers
  // competing across one narrow HStack.
  const renderWatchCard = (row: AgentActivityRowProps) => (
    <HStack
      key="watch-card"
      spacing={7}
      alignment="center"
      modifiers={[
        padding({ horizontal: 8, vertical: 5 }),
        background(
          cardFill,
          shapes.roundedRectangle({ cornerRadius: 10, roundedCornerStyle: "continuous" }),
        ),
      ]}
    >
      {renderMark(brandFor(row.providerName).asset, 13, brandFor(row.providerName).tint)}
      <VStack
        alignment="leading"
        spacing={1}
        modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
      >
        <Text
          modifiers={[
            font({ weight: "semibold", size: 12, design: "rounded" }),
            foregroundStyle(primaryForeground),
            lineLimit(1),
            layoutPriority(1),
          ]}
        >
          {row.threadTitle}
        </Text>
        <HStack spacing={4} alignment="center">
          <Text
            modifiers={[
              font({ size: 9, design: "rounded" }),
              foregroundStyle(secondaryForeground),
              lineLimit(1),
            ]}
          >
            {row.projectTitle}
          </Text>
          <Spacer minLength={4} />
          {renderDot(4, phaseTint(row.phase))}
          <Text
            modifiers={[
              font({ weight: "semibold", size: 9, design: "rounded" }),
              foregroundStyle(phaseTint(row.phase)),
              lineLimit(1),
              layoutPriority(1),
            ]}
          >
            {row.status}
          </Text>
        </HStack>
      </VStack>
    </HStack>
  );

  const watchOverflow = Math.max(0, totalRowCount - (heroRow ? 1 : 0));

  return {
    banner: (
      <VStack
        alignment="leading"
        spacing={6}
        modifiers={deepLink ? [padding({ all: 14 }), widgetURL(deepLink)] : [padding({ all: 14 })]}
      >
        {/* Flat, not [strip, [cards]]: the widget runtime's JSX stub keeps
            children exactly as given, so a nested array is not a node it can
            walk and every row silently vanished. Four rows is what fits the
            lock screen's budget; the rest are counted off at the end. */}
        {[renderStrip(13, agentsLabel, false), ...renderCards(4)]}
      </VStack>
    ),
    // Compact card for the watchOS Smart Stack + CarPlay (the `.small` family).
    // Its own hierarchy avoids squeezing the full Lock Screen banner into the
    // narrow family. Keep the system material so semantic foreground colors
    // remain legible in both light and dark environments.
    bannerSmall: (
      <VStack
        alignment="leading"
        spacing={5}
        modifiers={[
          padding({ all: 10 }),
          frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: "topLeading" }),
        ]}
      >
        {[
          renderWatchStrip(),
          ...(heroRow ? [renderWatchCard(heroRow)] : []),
          ...(watchOverflow > 0
            ? [
                <Text
                  key="watch-overflow"
                  modifiers={[
                    font({ weight: "medium", size: 10, design: "rounded" }),
                    foregroundStyle(secondaryForeground),
                  ]}
                >
                  {`+${watchOverflow} more`}
                </Text>,
              ]
            : []),
        ]}
      </VStack>
    ),
    // The collapsed island shows the mark plus phase dot on one shoulder, and
    // the phase headline plus agent count on the other.
    compactLeading: (
      <HStack spacing={4} alignment="center">
        {renderLogo(14, primaryForeground)}
        {renderDot(4, tint)}
      </HStack>
    ),
    compactTrailing: (
      <HStack spacing={5} alignment="center">
        <Text
          modifiers={[
            font({ weight: "semibold", size: 11, design: "rounded" }),
            foregroundStyle(primaryForeground),
            lineLimit(1),
          ]}
        >
          {pillLabel}
        </Text>
        {props.activeCount > 1 ? renderCountBadge(props.activeCount) : null}
      </HStack>
    ),
    // The shared/minimal form is a ~22pt circle — a single signal reads there,
    // the wordmark does not. Show the blocking/outcome phase glyph, else the
    // mark (all-done shows the hero row's checkmark/cross).
    minimal:
      (attentionRow || allDone) && heroRow
        ? renderGlyph(phaseSymbol(heroRow.phase), 13, phaseTint(heroRow.phase))
        : renderLogo(11, tint),
    expandedLeading: (
      <HStack spacing={5} alignment="center" modifiers={[padding({ leading: 4, vertical: 4 })]}>
        {renderLogo(15, primaryForeground)}
        {renderDot(5, tint)}
        <Text
          modifiers={[
            font({ weight: "bold", size: 13, design: "rounded" }),
            foregroundStyle(primaryForeground),
            lineLimit(1),
          ]}
        >
          {pillLabel}
        </Text>
      </HStack>
    ),
    // No center content: the status dots + statuses on the cards already carry
    // the attention signal, and the expanded island's height budget is tight
    // enough that a summary line there costs a whole card.
    expandedCenter: null,
    // Keep the agent count on the top strip's trailing shoulder. The region hugs
    // the island's corner radius, so the count gets trailing padding
    // to stay clear of the curve.
    expandedTrailing:
      props.activeCount > 1 ? (
        <HStack modifiers={[padding({ trailing: 5, vertical: 4 })]}>
          {renderCountBadge(props.activeCount)}
        </HStack>
      ) : null,
    expandedBottom: (
      // Vertical padding only for the cards themselves: the expanded region
      // provides its own horizontal content margins, so `all` padding
      // double-indented them. Horizontal padding keeps both edges clear of the
      // island's corner curvature (right edge clipped status labels; titles
      // hugged the left). Two cards is what the region's height allows.
      <VStack
        alignment="leading"
        spacing={4}
        modifiers={
          deepLink
            ? [padding({ vertical: 2, horizontal: 8 }), widgetURL(deepLink)]
            : [padding({ vertical: 2, horizontal: 8 })]
        }
      >
        {[...renderCards(4)]}
      </VStack>
    ),
  };
}

export default createLiveActivity<AgentActivityProps>("AgentActivity", AgentActivity);
