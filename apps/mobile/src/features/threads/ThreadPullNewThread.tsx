import * as Haptics from "expo-haptics";
import { T } from "gt-react-native";
import { useEffect } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedRef,
  useAnimatedStyle,
  useEvent,
  useSharedValue,
  withTiming,
  type ScrollEvent,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { SymbolView } from "../../components/ui/AppSymbol";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import type { ScrollPullEvent } from "../../native/T3ScrollPull";
import {
  PULL_NEW_THREAD_THRESHOLD as THRESHOLD,
  overscrollPastEnd,
  pullFromStretch,
  shouldStartNewThread,
  trackPull,
} from "./thread-pull-new-thread";

const SETTLE = { duration: 180 };
const SCRIM_SOLID = 84;
const SCRIM_FADE = 48;
const DRAG_EVENTS =
  Platform.OS === "ios"
    ? ["onScroll", "onScrollBeginDrag", "onScrollEndDrag"]
    : ["onScrollBeginDrag"];

const armedHaptic = () => {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};

interface RegisteredEventHandler {
  readonly workletEventHandler: {
    registerForEvents(viewTag: number): void;
    unregisterFromEvents(viewTag: number): void;
  };
}

export function useThreadPullNewThread(enabled: boolean) {
  const { startNewTaskInCurrentProject } = useAdaptiveWorkspaceLayout();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const distance = useSharedValue(0);
  const armedAt = useSharedValue<number | null>(null);
  const drag = useSharedValue<"idle" | "pulling" | "keyboard">("idle");
  const { progress: keyboard } = useReanimatedKeyboardAnimation();

  const begin = () => {
    "worklet";
    armedAt.set(null);
    drag.set(keyboard.get() < 0.01 ? "pulling" : "keyboard");
  };
  const update = (next: number) => {
    "worklet";
    if (drag.get() !== "pulling" || next === distance.get()) return;
    distance.set(next);
    const nextArmedAt = trackPull(armedAt.get(), next, THRESHOLD, Date.now());
    if (nextArmedAt === armedAt.get()) return;
    armedAt.set(nextArmedAt);
    if (nextArmedAt !== null) runOnJS(armedHaptic)();
  };
  const release = (released: boolean, velocity: number) => {
    "worklet";
    const start = shouldStartNewThread(armedAt.get(), Date.now(), released, velocity);
    drag.set("idle");
    armedAt.set(null);
    distance.set(withTiming(0, SETTLE));
    if (start) runOnJS(startNewTaskInCurrentProject)();
  };

  const scrollEvents = useEvent<ScrollEvent>((event) => {
    "worklet";
    if (event.eventName.endsWith("onScrollBeginDrag")) begin();
    else {
      update(overscrollPastEnd(event));
      if (event.eventName.endsWith("onScrollEndDrag")) release(true, event.velocity?.y ?? 0);
    }
  }, DRAG_EVENTS) as unknown as RegisteredEventHandler;
  const stretchEvents = useEvent<ScrollPullEvent>(
    (event) => {
      "worklet";
      if ("released" in event) {
        release(event.released, event.velocity);
        return;
      }
      if (drag.get() === "idle") begin();
      update(pullFromStretch(event.distance));
    },
    ["onPull", "onPullEnd"],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- LegendList owns the scroll view's event props, so the pull listens on its view tag the way Reanimated's useScrollOffset does
  useEffect(
    () =>
      scrollRef.observe((tag) => {
        if (!tag || !enabled) return;
        scrollEvents.workletEventHandler.registerForEvents(tag);
        return () => scrollEvents.workletEventHandler.unregisterFromEvents(tag);
      }),
    [scrollRef, scrollEvents, enabled],
  );

  return {
    scrollRef,
    stretchEvents: enabled ? stretchEvents : undefined,
    pull: enabled ? { distance, armedAt } : null,
  };
}

type ThreadPull = NonNullable<ReturnType<typeof useThreadPullNewThread>["pull"]>;

export function ThreadPullIndicator(props: {
  readonly pull: ThreadPull;
  readonly bottom: number;
  readonly screenColor: string;
}) {
  const { distance, armedAt } = props.pull;
  const badgeStyle = useAnimatedStyle(() => {
    const value = distance.get();
    return {
      opacity: interpolate(value, [THRESHOLD * 0.2, THRESHOLD * 0.7], [0, 1], "clamp"),
      transform: [
        { translateY: interpolate(value, [0, THRESHOLD], [24, 0], "clamp") },
        { scale: interpolate(value, [0, THRESHOLD], [0.6, 1], "clamp") },
      ],
    };
  });
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(distance.get(), [THRESHOLD * 0.2, THRESHOLD * 0.7], [0, 1], "clamp"),
  }));
  const armedStyle = useAnimatedStyle(() => ({
    opacity: withTiming(armedAt.get() === null ? 0 : 1, { duration: 120 }),
  }));
  const restingStyle = useAnimatedStyle(() => ({
    opacity: withTiming(armedAt.get() === null ? 1 : 0, { duration: 120 }),
  }));
  return (
    <>
      {Platform.OS === "android" ? (
        <Animated.View
          pointerEvents="none"
          className="absolute inset-x-0 bottom-0"
          style={[{ height: props.bottom + SCRIM_SOLID + SCRIM_FADE }, scrimStyle]}
        >
          <Svg width="100%" height="100%">
            <Defs>
              <LinearGradient id="thread-pull-scrim" x1="0%" x2="0%" y1="0%" y2="100%">
                <Stop offset="0%" stopColor={props.screenColor} stopOpacity={0} />
                <Stop
                  offset={SCRIM_FADE / (props.bottom + SCRIM_SOLID + SCRIM_FADE)}
                  stopColor={props.screenColor}
                  stopOpacity={1}
                />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#thread-pull-scrim)" />
          </Svg>
        </Animated.View>
      ) : null}
      <Animated.View
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        className="absolute inset-x-0 items-center gap-1.5"
        style={[{ bottom: props.bottom }, badgeStyle]}
      >
        <View className="size-11 items-center justify-center rounded-full border border-border bg-card">
          <SymbolView
            name="square.and.pencil"
            size={18}
            tintColorClassName="accent-foreground"
            type="monochrome"
          />
          <Animated.View
            className="items-center justify-center rounded-full bg-primary"
            style={[StyleSheet.absoluteFill, armedStyle]}
          >
            <SymbolView
              name="square.and.pencil"
              size={18}
              tintColorClassName="accent-primary-foreground"
              type="monochrome"
            />
          </Animated.View>
        </View>
        <View className="rounded-full border border-border bg-card px-2.5 py-1">
          <Animated.View style={armedStyle}>
            <Text className="text-xs font-t3-medium text-foreground">
              <T>Release for new thread</T>
            </Text>
          </Animated.View>
          <Animated.View className="justify-center" style={[StyleSheet.absoluteFill, restingStyle]}>
            <Text className="text-center text-xs text-foreground-muted">
              <T>Pull for new thread</T>
            </Text>
          </Animated.View>
        </View>
      </Animated.View>
    </>
  );
}
