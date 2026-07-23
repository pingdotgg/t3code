import { SymbolView } from "../../components/AppSymbol";
import * as Haptics from "expo-haptics";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type {
  ColorValue,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  ViewStyle,
} from "react-native";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";

// Wide enough for the longest action label ("Unarchive").
const ACTION_ITEM_WIDTH = 58;
const ACTION_CIRCLE_SIZE = 36;
const ACTION_ICON_SIZE = 15;
const COMPACT_ACTION_CIRCLE_SIZE = 28;
const COMPACT_ACTION_ICON_SIZE = 13;

export const THREAD_SWIPE_ACTIONS_WIDTH = ACTION_ITEM_WIDTH * 2;
export const THREAD_SWIPE_SPRING = {
  damping: 26,
  mass: 0.7,
  overshootClamping: true,
  stiffness: 330,
};

interface ThreadSwipePrimaryAction {
  readonly accessibilityLabel: string;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly onPress: () => void;
}

/**
 * Delivers the scroll gate to swipeables via context so that flipping it does
 * NOT re-render whole rows: putting the flag in list extraData/renderItem deps
 * re-rendered every visible row (hooks, subscriptions and all) exactly at
 * scroll start — peak frame pressure. As a context value only the
 * ThreadSwipeable consumers re-render.
 */
const SwipeableScrollGateContext = createContext(true);

export function SwipeableScrollGateProvider(props: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  return (
    <SwipeableScrollGateContext.Provider value={props.enabled}>
      {props.children}
    </SwipeableScrollGateContext.Provider>
  );
}

/**
 * Gates row swipes on list scroll activity, mirroring UIKit's own swipe
 * actions (`!isDragging && !isDecelerating`). failOffsetY on the swipe pan
 * covers the first pan of a scroll, but trackpad scroll sessions spawn fresh
 * gesture sessions (momentum catch, direction changes) whose reset
 * translation can re-activate a swipe mid-scroll — so while the list has
 * moved vertically during an active drag/momentum phase, row swipes are
 * disabled entirely.
 *
 * Spread the returned handlers onto the list and pass `swipeEnabled` to rows.
 */
export function useSwipeableScrollGate(options?: {
  readonly onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  readonly onScrollBeginDrag?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) {
  const [gateActive, setGateActive] = useState(false);
  const gateActiveRef = useRef(false);
  const draggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const externalOnScroll = options?.onScroll;
  const externalOnScrollBeginDrag = options?.onScrollBeginDrag;

  const update = useCallback((next: boolean) => {
    if (gateActiveRef.current !== next) {
      gateActiveRef.current = next;
      setGateActive(next);
    }
  }, []);
  const clearSettle = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearSettle, [clearSettle]);

  const onScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = true;
      dragStartYRef.current = event.nativeEvent.contentOffset.y;
      clearSettle();
      externalOnScrollBeginDrag?.(event);
    },
    [clearSettle, externalOnScrollBeginDrag],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Only vertical movement during a user drag arms the gate — a purely
      // horizontal row swipe never moves contentOffset.y, and inset-driven
      // offset changes at mount happen outside a drag.
      if (
        draggingRef.current &&
        !gateActiveRef.current &&
        Math.abs(event.nativeEvent.contentOffset.y - dragStartYRef.current) > 4
      ) {
        update(true);
      }
      externalOnScroll?.(event);
    },
    [externalOnScroll, update],
  );
  const onScrollEndDrag = useCallback(() => {
    draggingRef.current = false;
    clearSettle();
    // If momentum follows, onMomentumScrollBegin cancels this and the gate
    // stays armed until the deceleration finishes.
    settleTimerRef.current = setTimeout(() => update(false), 160);
  }, [clearSettle, update]);
  const onMomentumScrollBegin = useCallback(() => {
    clearSettle();
  }, [clearSettle]);
  const onMomentumScrollEnd = useCallback(() => {
    update(false);
  }, [update]);

  return {
    swipeEnabled: !gateActive,
    scrollGateHandlers: {
      onScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
    },
  };
}

export function ThreadSwipeable(props: {
  readonly backgroundColor: ColorValue;
  readonly children: (close: () => void) => ReactNode;
  /** Uses action visuals that fit inside compact 44pt rows. The press target
   * still spans the row's full height and width. */
  readonly compactActions?: boolean;
  readonly containerStyle?: StyleProp<ViewStyle>;
  /** Disables NEW swipe activations (e.g. while the list scrolls). */
  readonly enabled?: boolean;
  readonly enableTrackpadSwipe?: boolean;
  /**
   * What a full swipe commits: "delete" (default, v1 behavior — the Delete
   * button stretches) or "primary" — the advertised primary action fires and
   * its button stretches instead. A full swipe must always match the action
   * the stretching button advertises.
   */
  readonly fullSwipeAction?: "delete" | "primary";
  readonly fullSwipeWidth: number;
  readonly onDelete: () => void;
  readonly onSwipeableClose?: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen?: (methods: SwipeableMethods) => void;
  readonly primaryAction: ThreadSwipePrimaryAction;
  /**
   * Identity of the content being wrapped. When a recycled list reuses this
   * component for a different item, the swipeable snaps back to closed so an
   * open/mid-drag state can't leak onto another row.
   */
  readonly resetKey?: string;
  readonly simultaneousWithExternalGesture?: ComponentProps<
    typeof ReanimatedSwipeable
  >["simultaneousWithExternalGesture"];
  readonly threadTitle: string;
}) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const fullSwipeArmedRef = useRef(false);
  const fullSwipeThreshold = Math.max(THREAD_SWIPE_ACTIONS_WIDTH + 44, props.fullSwipeWidth * 0.58);
  const close = useCallback(() => swipeableRef.current?.close(), []);
  const gateEnabled = use(SwipeableScrollGateContext);
  const resetKey = props.resetKey;
  useEffect(() => {
    if (resetKey === undefined) {
      return;
    }
    fullSwipeArmedRef.current = false;
    swipeableRef.current?.reset();
  }, [resetKey]);
  const handleFullSwipeArmedChange = useCallback((armed: boolean) => {
    if (armed && !fullSwipeArmedRef.current) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    fullSwipeArmedRef.current = armed;
  }, []);

  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      animationOptions={THREAD_SWIPE_SPRING}
      childrenContainerStyle={{ backgroundColor: props.backgroundColor }}
      containerStyle={[{ backgroundColor: props.backgroundColor }, props.containerStyle]}
      dragOffsetFromRightEdge={8}
      enabled={props.enabled !== false && gateEnabled}
      enableTrackpadTwoFingerGesture={props.enableTrackpadSwipe ?? true}
      // Fail the swipe once the pan is vertically dominant (patched-in RNGH
      // prop) — otherwise trackpad scrolls with ~8px of horizontal drift
      // start opening rows because the swipe pan runs simultaneously with
      // the list scroll gesture and never gets disqualified by Y movement.
      failOffsetY={[-10, 10]}
      friction={1}
      onSwipeableClose={() => {
        fullSwipeArmedRef.current = false;
        if (swipeableRef.current) {
          props.onSwipeableClose?.(swipeableRef.current);
        }
      }}
      onSwipeableOpenStartDrag={() => {
        if (swipeableRef.current) {
          props.onSwipeableWillOpen?.(swipeableRef.current);
        }
      }}
      onSwipeableWillOpen={() => {
        const methods = swipeableRef.current;
        if (!methods) {
          return;
        }

        props.onSwipeableWillOpen?.(methods);
        if (fullSwipeArmedRef.current) {
          fullSwipeArmedRef.current = false;
          methods.close();
          if (props.fullSwipeAction === "primary") {
            props.primaryAction.onPress();
          } else {
            props.onDelete();
          }
        }
      }}
      overshootFriction={1}
      overshootRight
      renderRightActions={(_progress, translation, methods) => (
        <ThreadSwipeActions
          backgroundColor={props.backgroundColor}
          compact={props.compactActions === true}
          fullSwipeAction={props.fullSwipeAction ?? "delete"}
          fullSwipeThreshold={fullSwipeThreshold}
          onDelete={props.onDelete}
          onFullSwipeArmedChange={handleFullSwipeArmedChange}
          primaryAction={{
            ...props.primaryAction,
            onPress: () => {
              methods.close();
              props.primaryAction.onPress();
            },
          }}
          swipeableMethods={methods}
          threadTitle={props.threadTitle}
          translation={translation}
        />
      )}
      rightThreshold={THREAD_SWIPE_ACTIONS_WIDTH * 0.42}
      simultaneousWithExternalGesture={props.simultaneousWithExternalGesture}
    >
      {props.children(close)}
    </ReanimatedSwipeable>
  );
}

function SwipeActionButton(props: {
  readonly accessibilityLabel: string;
  readonly backgroundColor: string;
  readonly compact: boolean;
  readonly entryRange: readonly [number, number];
  readonly fullSwipeThreshold: number;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly onPress: () => void;
  readonly stretchesOnFullSwipe: boolean;
  readonly translation: SharedValue<number>;
}) {
  const circleSize = props.compact ? COMPACT_ACTION_CIRCLE_SIZE : ACTION_CIRCLE_SIZE;
  const iconSize = props.compact ? COMPACT_ACTION_ICON_SIZE : ACTION_ICON_SIZE;
  const actionStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-props.translation.value, 0);
    const entryProgress = interpolate(reveal, props.entryRange, [0, 1], Extrapolation.CLAMP);
    const stretch = Math.max(reveal - THREAD_SWIPE_ACTIONS_WIDTH, 0);
    const fullSwipeProgress = interpolate(
      reveal,
      [THREAD_SWIPE_ACTIONS_WIDTH, props.fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      opacity: props.stretchesOnFullSwipe ? entryProgress : entryProgress * (1 - fullSwipeProgress),
      transform: [
        {
          translateX:
            interpolate(entryProgress, [0, 1], [22, 0]) -
            (props.stretchesOnFullSwipe ? 0 : stretch),
        },
        { scale: interpolate(entryProgress, [0, 1], [0.78, 1]) },
      ],
    };
  });
  const circleStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-props.translation.value, 0);
    const stretch = props.stretchesOnFullSwipe
      ? Math.max(reveal - THREAD_SWIPE_ACTIONS_WIDTH, 0)
      : 0;

    return {
      transform: [{ translateX: -stretch }],
      width: circleSize + stretch,
    };
  });
  const iconStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-props.translation.value, 0);
    const stretch = props.stretchesOnFullSwipe
      ? Math.max(reveal - THREAD_SWIPE_ACTIONS_WIDTH, 0)
      : 0;
    const armedProgress = interpolate(
      reveal,
      [props.fullSwipeThreshold, props.fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      transform: [{ translateX: -stretch * (0.5 + armedProgress * 0.5) }],
    };
  });
  const labelStyle = useAnimatedStyle(() => {
    if (!props.stretchesOnFullSwipe) {
      return { opacity: 1 };
    }

    const reveal = Math.max(-props.translation.value, 0);
    const stretch = Math.max(reveal - THREAD_SWIPE_ACTIONS_WIDTH, 0);
    return {
      opacity: interpolate(
        reveal,
        [props.fullSwipeThreshold - 24, props.fullSwipeThreshold],
        [1, 0],
        Extrapolation.CLAMP,
      ),
      transform: [{ translateX: -stretch * 0.5 }],
    };
  });

  return (
    <Animated.View
      style={[
        {
          alignItems: "center",
          height: "100%",
          justifyContent: "center",
          width: ACTION_ITEM_WIDTH,
          zIndex: props.stretchesOnFullSwipe ? 2 : 1,
        },
        actionStyle,
      ]}
    >
      <Pressable
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="button"
        onPress={props.onPress}
        style={({ pressed }) => ({
          alignItems: "center",
          height: "100%",
          justifyContent: "center",
          opacity: pressed ? 0.72 : 1,
          width: "100%",
        })}
      >
        <View style={{ height: circleSize, width: circleSize }}>
          <Animated.View
            style={[
              {
                backgroundColor: props.backgroundColor,
                borderRadius: 999,
                height: circleSize,
                left: 0,
                position: "absolute",
                top: 0,
              },
              circleStyle,
            ]}
          />
          <Animated.View
            style={[
              {
                alignItems: "center",
                height: circleSize,
                justifyContent: "center",
                left: 0,
                position: "absolute",
                top: 0,
                width: circleSize,
              },
              iconStyle,
            ]}
          >
            <SymbolView name={props.icon} size={iconSize} tintColor="#ffffff" type="monochrome" />
          </Animated.View>
        </View>
        <Animated.View
          style={[
            { height: 14, justifyContent: "center", paddingTop: props.compact ? 0 : 2 },
            labelStyle,
          ]}
        >
          <Text className="text-3xs font-t3-medium text-foreground-muted" numberOfLines={1}>
            {props.label}
          </Text>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

export function ThreadSwipeActions(props: {
  readonly backgroundColor: ColorValue;
  readonly compact: boolean;
  readonly fullSwipeAction?: "delete" | "primary";
  readonly fullSwipeThreshold: number;
  readonly onDelete: () => void;
  readonly onFullSwipeArmedChange: (armed: boolean) => void;
  readonly primaryAction: ThreadSwipePrimaryAction;
  readonly swipeableMethods: SwipeableMethods;
  readonly threadTitle: string;
  readonly translation: SharedValue<number>;
}) {
  const fullSwipeIsPrimary = props.fullSwipeAction === "primary";
  useAnimatedReaction(
    () => -props.translation.value >= props.fullSwipeThreshold,
    (armed, previous) => {
      if (armed !== previous) {
        runOnJS(props.onFullSwipeArmedChange)(armed);
      }
    },
    [props.fullSwipeThreshold, props.onFullSwipeArmedChange],
  );

  return (
    <View
      style={{
        backgroundColor: props.backgroundColor,
        flexDirection: "row",
        height: "100%",
        width: THREAD_SWIPE_ACTIONS_WIDTH,
      }}
    >
      <SwipeActionButton
        accessibilityLabel={props.primaryAction.accessibilityLabel}
        backgroundColor="#007aff"
        compact={props.compact}
        entryRange={[ACTION_ITEM_WIDTH * 0.55, THREAD_SWIPE_ACTIONS_WIDTH * 0.85]}
        fullSwipeThreshold={props.fullSwipeThreshold}
        icon={props.primaryAction.icon}
        label={props.primaryAction.label}
        onPress={props.primaryAction.onPress}
        stretchesOnFullSwipe={fullSwipeIsPrimary}
        translation={props.translation}
      />
      <SwipeActionButton
        accessibilityLabel={`Delete ${props.threadTitle}`}
        backgroundColor="#ff2d55"
        compact={props.compact}
        entryRange={[8, ACTION_ITEM_WIDTH * 0.72]}
        fullSwipeThreshold={props.fullSwipeThreshold}
        icon="trash"
        label="Delete"
        onPress={() => {
          props.swipeableMethods.close();
          props.onDelete();
        }}
        stretchesOnFullSwipe={!fullSwipeIsPrimary}
        translation={props.translation}
      />
    </View>
  );
}
