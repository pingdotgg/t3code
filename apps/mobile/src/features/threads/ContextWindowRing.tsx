import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
} from "@t3tools/client-runtime/state/context-window";
import type { ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";
import { Pressable } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useThemeColor } from "../../lib/useThemeColor";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import {
  formatContextWindowDetail,
  formatContextWindowPercentage,
} from "./ContextWindowRing.logic";

/**
 * Latest context-window snapshot for `threadId`, or null when the thread has
 * reported none. Subscribing to thread detail re-renders on every activity, so
 * this stays in the leaves the ring owns rather than in the memoized composer.
 * Guards on the thread id so a composer never shows the previously selected
 * thread's usage while the new detail loads.
 */
function useContextWindowSnapshot(threadId: ThreadId | null) {
  const detail = useSelectedThreadDetail();
  const activities = detail?.id === threadId ? detail.activities : null;
  return useMemo(
    () => (activities ? deriveLatestContextWindowSnapshot(activities) : null),
    [activities],
  );
}

/** Mobile's stand-in for web's hover tooltip; renders nothing until the ring is tapped. */
export function ContextWindowDetail(props: {
  readonly threadId: ThreadId;
  readonly visible: boolean;
}) {
  const snapshot = useContextWindowSnapshot(props.threadId);
  if (!snapshot || !props.visible) {
    return null;
  }
  return (
    <Text className="pt-2 text-xs text-foreground-muted">
      {formatContextWindowDetail(snapshot)}
    </Text>
  );
}

const RADIUS = 9.75;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Mirrors web's ContextWindowMeter dial: a muted track with a foreground arc
 * for the used share, drawn statically (no transition) so it never repaints
 * between snapshots. Tapping reveals the numbers, which mobile has no hover for.
 */
export function ContextWindowRing(props: {
  readonly threadId: ThreadId;
  readonly onPress: () => void;
}) {
  const snapshot = useContextWindowSnapshot(props.threadId);
  const mutedColor = String(useThemeColor("--color-foreground-muted"));
  const dangerColor = String(useThemeColor("--color-danger-foreground"));
  if (!snapshot) {
    return null;
  }
  const usedPercentage = Math.max(0, Math.min(100, snapshot.usedPercentage ?? 0));
  const percentageLabel = formatContextWindowPercentage(snapshot.usedPercentage);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        snapshot.maxTokens !== null && percentageLabel
          ? `Context window ${percentageLabel} used`
          : `Context window ${formatContextWindowTokens(snapshot.usedTokens)} tokens used`
      }
      className="h-11 w-8 items-center justify-center"
      hitSlop={6}
      onPress={props.onPress}
    >
      <Svg width={20} height={20} viewBox="0 0 24 24" style={{ transform: [{ rotate: "-90deg" }] }}>
        <Circle
          cx={12}
          cy={12}
          r={RADIUS}
          fill="none"
          stroke={themeColorWithAlpha(mutedColor, 0.24)}
          strokeWidth={3}
        />
        <Circle
          cx={12}
          cy={12}
          r={RADIUS}
          fill="none"
          stroke={usedPercentage > 90 ? dangerColor : themeColorWithAlpha(mutedColor, 0.72)}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - usedPercentage / 100)}
        />
      </Svg>
    </Pressable>
  );
}
