import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import type { MenuAction } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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

import { AppText as Text } from "../../components/ui/AppText";
import { SwipeRowActivationContext, type SwipeRowActivation } from "./swipe-row-activation";
import { registerThreadDismissal } from "./thread-dismissal";

const ACTION_ITEM_WIDTH = 58;
const ACTION_CIRCLE_SIZE = 36;
const ACTION_ICON_SIZE = 15;
const COMPACT_ACTION_CIRCLE_SIZE = 28;
const COMPACT_ACTION_ICON_SIZE = 13;

const THREAD_SWIPE_ACTIONS_WIDTH = ACTION_ITEM_WIDTH * 2;
const THREAD_SWIPE_SPRING = {
  damping: 26,
  mass: 0.7,
  overshootClamping: true,
  stiffness: 330,
};

interface ThreadSwipeAction {
  readonly accessibilityLabel: string;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly destructive?: boolean;
  readonly menu?: {
    readonly actions: MenuAction[];
    readonly onPressAction: NonNullable<ComponentProps<typeof Menu>["onPressAction"]>;
    readonly title?: string;
  };
  readonly onPress: () => void;
}

interface ThreadSwipeSecondaryAction extends ThreadSwipeAction {
  readonly tone: "primary" | "secondary" | "danger";
}

function swipeActionsWidth(hasSecondaryAction: boolean) {
  return hasSecondaryAction ? THREAD_SWIPE_ACTIONS_WIDTH : ACTION_ITEM_WIDTH;
}

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

/** Keep the scroll gate in context so scroll start cannot re-render every row and its subscriptions. */
const SwipeableScrollGateContext = createContext(true);
// Swipeable rebuilds its native pan gesture whenever its config changes identity, so the props
// that feed it stay stable across row re-renders such as selection.
const FAIL_OFFSET_Y: [number, number] = [-10, 10];

export function SwipeableScrollGateProvider(props: {
  readonly enabled: boolean;
  readonly activation?: SwipeRowActivation;
  readonly children: ReactNode;
}) {
  return (
    <SwipeableScrollGateContext.Provider value={props.enabled}>
      <SwipeRowActivationContext value={props.activation ?? null}>
        {props.children}
      </SwipeRowActivationContext>
    </SwipeableScrollGateContext.Provider>
  );
}

/** Trackpads can start pans mid-momentum, bypassing failOffsetY; disable swipes during vertical scrolls. */
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the scroll settle timer on unmount
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
  readonly compactActions?: boolean;
  readonly containerStyle?: StyleProp<ViewStyle>;
  readonly enabled?: boolean;
  readonly enableTrackpadSwipe?: boolean;
  /** Omitted uses Delete only with the built-in Delete secondary action; otherwise it uses primary. */
  readonly fullSwipeAction?: "delete" | "primary";
  readonly fullSwipeWidth: number;
  readonly onDelete: () => void;
  readonly onSwipeableClose?: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen?: (methods: SwipeableMethods) => void;
  readonly primaryAction: ThreadSwipeAction;
  readonly threadKey: string;
  /** Omitted defaults to Delete; null removes it so gated Snooze cannot fall back to Delete. */
  readonly secondaryAction?: ThreadSwipeAction | null;
  readonly resetKey?: string;
  readonly dormant?: boolean;
  readonly simultaneousWith?: ComponentProps<typeof ReanimatedSwipeable>["simultaneousWith"];
  readonly threadTitle: string;
}

export function ThreadSwipeable(props: ThreadSwipeableProps) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const hasSecondaryAction = props.secondaryAction !== null;
  const actionsWidth = swipeActionsWidth(hasSecondaryAction);
  const fullSwipeThreshold = Math.max(actionsWidth + 44, props.fullSwipeWidth * 0.58);
  const fullSwipeAction =
    props.fullSwipeAction ?? (props.secondaryAction === undefined ? "delete" : "primary");
  const close = useCallback(() => swipeableRef.current?.close(), []);
  const gateEnabled = use(SwipeableScrollGateContext);
  const mountedRef = useRef(true);
  const dismissalRef = useRef<{ finished: Promise<void>; restore: () => void } | null>(null);
  const pendingDismissRef = useRef<{ id: number; resolve: () => void } | null>(null);
  const dismissalIdRef = useRef(0);
  const activeTranslationRef = useRef<SharedValue<number> | null>(null);
  const content = useMemo(
    () => ({ resetKey: props.resetKey, threadKey: props.threadKey }),
    [props.resetKey, props.threadKey],
  );
  const contentRef = useRef(content);
  const [isDismissing, setIsDismissing] = useState(false);
  const dismissing = useSharedValue(false);
  const rowHeight = useSharedValue(0);
  const rowWidth = useSharedValue(props.fullSwipeWidth);
  const collapse = useSharedValue(0);
  const fallbackTranslation = useSharedValue(0);
  const actionOpacity = useSharedValue(1);
  const primaryAction = props.primaryAction;
  const onDelete = props.onDelete;
  const onSwipeableClose = props.onSwipeableClose;

  const restoreRow = useCallback(() => {
    if (!mountedRef.current) return;
    dismissalRef.current = null;
    // RN-to-UI jobs run in order, so this also resets a queued dismissal.
    runOnUI((methods: SwipeableMethods | null) => {
      "worklet";
      methods?.reset();
      // RNGH reset() leaves tap-to-close enabled; close() clears it.
      methods?.close();
      fallbackTranslation.set(0);
      collapse.set(0);
      actionOpacity.set(1);
      dismissing.set(false);
    })(swipeableRef.current);
    setIsDismissing(false);
  }, [actionOpacity, collapse, dismissing, fallbackTranslation]);

  const finishDismiss = useCallback((id?: number) => {
    const pending = pendingDismissRef.current;
    if (!pending || (id !== undefined && pending.id !== id)) return;
    pendingDismissRef.current = null;
    pending.resolve();
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the row's Reanimated animations and settles a pending dismissal on unmount
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAnimation(collapse);
      cancelAnimation(actionOpacity);
      cancelAnimation(fallbackTranslation);
      if (activeTranslationRef.current) cancelAnimation(activeTranslationRef.current);
      finishDismiss();
    };
  }, [actionOpacity, collapse, fallbackTranslation, finishDismiss]);

  // Reset recycled rows in place so their child views stay mounted.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets the swipeable and its shared values when the list recycles this row for new content
  useLayoutEffect(() => {
    if (contentRef.current === content) return;
    contentRef.current = content;
    finishDismiss();
    restoreRow();
  }, [content, finishDismiss, restoreRow]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the open swipeable and resets its shared values when the row goes dormant
  useLayoutEffect(() => {
    if (props.dormant && activeTranslationRef.current && dismissalRef.current === null) {
      restoreRow();
    }
  }, [props.dormant, restoreRow]);

  const dismiss = useCallback(
    (translation: SharedValue<number>, id: number) => {
      "worklet";
      if (dismissing.value) return;
      dismissing.set(true);
      const timing = {
        duration: 220,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      };
      actionOpacity.set(withTiming(0, timing));
      translation.set(
        withTiming(Math.min(translation.value, -rowWidth.value), timing, (finished) => {
          if (!finished) return;
          collapse.set(
            withTiming(1, { ...timing, duration: 180 }, (collapsed) => {
              if (collapsed) runOnJS(finishDismiss)(id);
            }),
          );
        }),
      );
    },
    [actionOpacity, collapse, dismissing, finishDismiss, rowWidth],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this row's animated dismissal in the module-level thread dismissal registry
  useLayoutEffect(
    () =>
      props.dormant
        ? undefined
        : registerThreadDismissal(props.threadKey, () => {
            if (dismissalRef.current) return dismissalRef.current;
            const id = ++dismissalIdRef.current;
            const finished = new Promise<void>((resolve) => {
              pendingDismissRef.current = { id, resolve };
            });
            setIsDismissing(true);
            if (swipeableRef.current) onSwipeableClose?.(swipeableRef.current);
            runOnUI(dismiss)(activeTranslationRef.current ?? fallbackTranslation, id);
            const dismissal = {
              finished,
              restore: () => {
                if (dismissalRef.current === dismissal) restoreRow();
              },
            };
            dismissalRef.current = dismissal;
            return dismissal;
          }),
    [dismiss, fallbackTranslation, onSwipeableClose, props.dormant, props.threadKey, restoreRow],
  );
  const dismissStyle = useAnimatedStyle(() => ({
    // Native prop updates omit undefined, leaving a collapsed height in place.
    height: dismissing.value ? rowHeight.value * (1 - collapse.value) : "auto",
    pointerEvents: dismissing.value ? "none" : "auto",
    overflow: "hidden",
    transform: [{ translateX: fallbackTranslation.value }],
  }));
  const actionStyle = useAnimatedStyle(() => ({ opacity: actionOpacity.value, height: "100%" }));
  const commitPrimaryAction = useCallback(() => {
    if (!mountedRef.current || contentRef.current !== content) return;
    primaryAction.onPress();
    if (!pendingDismissRef.current) swipeableRef.current?.close();
  }, [content, primaryAction]);
  // RNGH lifecycle events call the latest handler, so commit from this release.
  const commitFullSwipe = useCallback(() => {
    if (!mountedRef.current || contentRef.current !== content) return;
    if (fullSwipeAction === "primary") commitPrimaryAction();
    else {
      swipeableRef.current?.close();
      onDelete();
    }
  }, [commitPrimaryAction, content, fullSwipeAction, onDelete]);
  const handleRelease = useCallback(
    (translation: SharedValue<number>) => {
      "worklet";
      if (dismissing.value) return true;
      if (-translation.value >= fullSwipeThreshold) {
        runOnJS(commitFullSwipe)();
        return true;
      }
      return false;
    },
    [commitFullSwipe, dismissing, fullSwipeThreshold],
  );
  const handleFullSwipeArmedChange = useCallback(
    (armed: boolean) => {
      if (mountedRef.current && contentRef.current === content && armed) {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
    },
    [content],
  );
  const { dormant, onSwipeableWillOpen, backgroundColor, containerStyle } = props;
  const handleWillOpen = useCallback(() => {
    if (!dormant && !dismissalRef.current && swipeableRef.current) {
      onSwipeableWillOpen?.(swipeableRef.current);
    }
  }, [dormant, onSwipeableWillOpen]);
  const handleSwipeableClose = useCallback(() => {
    if (swipeableRef.current) onSwipeableClose?.(swipeableRef.current);
  }, [onSwipeableClose]);
  const compactActions = props.compactActions === true;
  const { secondaryAction, threadTitle } = props;
  // Swipeable calls this on every render; returning the previous element while nothing it shows
  // changed keeps a selection change from re-rendering the hidden actions.
  const rightActions = useRef<{ deps: readonly unknown[]; element: ReactNode } | null>(null);
  const renderRightActions = (
    _progress: SharedValue<number>,
    translation: SharedValue<number>,
    methods: SwipeableMethods,
  ) => {
    const deps = [
      dormant,
      translation,
      methods,
      actionStyle,
      backgroundColor,
      compactActions,
      fullSwipeAction,
      fullSwipeThreshold,
      handleFullSwipeArmedChange,
      primaryAction,
      commitPrimaryAction,
      onDelete,
      secondaryAction,
      threadTitle,
    ];
    const cached = rightActions.current;
    if (cached && deps.every((dep, index) => Object.is(dep, cached.deps[index]))) {
      return cached.element;
    }
    const element = dormant ? null : (
      <Animated.View
        ref={() => {
          activeTranslationRef.current = translation;
        }}
        style={actionStyle}
      >
        <ThreadSwipeActions
          backgroundColor={backgroundColor}
          compact={compactActions}
          fullSwipeAction={fullSwipeAction}
          fullSwipeThreshold={fullSwipeThreshold}
          onFullSwipeArmedChange={handleFullSwipeArmedChange}
          primaryAction={{ ...primaryAction, onPress: commitPrimaryAction }}
          secondaryAction={resolveSecondaryAction({
            close: () => methods.close(),
            onDelete,
            secondaryAction,
            threadTitle,
          })}
          translation={translation}
        />
      </Animated.View>
    );
    rightActions.current = { deps, element };
    return element;
  };
  const childrenContainerStyle = useMemo(() => ({ backgroundColor }), [backgroundColor]);
  const swipeableContainerStyle = useMemo(
    () => [{ backgroundColor }, containerStyle],
    [backgroundColor, containerStyle],
  );

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
          childrenContainerStyle={childrenContainerStyle}
          containerStyle={swipeableContainerStyle}
          dragOffsetFromRight={-8}
          enabled={!props.dormant && !isDismissing && props.enabled !== false && gateEnabled}
          enableTrackpadTwoFingerGesture={props.enableTrackpadSwipe ?? true}
          // Reject vertical pans via patched RNGH failOffsetY; simultaneous trackpad scrolls otherwise open rows on horizontal drift.
          failOffsetY={FAIL_OFFSET_Y}
          friction={1}
          onSwipeableClose={handleSwipeableClose}
          onSwipeableRelease={handleRelease}
          onSwipeableOpenStartDrag={handleWillOpen}
          onSwipeableWillOpen={handleWillOpen}
          overshootFriction={1}
          overshootRight
          renderRightActions={renderRightActions}
          rightThreshold={actionsWidth * 0.42}
          simultaneousWith={props.simultaneousWith}
        >
          {
            /* oxlint-disable react/refs -- The render callback receives a close/open handler; only invoking that handler accesses the ref. */
            props.children(close)
            /* oxlint-enable react/refs */
          }
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
        <Menu
          actions={props.menu.actions}
          onPressAction={props.menu.onPressAction}
          title={props.menu.title}
          style={{ height: "100%", width: "100%" }}
        >
          {button}
        </Menu>
      )}
    </Animated.View>
  );
}

function ThreadSwipeActions(props: {
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
        tone={props.primaryAction.destructive === true ? "danger" : "primary"}
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
