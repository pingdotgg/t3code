import { HeaderHeightContext } from "@react-navigation/elements";
import { useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { Platform, View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, {
  measure,
  interpolate,
  cancelAnimation,
  withSpring,
  ReduceMotion,
  runOnUI,
  useAnimatedStyle,
  useAnimatedRef,
  useAnimatedReaction,
  useDerivedValue,
  useSharedValue,
  type AnimatedRef,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const INPUT_HEIGHT = 72;
const HANDLE_HEIGHT = 28;

export interface ComposerResizeInset {
  readonly height: SharedValue<number>;
  readonly containerRef: AnimatedRef<View>;
  readonly layoutHeight: SharedValue<number>;
  readonly adjustment: number;
}

/** Reports chrome changes without routing the drag's height through React state. */
export function useComposerResizeContainer() {
  const ref = useAnimatedRef<View>();
  const layoutHeight = useSharedValue(0);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => layoutHeight.set(event.nativeEvent.layout.height),
    [layoutHeight],
  );
  return { ref, layoutHeight, onLayout };
}

/** Swipes the existing editor between compact and expanded heights. */
export function ResizableComposerInput(props: {
  readonly children: ReactNode;
  readonly active: boolean;
  readonly resizeActive: SharedValue<boolean>;
  readonly resizeInset?: ComposerResizeInset;
  readonly keyboardOpenedOffset?: number;
  readonly boundaryRef: AnimatedRef<View>;
  readonly container: ReturnType<typeof useComposerResizeContainer>;
}) {
  const enabled = Platform.OS === "ios" && props.active;
  const { height: keyboardHeight, progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const { height: windowHeight } = useWindowDimensions();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const insets = useSafeAreaInsets();
  const topInset = Math.max(headerHeight, insets.top) + 8;
  const progress = useSharedValue(0);
  const startHeight = useSharedValue(0);
  const insetBaseHeight = useSharedValue(0);
  const resizeInset = props.resizeInset;
  const resizeActive = props.resizeActive;
  const keyboardOpenedOffset = props.keyboardOpenedOffset ?? 0;
  const keyboardTranslation = useDerivedValue(
    () =>
      keyboardHeight.value + interpolate(keyboardProgress.value, [0, 1], [0, keyboardOpenedOffset]),
  );
  const maximumWithoutKeyboard = useSharedValue(0);
  const measuredWindowHeight = useSharedValue(windowHeight);
  const boundaryRef = props.boundaryRef;
  const containerRef = props.container.ref;
  const containerLayoutHeight = props.container.layoutHeight;
  const inputRef = useAnimatedRef<View>();
  const measuredLayout = useSharedValue({
    chromeHeight: -1,
    boundaryY: 0,
    boundaryHeight: 0,
    topInset: 0,
    windowHeight: 0,
  });

  const reset = useCallback(() => {
    "worklet";
    cancelAnimation(progress);
    progress.set(0);
    resizeActive.set(false);
  }, [progress, resizeActive]);
  useEffect(() => {
    if (!enabled) runOnUI(reset)();
    return () => runOnUI(reset)();
  }, [enabled, reset]);

  const maximum = useDerivedValue(() => {
    "worklet";
    return Math.max(
      0,
      maximumWithoutKeyboard.value +
        keyboardTranslation.value +
        windowHeight -
        measuredWindowHeight.value,
    );
  });
  const measureRoom = useCallback(
    (force = false) => {
      "worklet";
      const container = measure(containerRef);
      const boundary = measure(boundaryRef);
      const input = measure(inputRef);
      if (!container || !boundary || !input) return;
      const current = Math.max(0, input.height - INPUT_HEIGHT - HANDLE_HEIGHT);
      if (resizeInset) {
        const overlay = measure(resizeInset.containerRef);
        if (overlay) insetBaseHeight.set(overlay.height + resizeInset.adjustment - current);
      }
      const chromeHeight = container.height - input.height;
      const previous = measuredLayout.value;
      // Drag and keyboard frames change the input height too. Only refresh the
      // room budget when chrome or screen bounds change, avoiding feedback from
      // layout reports that arrive after the gesture has already advanced.
      if (
        !force &&
        Math.abs(chromeHeight - previous.chromeHeight) < 0.5 &&
        boundary.pageY === previous.boundaryY &&
        boundary.height === previous.boundaryHeight &&
        topInset === previous.topInset &&
        windowHeight === previous.windowHeight
      )
        return;
      measuredLayout.set({
        chromeHeight,
        boundaryY: boundary.pageY,
        boundaryHeight: boundary.height,
        topInset,
        windowHeight,
      });
      // pageY includes the keyboard-sticky translation and native sheet position.
      // Remove the full sticky translation so later keyboard transitions can
      // clamp the editor on the UI thread, alongside its dock's movement.
      maximumWithoutKeyboard.set(
        Math.max(
          0,
          current +
            container.pageY -
            Math.max(boundary.pageY + 8, topInset) -
            keyboardTranslation.value,
        ),
      );
      measuredWindowHeight.set(windowHeight);
    },
    [
      containerRef,
      boundaryRef,
      inputRef,
      measuredLayout,
      resizeInset,
      insetBaseHeight,
      maximumWithoutKeyboard,
      topInset,
      keyboardTranslation,
      measuredWindowHeight,
      windowHeight,
    ],
  );
  useAnimatedReaction(
    () => ({
      height: containerLayoutHeight.value,
      overlayHeight: resizeInset?.layoutHeight.value,
      enabled,
      windowHeight,
      topInset,
    }),
    () => {
      if (enabled) measureRoom();
    },
  );
  // Use the same frame's height for the input and transcript. Feeding each
  // intermediate layout through onLayout + withTiming makes the chat trail.
  useAnimatedReaction(
    () => ({
      height: insetBaseHeight.value + Math.max(0, Math.min(1, progress.value)) * maximum.value,
      active: enabled && resizeActive.value,
    }),
    ({ height, active }) => {
      if (active && resizeInset) {
        resizeInset.height.set(Math.max(0, height));
      }
    },
  );
  const settle = useCallback(
    (target: number, velocity: number) => {
      "worklet";
      resizeActive.set(true);
      progress.set(
        withSpring(
          target,
          {
            stiffness: 300,
            damping: 35,
            velocity,
            overshootClamping: true,
            reduceMotion: ReduceMotion.System,
          },
          (finished) => {
            // Expanded height continues following keyboard movement after the
            // spring ends, so it still owns layout and the transcript inset.
            if (finished && target === 0) resizeActive.set(false);
          },
        ),
      );
    },
    [progress, resizeActive],
  );
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .activeOffsetY([-8, 8])
        .failOffsetX([-24, 24])
        .onStart(() => {
          cancelAnimation(progress);
          progress.set(Math.max(0, Math.min(1, progress.value)));
          resizeActive.set(true);
          measureRoom(true);
          startHeight.set(progress.value * maximum.value);
        })
        .onUpdate((event) => {
          progress.set(
            maximum.value > 0
              ? Math.max(0, Math.min(1, (startHeight.value - event.translationY) / maximum.value))
              : 0,
          );
        })
        .onEnd((event) => {
          const velocity = maximum.value > 0 ? -event.velocityY / maximum.value : 0;
          // Project a short coast from the release point, then settle at a detent.
          const target = progress.value + velocity * 0.2 > 0.5 ? 1 : 0;
          settle(target, velocity);
        })
        .onFinalize((_event, success) => {
          if (!success && resizeActive.value) settle(progress.value > 0.5 ? 1 : 0, 0);
        }),
    [enabled, measureRoom, progress, maximum, startHeight, resizeActive, settle],
  );
  const setExpanded = (value: boolean) => {
    "worklet";
    measureRoom(true);
    settle(value ? 1 : 0, 0);
  };
  const style = useAnimatedStyle(() => ({
    height: enabled
      ? INPUT_HEIGHT + HANDLE_HEIGHT + Math.max(0, Math.min(1, progress.value)) * maximum.value
      : undefined,
  }));

  return (
    <Animated.View ref={inputRef} collapsable={false} style={style}>
      <GestureDetector gesture={gesture}>
        <Animated.View
          collapsable={false}
          accessible={enabled}
          accessibilityRole="adjustable"
          accessibilityLabel="Message box height"
          accessibilityHint="Swipe up to expand or down to collapse"
          accessibilityActions={[
            { name: "increment", label: "Expand" },
            { name: "decrement", label: "Collapse" },
          ]}
          onAccessibilityAction={({ nativeEvent }) => {
            if (enabled && nativeEvent.actionName === "increment") runOnUI(setExpanded)(true);
            else if (enabled && nativeEvent.actionName === "decrement") runOnUI(setExpanded)(false);
          }}
          style={{ height: enabled ? HANDLE_HEIGHT : 0, overflow: "hidden" }}
          className="items-center justify-center"
        >
          <View className="h-1 w-9 rounded-full bg-foreground-muted/40" />
        </Animated.View>
      </GestureDetector>
      {props.children}
    </Animated.View>
  );
}
