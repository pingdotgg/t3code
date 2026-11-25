import type { SubagentPillSegment } from "@t3tools/client-runtime/state/thread-subagents";
import { GlassView } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
} from "react-native-reanimated";
import { withUniwind } from "uniwind";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { BrowserPreviewButton } from "../browser/browser-preview-button";
import { DevicePreviewButton } from "../devices/device-preview-button";
import type { FloatingWorkingStatus } from "./floating-working-status";
import { ShimmeringWorkContent } from "./thread-work-log";

const CONTROL_HEIGHT = 38.5;
const CONTROL_GAP = 8;
const COMPOSER_CAPSULE_INSET = 6;
const PILL_HEIGHT = 44;
const CARD_SIDE_MARGIN = 12;
const CARD_MAX_HEIGHT_RATIO = 0.55;
const CARD_MIN_HEIGHT = 120;
const CARD_BOTTOM_GAP = 12;
const MORPH = LinearTransition.duration(320)
  .easing(Easing.bezier(0.2, 0.9, 0.25, 1))
  .reduceMotion(ReduceMotion.System);
const CONTENT_ENTERING = FadeIn.duration(180).delay(90).reduceMotion(ReduceMotion.System);
const CONTENT_EXITING = FadeOut.duration(90).reduceMotion(ReduceMotion.System);
const PILL_ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const PILL_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

const UniwindGlassView = withUniwind(GlassView, {
  style: { fromClassName: "className" },
  tintColor: { fromClassName: "tintColorClassName", styleProperty: "accentColor" },
});
// Lifts the open card off the feed, as other floating glass surfaces do.
const CARD_SHADOW = {
  shadowColor: "#000000",
  shadowOpacity: 0.22,
  shadowRadius: 28,
  shadowOffset: { width: 0, height: 14 },
} as const;
const AnimatedGlassView = Animated.createAnimatedComponent(UniwindGlassView);

const CONTROL_OVERLAY_OFFSET = CONTROL_HEIGHT + CONTROL_GAP - COMPOSER_CAPSULE_INSET;
/** Room the scroll-to-end arrow takes above the composer. */
export const FLOATING_WORKING_CONTROL_COVERAGE = CONTROL_OVERLAY_OFFSET + CONTROL_GAP;
/** Room the status pill takes under the header, so the feed's rows start below it. */
export const THREAD_STATUS_PILL_COVERAGE = PILL_HEIGHT + 16;
/** How far the pill pushes down other floats pinned under the header. */
export const THREAD_STATUS_PILL_OFFSET = PILL_HEIGHT + 8;

export interface ThreadStatusPillProps {
  readonly colorScheme: "light" | "dark";
  readonly top: number;
  /** Room the composer and keyboard take at the bottom; the open card stays above it. */
  readonly bottomInset: number;
  readonly maxWidth: number | undefined;
  readonly status: FloatingWorkingStatus | null;
  /** Pi's status beside a goal, shown in full once the card opens. */
  readonly extensionStatus: { readonly label: string; readonly detail: string } | null;
  readonly devicePreview: { readonly count: number; readonly onPress: () => void } | null;
  readonly browserPreview: { readonly count: number; readonly onPress: () => void } | null;
  readonly agents: SubagentPillSegment | null;
  /** The agents list, rendered only while the card is open. */
  readonly renderAgents: (close: () => void) => ReactNode;
}

export function hasThreadStatusPill(
  props: Pick<ThreadStatusPillProps, "status" | "agents" | "devicePreview" | "browserPreview">,
) {
  return (
    props.status !== null ||
    props.agents !== null ||
    props.devicePreview !== null ||
    props.browserPreview !== null
  );
}

/**
 * The thread's live status under the header. Tapping it opens a glass card in place with the
 * status in full, its actions, and this turn's agents.
 */
export function ThreadStatusPill(props: ThreadStatusPillProps) {
  const gt = useGT();
  const reducedMotion = useReducedMotion();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  const visible = hasThreadStatusPill(props);
  const { status, agents, extensionStatus } = props;
  const expandable =
    agents !== null || extensionStatus !== null || (status !== null && status.kind !== "preparing");
  if (expanded && (!visible || !expandable)) setExpanded(false);
  if (!visible) return null;

  const close = () => setExpanded(false);
  const toggle = () => {
    void Haptics.selectionAsync();
    setExpanded(!expanded);
  };
  const hasPreview = props.devicePreview !== null || props.browserPreview !== null;
  const cardWidth = Math.min(windowWidth - CARD_SIDE_MARGIN * 2, props.maxWidth ?? Infinity);
  const useGlass = NATIVE_LIQUID_GLASS_SUPPORTED;
  const layout = reducedMotion ? undefined : MORPH;

  const pillContent = (
    <Animated.View
      key="pill"
      entering={reducedMotion ? undefined : CONTENT_ENTERING}
      exiting={reducedMotion ? undefined : CONTENT_EXITING}
      className="h-11 flex-row items-center"
    >
      {status !== null || agents !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={pillAccessibilityLabel(status, agents, gt)}
          accessibilityHint={expandable ? gt("Shows the thread's status and agents") : undefined}
          accessibilityState={expandable ? { expanded: false } : undefined}
          disabled={!expandable}
          onPress={toggle}
          className="h-11 min-w-0 shrink flex-row items-center active:opacity-70"
        >
          {status !== null ? <StatusLabel status={status} /> : null}
          {agents !== null ? (
            <View className="h-11 flex-row items-center gap-1.5 px-3.5">
              {status !== null ? <View className="absolute left-0 h-4 w-px bg-border" /> : null}
              <SymbolView name="person.2" size={13} tintColorClassName="accent-foreground" />
              <Text className="font-t3-medium text-xs tabular-nums" numberOfLines={1}>
                {agents.label}
              </Text>
            </View>
          ) : null}
        </Pressable>
      ) : null}
      {hasPreview ? (
        <View className="h-11 flex-row items-center">
          {status !== null || agents !== null ? <View className="h-4 w-px bg-border" /> : null}
          {props.devicePreview !== null ? (
            <DevicePreviewButton
              {...props.devicePreview}
              compact={status !== null || agents !== null || props.browserPreview !== null}
            />
          ) : null}
          {props.browserPreview !== null ? (
            <BrowserPreviewButton
              {...props.browserPreview}
              compact={status !== null || agents !== null || props.devicePreview !== null}
            />
          ) : null}
        </View>
      ) : null}
    </Animated.View>
  );

  const cardContent = (
    <Animated.View
      key="card"
      entering={reducedMotion ? undefined : CONTENT_ENTERING}
      exiting={reducedMotion ? undefined : CONTENT_EXITING}
      style={{ width: cardWidth }}
    >
      <ScrollView
        style={{
          maxHeight: Math.max(
            CARD_MIN_HEIGHT,
            Math.min(
              windowHeight * CARD_MAX_HEIGHT_RATIO,
              windowHeight - props.top - props.bottomInset - CARD_BOTTOM_GAP,
            ),
          ),
        }}
        contentContainerClassName={status !== null ? "gap-2 px-4 pb-1 pt-3.5" : "px-4 py-1"}
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
      >
        {/* The status heads the card; with only agents the list starts at the top. */}
        {status !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: true }}
            accessibilityHint={gt("Close status")}
            onPress={toggle}
            className="active:opacity-70"
          >
            <StatusDetail status={status} />
          </Pressable>
        ) : null}
        <StatusActions status={status} onAct={close} />
        {extensionStatus !== null ? (
          <View className="gap-1">
            <Text className="font-t3-medium text-2xs uppercase tracking-wide text-foreground-muted">
              Pi
            </Text>
            <Text selectable className="text-sm text-foreground">
              {extensionStatus.detail}
            </Text>
          </View>
        ) : null}
        {agents !== null ? (
          <View className={status !== null ? "border-t border-border" : undefined}>
            {props.renderAgents(close)}
          </View>
        ) : null}
      </ScrollView>
    </Animated.View>
  );

  const content = expanded ? cardContent : pillContent;
  const shapeClassName = expanded
    ? "overflow-hidden rounded-[26px]"
    : "h-11 overflow-hidden rounded-full";

  return (
    // Open, it sits above the browser float that shares its corner.
    <View pointerEvents="box-none" className={`absolute inset-0 ${expanded ? "z-40" : "z-20"}`}>
      {expanded ? (
        // The card's own header closes it for assistive tech; this only catches taps outside.
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          onPress={close}
          className="absolute inset-0"
        />
      ) : null}
      <Animated.View
        pointerEvents="box-none"
        entering={reducedMotion ? undefined : PILL_ENTERING}
        exiting={reducedMotion ? undefined : PILL_EXITING}
        className="absolute left-0 right-0 items-center"
        style={{ top: props.top }}
      >
        {useGlass ? (
          <AnimatedGlassView
            colorScheme={props.colorScheme}
            glassEffectStyle="regular"
            isInteractive
            tintColorClassName="accent-glass-tint"
            layout={layout}
            accessibilityViewIsModal={expanded}
            onAccessibilityEscape={expanded ? close : undefined}
            className={shapeClassName}
            style={expanded ? CARD_SHADOW : undefined}
          >
            {content}
          </AnimatedGlassView>
        ) : (
          <Animated.View
            layout={layout}
            accessibilityViewIsModal={expanded}
            onAccessibilityEscape={expanded ? close : undefined}
            className={`${shapeClassName} border border-border bg-glass-fallback shadow-md shadow-black/10`}
          >
            {content}
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}

function pillAccessibilityLabel(
  status: FloatingWorkingStatus | null,
  agents: SubagentPillSegment | null,
  gt: ReturnType<typeof useGT>,
) {
  const statusLabel =
    status === null
      ? null
      : status.kind === "goal" || status.kind === "child-input"
        ? status.accessibilityLabel
        : status.label;
  const agentsLabel =
    agents === null ? null : gt("Agents, {agents}", { agents: agents.accessibilityLabel });
  return [statusLabel, agentsLabel].filter((label) => label !== null).join(", ");
}

function StatusIcon(props: { readonly status: FloatingWorkingStatus }) {
  const { status } = props;
  switch (status.kind) {
    case "connection":
      return <View className="h-2 w-2 rounded-full bg-red-500" />;
    case "child-input":
      return <SymbolView name="text.bubble" size={13} tintColorClassName="accent-foreground" />;
    case "goal":
      return (
        <SymbolView
          name="target"
          size={13}
          tintColorClassName="accent-foreground"
          type="monochrome"
        />
      );
    case "stop":
      return status.unresponsive ? (
        <SymbolView
          name="exclamationmark.triangle"
          size={13}
          tintColorClassName="accent-warning-foreground"
          type="monochrome"
        />
      ) : (
        <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
      );
    case "extension":
      return (
        <SymbolView
          name="info.circle"
          size={13}
          tintColorClassName="accent-foreground"
          type="monochrome"
        />
      );
    case "preparing":
      return (
        <SymbolView
          name="arrow.triangle.branch"
          size={13}
          tintColorClassName="accent-foreground"
          type="monochrome"
        />
      );
  }
}

/** The status as the collapsed pill shows it: one line, truncated. */
function StatusLabel(props: { readonly status: FloatingWorkingStatus }) {
  const { status } = props;
  return (
    <View className="h-11 min-w-0 shrink flex-row items-center gap-2 px-4">
      <StatusIcon status={status} />
      {status.kind === "preparing" ? (
        <ShimmeringWorkContent
          className="flex-none"
          textClassName="font-t3-medium"
          compact
          icon="arrow.triangle.branch"
          iconSubtleColor="transparent"
          label={status.label}
          showIcon={false}
        />
      ) : (
        <Text
          className="max-w-[240px] shrink font-t3-medium text-xs text-foreground"
          numberOfLines={1}
        >
          {status.label}
        </Text>
      )}
    </View>
  );
}

/** The status as the open card shows it: its full text. */
function StatusDetail(props: { readonly status: FloatingWorkingStatus }) {
  const { status } = props;
  const detail = status.kind === "goal" || status.kind === "extension" ? status.detail : null;
  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-2">
        <StatusIcon status={status} />
        <Text className="min-w-0 flex-1 font-t3-semibold text-base text-foreground">
          {status.label}
        </Text>
      </View>
      {detail ? (
        <Text selectable className="text-sm text-foreground-muted">
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

function StatusActions(props: {
  readonly status: FloatingWorkingStatus | null;
  readonly onAct: () => void;
}) {
  const gt = useGT();
  const { status } = props;
  if (status === null) return null;
  const buttons =
    status.kind === "goal"
      ? status.actions
      : status.kind === "stop" && status.action !== null
        ? [status.action]
        : status.kind === "connection"
          ? [
              {
                label: gt("Reconnect"),
                accessibilityLabel: gt("Reconnect"),
                disabled: false,
                onPress: status.onPress,
              },
            ]
          : status.kind === "child-input"
            ? [
                {
                  label: gt("Open", { $context: "verb, button that opens a thread" }),
                  accessibilityLabel: status.accessibilityLabel,
                  disabled: false,
                  onPress: () => {
                    props.onAct();
                    status.onPress();
                  },
                },
              ]
            : [];
  if (buttons.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-2">
      {buttons.map((button) => (
        <Button
          key={button.label}
          label={button.label}
          accessibilityLabel={button.accessibilityLabel}
          size="compact"
          disabled={button.disabled}
          onPress={button.onPress}
        />
      ))}
    </View>
  );
}

/** Jumps the feed back to its end; it rides above the composer and lifts with what opens over it. */
export function ScrollToEndControl(props: {
  readonly colorScheme: "light" | "dark";
  readonly visible: boolean;
  readonly onPress: () => void;
  readonly lift?: SharedValue<number>;
}) {
  const gt = useGT();
  const reducedMotion = useReducedMotion();
  const lift = props.lift;
  const liftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -(lift?.value ?? 0) }],
  }));
  if (!props.visible) return null;
  return (
    <Animated.View
      pointerEvents="box-none"
      className="absolute left-0 right-0 z-20 items-center"
      style={[{ top: -CONTROL_OVERLAY_OFFSET }, liftStyle]}
      entering={reducedMotion ? undefined : PILL_ENTERING}
      exiting={reducedMotion ? undefined : PILL_EXITING}
    >
      {NATIVE_LIQUID_GLASS_SUPPORTED ? (
        <UniwindGlassView
          colorScheme={props.colorScheme}
          glassEffectStyle="regular"
          isInteractive
          className="h-11 w-11 items-center justify-center overflow-hidden rounded-full"
        >
          <ControlPill
            accessibilityLabel={gt("Scroll to end")}
            activateOnPressIn
            className="h-11 w-11 bg-transparent"
            icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
            onPress={props.onPress}
          />
        </UniwindGlassView>
      ) : (
        <ControlPill
          accessibilityLabel={gt("Scroll to end")}
          activateOnPressIn
          className="h-11 w-11 border border-border bg-glass-fallback shadow-md shadow-black/10"
          icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
          onPress={props.onPress}
        />
      )}
    </Animated.View>
  );
}
