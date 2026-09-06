import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import type { MenuAction } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { Alert, Pressable, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  ReduceMotion,
  interpolate,
  runOnJS,
  runOnUI,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
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

interface ThreadSwipeAction {
  readonly accessibilityLabel: string;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly menu?: {
    readonly actions: MenuAction[];
    readonly onPressAction: NonNullable<ComponentProps<typeof ControlPillMenu>["onPressAction"]>;
    readonly title?: string;
  };
  readonly onPress: () => void;
}

/** Dismiss before committing; false restores the row, success changes its resetKey or removes it. */
type ThreadSwipePrimaryAction = Omit<ThreadSwipeAction, "onPress"> &
  (
    | { readonly dismissOnPress: true; readonly onPress: () => Promise<boolean> }
    | { readonly dismissOnPress?: false; readonly onPress: () => void }
  );

interface ThreadSwipeSecondaryAction extends ThreadSwipeAction {
  readonly tone: "primary" | "secondary" | "danger";
}

function swipeActionsWidth(hasSecondaryAction: boolean) {
  return hasSecondaryAction ? THREAD_SWIPE_ACTIONS_WIDTH : ACTION_ITEM_WIDTH;
}

/** `undefined` keeps the v1 Delete default; `null` means one action only. */
function resolveSecondaryAction(input: {
  readonly close: () => void;
  readonly onDelete: () => void;
  readonly secondaryAction: ThreadSwipeAction | null | undefined;
  readonly threadTitle: string;
}): ThreadSwipeSecondaryAction | null {
  if (input.secondaryAction === null) return null;
  if (input.secondaryAction === undefined) {
    return {
      accessibilityLabel: `Delete ${input.threadTitle}`,
      tone: "danger",
      icon: "trash",
      label: "Delete",
      onPress: () => {
        input.close();
        input.onDelete();
      },
    };
  }
  const action = input.secondaryAction;
  return {
    ...action,
    tone: "secondary",
    menu:
      action.menu === undefined
        ? undefined
        : {
            ...action.menu,
            onPressAction: (event) => {
              input.close();
              action.menu?.onPressAction(event);
            },
          },
    onPress: () => {
      input.close();
      action.onPress();
    },
  };
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

interface ThreadSwipeableProps {
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
   * What a full swipe commits. Omitted keeps the v1 Delete behavior only when
   * the built-in Delete secondary action is in use; custom or absent
   * secondary actions default to the advertised primary action.
   */
  readonly fullSwipeAction?: "delete" | "primary";
  readonly fullSwipeWidth: number;
  readonly onDelete: () => void;
  readonly onSwipeableClose?: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen?: (methods: SwipeableMethods) => void;
  readonly primaryAction: ThreadSwipePrimaryAction;
  /**
   * Omitted keeps the v1 destructive Delete action. Explicit null opts out of
   * a secondary action entirely so a gated Snooze can never fall back to an
   * unadvertised Delete.
   */
  readonly secondaryAction?: ThreadSwipeAction | null;
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
}

export function ThreadSwipeable(props: ThreadSwipeableProps) {
  // Recycled content gets fresh native and animation state. Late callbacks
  // from the previous row retain its action, never the replacement's action.
  return <ThreadSwipeableRow key={props.resetKey} {...props} />;
}

function ThreadSwipeableRow(props: ThreadSwipeableProps) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const fullSwipeArmedRef = useRef(false);
  const hasSecondaryAction = props.secondaryAction !== null;
  const actionsWidth = swipeActionsWidth(hasSecondaryAction);
  const fullSwipeThreshold = Math.max(actionsWidth + 44, props.fullSwipeWidth * 0.58);
  const fullSwipeAction =
    props.fullSwipeAction ?? (props.secondaryAction === undefined ? "delete" : "primary");
  const close = useCallback(() => swipeableRef.current?.close(), []);
  const gateEnabled = use(SwipeableScrollGateContext);
  const mountedRef = useRef(true);
  const pendingDismissRef = useRef<(() => Promise<boolean>) | null>(null);
  const activeTranslationRef = useRef<SharedValue<number> | null>(null);
  const [isDismissing, setIsDismissing] = useState(false);
  const dismissing = useSharedValue(false);
  const rowHeight = useSharedValue(0);
  const rowWidth = useSharedValue(props.fullSwipeWidth);
  const collapse = useSharedValue(0);
  const actionOpacity = useSharedValue(1);
  const primaryAction = props.primaryAction;
  const onSwipeableClose = props.onSwipeableClose;

  const restoreRow = useCallback(() => {
    swipeableRef.current?.close();
    collapse.set(0);
    actionOpacity.set(1);
    dismissing.set(false);
    setIsDismissing(false);
  }, [actionOpacity, collapse, dismissing]);

  const finishDismiss = useCallback(async () => {
    const action = pendingDismissRef.current;
    if (!action) return;
    pendingDismissRef.current = null;
    try {
      const succeeded = await action();
      if (!succeeded && mountedRef.current) restoreRow();
    } catch (error) {
      if (mountedRef.current) restoreRow();
      Alert.alert(
        "Could not settle thread",
        error instanceof Error ? error.message : "The thread could not be settled.",
      );
    }
  }, [restoreRow]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAnimation(collapse);
      cancelAnimation(actionOpacity);
      if (activeTranslationRef.current) cancelAnimation(activeTranslationRef.current);
      // Scrolling a committed row out of the recycled list must still settle it.
      void finishDismiss();
    };
  }, [actionOpacity, collapse, finishDismiss]);

  const beginDismiss = useCallback(
    (translation: SharedValue<number>) => {
      if (!primaryAction.dismissOnPress) return;
      pendingDismissRef.current = primaryAction.onPress;
      activeTranslationRef.current = translation;
      fullSwipeArmedRef.current = false;
      if (!mountedRef.current) {
        void finishDismiss();
        return;
      }
      setIsDismissing(true);
      if (swipeableRef.current) onSwipeableClose?.(swipeableRef.current);
    },
    [finishDismiss, primaryAction, onSwipeableClose],
  );

  const dismiss = useCallback(
    (translation: SharedValue<number>) => {
      "worklet";
      if (dismissing.value) return;
      dismissing.set(true);
      runOnJS(beginDismiss)(translation);
      const timing = {
        duration: 220,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      };
      actionOpacity.set(withTiming(0, timing));
      // Never reverse a swipe that already carried the row beyond its width.
      translation.set(
        withTiming(Math.min(translation.value, -rowWidth.value), timing, (finished) => {
          if (!finished) return;
          collapse.set(
            withTiming(1, { ...timing, duration: 180 }, (collapsed) => {
              if (collapsed) runOnJS(finishDismiss)();
            }),
          );
        }),
      );
    },
    [actionOpacity, beginDismiss, collapse, dismissing, finishDismiss, rowWidth],
  );
  const dismissStyle = useAnimatedStyle(() => ({
    height: dismissing.value ? rowHeight.value * (1 - collapse.value) : undefined,
    pointerEvents: dismissing.value ? "none" : "auto",
    overflow: "hidden",
  }));
  const actionStyle = useAnimatedStyle(() => ({ opacity: actionOpacity.value, height: "100%" }));
  const dismissOnPress = primaryAction.dismissOnPress === true;
  const handleRelease = useCallback(
    (translation: SharedValue<number>) => {
      "worklet";
      if (dismissing.value) return true;
      if (
        dismissOnPress &&
        fullSwipeAction === "primary" &&
        -translation.value >= fullSwipeThreshold
      ) {
        dismiss(translation);
        return true;
      }
      return false;
    },
    [dismiss, dismissing, dismissOnPress, fullSwipeAction, fullSwipeThreshold],
  );
  const handleFullSwipeArmedChange = useCallback((armed: boolean) => {
    if (armed && !fullSwipeArmedRef.current) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    fullSwipeArmedRef.current = armed;
  }, []);

  return (
    <Animated.View style={dismissStyle}>
      <View
        onLayout={({ nativeEvent: { layout } }) => {
          rowHeight.set(layout.height);
          rowWidth.set(layout.width);
        }}
      >
        <ReanimatedSwipeable
          ref={swipeableRef}
          animationOptions={THREAD_SWIPE_SPRING}
          childrenContainerStyle={{ backgroundColor: props.backgroundColor }}
          containerStyle={[{ backgroundColor: props.backgroundColor }, props.containerStyle]}
          dragOffsetFromRightEdge={8}
          enabled={!isDismissing && props.enabled !== false && gateEnabled}
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
          onSwipeableRelease={handleRelease}
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
            if (fullSwipeArmedRef.current && !(dismissOnPress && fullSwipeAction === "primary")) {
              fullSwipeArmedRef.current = false;
              methods.close();
              if (fullSwipeAction === "primary") {
                props.primaryAction.onPress();
              } else {
                props.onDelete();
              }
            }
          }}
          overshootFriction={1}
          overshootRight
          renderRightActions={(_progress, translation, methods) => (
            <Animated.View style={actionStyle}>
              <ThreadSwipeActions
                backgroundColor={props.backgroundColor}
                compact={props.compactActions === true}
                fullSwipeAction={fullSwipeAction}
                fullSwipeThreshold={fullSwipeThreshold}
                onFullSwipeArmedChange={handleFullSwipeArmedChange}
                primaryAction={{
                  ...primaryAction,
                  onPress: () => {
                    if (primaryAction.dismissOnPress) {
                      runOnUI(dismiss)(translation);
                    } else {
                      methods.close();
                      primaryAction.onPress();
                    }
                  },
                }}
                secondaryAction={resolveSecondaryAction({
                  close: () => methods.close(),
                  onDelete: props.onDelete,
                  secondaryAction: props.secondaryAction,
                  threadTitle: props.threadTitle,
                })}
                translation={translation}
              />
            </Animated.View>
          )}
          rightThreshold={actionsWidth * 0.42}
          simultaneousWithExternalGesture={props.simultaneousWithExternalGesture}
        >
          {props.children(close)}
        </ReanimatedSwipeable>
      </View>
    </Animated.View>
  );
}

function SwipeActionButton(props: {
  readonly accessibilityLabel: string;
  readonly actionsWidth: number;
  readonly tone: "primary" | "secondary" | "danger";
  readonly compact: boolean;
  readonly entryRange: readonly [number, number];
  readonly fullSwipeThreshold: number;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly menu?: ThreadSwipeAction["menu"];
  readonly onPress: () => void;
  readonly stretchesOnFullSwipe: boolean;
  readonly translation: SharedValue<number>;
}) {
  const {
    actionsWidth,
    entryRange: [entryRangeStart, entryRangeEnd],
    fullSwipeThreshold,
    stretchesOnFullSwipe,
    translation,
  } = props;
  const circleSize = props.compact ? COMPACT_ACTION_CIRCLE_SIZE : ACTION_CIRCLE_SIZE;
  const iconSize = props.compact ? COMPACT_ACTION_ICON_SIZE : ACTION_ICON_SIZE;
  const actionStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-translation.value, 0);
    const entryProgress = interpolate(
      reveal,
      [entryRangeStart, entryRangeEnd],
      [0, 1],
      Extrapolation.CLAMP,
    );
    const stretch = Math.max(reveal - actionsWidth, 0);
    const fullSwipeProgress = interpolate(
      reveal,
      [actionsWidth, fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      opacity: stretchesOnFullSwipe ? entryProgress : entryProgress * (1 - fullSwipeProgress),
      transform: [
        {
          translateX:
            interpolate(entryProgress, [0, 1], [22, 0]) - (stretchesOnFullSwipe ? 0 : stretch),
        },
        { scale: interpolate(entryProgress, [0, 1], [0.78, 1]) },
      ],
    };
  });
  const circleStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-translation.value, 0);
    const stretch = stretchesOnFullSwipe ? Math.max(reveal - actionsWidth, 0) : 0;

    return {
      transform: [{ translateX: -stretch }],
      width: circleSize + stretch,
    };
  });
  const iconStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-translation.value, 0);
    const stretch = stretchesOnFullSwipe ? Math.max(reveal - actionsWidth, 0) : 0;
    const armedProgress = interpolate(
      reveal,
      [fullSwipeThreshold, fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      transform: [{ translateX: -stretch * (0.5 + armedProgress * 0.5) }],
    };
  });
  const labelStyle = useAnimatedStyle(() => {
    if (!stretchesOnFullSwipe) {
      return { opacity: 1 };
    }

    const reveal = Math.max(-translation.value, 0);
    const stretch = Math.max(reveal - actionsWidth, 0);
    return {
      opacity: interpolate(
        reveal,
        [fullSwipeThreshold - 24, fullSwipeThreshold],
        [1, 0],
        Extrapolation.CLAMP,
      ),
      transform: [{ translateX: -stretch * 0.5 }],
    };
  });

  const button = (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      onPress={props.menu === undefined ? props.onPress : undefined}
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
          className={
            props.tone === "danger"
              ? "bg-danger"
              : props.tone === "secondary"
                ? "bg-secondary"
                : "bg-primary"
          }
          style={[
            {
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
          <SymbolView
            name={props.icon}
            size={iconSize}
            tintColorClassName={
              props.tone === "danger"
                ? "accent-danger-foreground"
                : props.tone === "secondary"
                  ? "accent-secondary-foreground"
                  : "accent-primary-foreground"
            }
            type="monochrome"
          />
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
  );

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
      {props.menu === undefined ? (
        button
      ) : (
        <ControlPillMenu
          actions={props.menu.actions}
          onPressAction={props.menu.onPressAction}
          title={props.menu.title}
          style={{ height: "100%", width: "100%" }}
        >
          {button}
        </ControlPillMenu>
      )}
    </Animated.View>
  );
}

export function ThreadSwipeActions(props: {
  readonly backgroundColor: ColorValue;
  readonly compact: boolean;
  readonly fullSwipeAction?: "delete" | "primary";
  readonly fullSwipeThreshold: number;
  readonly onFullSwipeArmedChange: (armed: boolean) => void;
  readonly primaryAction: ThreadSwipeAction;
  readonly secondaryAction: ThreadSwipeSecondaryAction | null;
  readonly translation: SharedValue<number>;
}) {
  const { fullSwipeThreshold, onFullSwipeArmedChange, secondaryAction, translation } = props;
  const fullSwipeIsPrimary = props.fullSwipeAction === "primary" || secondaryAction === null;
  const actionsWidth = swipeActionsWidth(secondaryAction !== null);
  useAnimatedReaction(
    () => -translation.value >= fullSwipeThreshold,
    (armed, previous) => {
      if (armed !== previous) {
        runOnJS(onFullSwipeArmedChange)(armed);
      }
    },
    [fullSwipeThreshold, onFullSwipeArmedChange, translation],
  );

  return (
    <View
      style={{
        backgroundColor: props.backgroundColor,
        flexDirection: "row",
        height: "100%",
        width: actionsWidth,
      }}
    >
      <SwipeActionButton
        accessibilityLabel={props.primaryAction.accessibilityLabel}
        actionsWidth={actionsWidth}
        tone="primary"
        compact={props.compact}
        entryRange={
          secondaryAction === null
            ? [8, ACTION_ITEM_WIDTH * 0.72]
            : [ACTION_ITEM_WIDTH * 0.55, THREAD_SWIPE_ACTIONS_WIDTH * 0.85]
        }
        fullSwipeThreshold={props.fullSwipeThreshold}
        icon={props.primaryAction.icon}
        label={props.primaryAction.label}
        onPress={props.primaryAction.onPress}
        stretchesOnFullSwipe={fullSwipeIsPrimary}
        translation={props.translation}
      />
      {secondaryAction === null ? null : (
        <SwipeActionButton
          accessibilityLabel={secondaryAction.accessibilityLabel}
          actionsWidth={actionsWidth}
          tone={secondaryAction.tone}
          compact={props.compact}
          entryRange={[8, ACTION_ITEM_WIDTH * 0.72]}
          fullSwipeThreshold={props.fullSwipeThreshold}
          icon={secondaryAction.icon}
          label={secondaryAction.label}
          menu={secondaryAction.menu}
          onPress={secondaryAction.onPress}
          stretchesOnFullSwipe={!fullSwipeIsPrimary}
          translation={props.translation}
        />
      )}
    </View>
  );
}
