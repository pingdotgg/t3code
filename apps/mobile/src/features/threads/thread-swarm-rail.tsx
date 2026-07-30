import { formatElapsed } from "@t3tools/shared/orchestrationTiming";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, useColorScheme, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { ComposerSurface } from "./ThreadComposer";

/**
 * Height of the rail pill. Deliberately slimmer and squarer-per-height than
 * the 52px composer pill (radius 19 against 999) so it never reads as a
 * second input sitting above the real one.
 */
const SWARM_RAIL_HEIGHT = 38;

/**
 * Height the rail block adds above the composer (pill + its bottom padding).
 * Exported so the parent can fold it into the feed's estimated bottom inset
 * before the overlay re-measures.
 */
export const SWARM_RAIL_CHROME = SWARM_RAIL_HEIGHT + 8;

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

/**
 * 1s clock for live elapsed labels, parked while `enabled` is false so an
 * idle rail or a sheet with nothing running holds no timer.
 */
export function useLiveElapsedClock(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setNowMs(Date.now());
    const intervalId = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => clearInterval(intervalId);
  }, [enabled]);

  return nowMs;
}

export function elapsedLabel(startedAt: string, nowMs: number): string {
  return formatElapsed(startedAt, new Date(nowMs).toISOString()) ?? "0s";
}

export function backgroundAgentsLabel(runningCount: number): string {
  return runningCount === 1 ? "1 subagent working" : `${runningCount} subagents working`;
}

/**
 * Full-width rail docked directly above the composer while provider
 * background tasks (subagents) are still running — the thread's own turn can
 * settle long before its children do, and without this the screen reads as
 * idle (#4962). Tapping opens the Background agents sheet.
 */
export function ThreadSwarmRail(props: {
  readonly runningCount: number;
  readonly startedAt: string | null;
  readonly onPress: () => void;
}) {
  const isDarkMode = useColorScheme() === "dark";
  const accentColor = useThemeColor("--color-user-bubble");
  const iconColor = useThemeColor("--color-icon");
  const nowMs = useLiveElapsedClock(props.startedAt !== null);
  const label = backgroundAgentsLabel(props.runningCount);
  const durationLabel = props.startedAt === null ? null : elapsedLabel(props.startedAt, nowMs);

  const handlePress = useCallback(() => {
    void Haptics.selectionAsync();
    props.onPress();
  }, [props.onPress]);

  return (
    <Animated.View
      className="px-4 pb-2"
      entering={FadeInDown.duration(220)}
      exiting={FadeOut.duration(140)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          durationLabel === null ? label : `${label}, ${durationLabel}. Open background agents.`
        }
        onPress={handlePress}
      >
        <ComposerSurface
          isDarkMode={isDarkMode}
          style={{
            height: SWARM_RAIL_HEIGHT,
            borderRadius: SWARM_RAIL_HEIGHT / 2,
            overflow: "hidden",
            flexDirection: "row",
            alignItems: "center",
            gap: 9,
            paddingLeft: 14,
            paddingRight: 6,
          }}
        >
          <ActivityIndicator size="small" color={accentColor} />
          <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>
            {label}
          </Text>
          {durationLabel !== null ? (
            <Text
              className="text-foreground-muted text-xs tabular-nums"
              style={{ fontFamily: MONO_FONT }}
            >
              {durationLabel}
            </Text>
          ) : null}
          <View className="bg-subtle h-[26px] w-[26px] items-center justify-center rounded-full">
            <SymbolView
              name="chevron.up"
              size={13}
              tintColor={iconColor}
              type="monochrome"
              weight="semibold"
            />
          </View>
        </ComposerSurface>
      </Pressable>
    </Animated.View>
  );
}
