import { MaskedView } from "@expo/ui/community/masked-view";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useId, useState, type ComponentProps, type ReactNode } from "react";
import { Animated as NativeAnimated, StyleSheet, useAnimatedValue, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import type { AppText } from "../../components/ui/AppText";
import { usePaneRole } from "../../components/ui/Pane";
import { useAppActive, useReduceMotionEnabled } from "../../lib/appState";
import { cn } from "../../lib/cn";
import { startShimmerSteps } from "./work-shimmer-steps";

const SHINE_WIDTH = 72;

type TextLayoutHandler = NonNullable<ComponentProps<typeof AppText>["onTextLayout"]>;

/** One copy of the shining content: the muted base, or the bright band drawn over it. */
export type WorkShineLayer =
  | { readonly highlighted: false; readonly onTextLayout: TextLayoutHandler }
  | { readonly highlighted: true; readonly onTextLayout?: undefined };

/**
 * The live tool shine: a bright band sweeps across muted content, then pauses. `children`
 * renders the content twice, once as the base (which must pass `onTextLayout` to its text, so
 * the sweep spans only the text) and once highlighted inside the band. The band is off with
 * reduce motion, while the app is in the background, and while the screen is hidden.
 */
export function WorkShine(props: {
  readonly className?: string;
  /** Width of content before the text, such as an icon and its gap. */
  readonly leadingWidth?: number;
  /** Keep shining in the sidebar, whose route stays unfocused under the page beside it. */
  readonly shineInSidebar?: boolean;
  readonly children: (layer: WorkShineLayer) => ReactNode;
}) {
  const [availableWidth, setAvailableWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const appIsActive = useAppActive();
  const reducedMotion = useReduceMotionEnabled();
  const screenIsFocused = useIsFocused();
  const inSidebar = usePaneRole() === "sidebar";
  const visible =
    !reducedMotion &&
    appIsActive &&
    (screenIsFocused || (props.shineInSidebar === true && inSidebar));
  // Native from creation, so each setValue updates the view without a React render.
  const progress = useAnimatedValue(0, { useNativeDriver: true });
  const gradientId = `work-shine-${useId().replaceAll(":", "")}`;
  const contentWidth = Math.min(availableWidth, (props.leadingWidth ?? 0) + Math.ceil(textWidth));

  // Uses a native Animated value instead of Reanimated, whose per-frame commits
  // starve React's while commit pausing is disabled (package.json). See
  // docs/internals/performance-regressions.md.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- steps the native shine value on timers while visible and active, and stops them on cleanup
  useEffect(() => {
    progress.setValue(0);
    if (contentWidth <= 0 || !visible) return;
    return startShimmerSteps(progress);
  }, [contentWidth, progress, visible]);

  // The React Compiler memoizes these, so re-renders don't rebuild the native
  // animation nodes.
  const sweepTranslateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-SHINE_WIDTH, contentWidth],
  });
  const counterSweepTranslateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [SHINE_WIDTH, -contentWidth],
  });

  return (
    <View
      className={cn("min-w-0 overflow-hidden", props.className)}
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
    >
      {props.children({
        highlighted: false,
        onTextLayout: (event) =>
          setTextWidth(Math.max(0, ...event.nativeEvent.lines.map((line) => line.width))),
      })}
      {visible && contentWidth > 0 ? (
        <NativeAnimated.View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            overflow: "hidden",
            width: SHINE_WIDTH,
            transform: [{ translateX: sweepTranslateX }],
          }}
        >
          <MaskedView
            style={StyleSheet.absoluteFill}
            maskElement={
              <Svg width="100%" height="100%">
                <Defs>
                  <LinearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="0%">
                    <Stop offset="0" stopColor="white" stopOpacity={0} />
                    <Stop offset="0.15" stopColor="white" stopOpacity={0.12} />
                    <Stop offset="0.35" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="0.5" stopColor="white" stopOpacity={1} />
                    <Stop offset="0.65" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="0.85" stopColor="white" stopOpacity={0.12} />
                    <Stop offset="1" stopColor="white" stopOpacity={0} />
                  </LinearGradient>
                </Defs>
                <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
              </Svg>
            }
          >
            <NativeAnimated.View
              style={{ width: availableWidth, transform: [{ translateX: counterSweepTranslateX }] }}
            >
              {props.children({ highlighted: true })}
            </NativeAnimated.View>
          </MaskedView>
        </NativeAnimated.View>
      ) : null}
    </View>
  );
}
