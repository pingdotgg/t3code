import * as Haptics from "expo-haptics";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, {
  interpolate,
  runOnJS,
  runOnUI,
  useAnimatedProps,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useEvent,
  useSharedValue,
  withTiming,
  type ScrollEvent,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { SymbolView, type AppSymbolName } from "./ui/AppSymbol";
import {
  SCROLL_PULL_FEED_EVENTS,
  SCROLL_PULL_SWING_FROM_FEED_TOUCHES,
  type ScrollPullEvent,
} from "../native/T3ScrollPull";
import {
  PULL_THRESHOLD as THRESHOLD,
  isPullActionEnabled,
  overscrollPastEnd,
  pointPullAction,
  pullFromStretch,
  pullNeedleAngle,
  pullSlotAngle,
  selectedPullAction,
  shouldRunPullAction,
  trackPull,
} from "./pull-action-wheel";

export type PullActionTone = "primary" | "success" | "warning";

export interface PullAction {
  readonly id: string;
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly tone: PullActionTone;
  readonly enabled: boolean;
  readonly run: () => void;
}

const TONE_ON_FILL_CLASS = {
  primary: "accent-primary-foreground",
  success: "accent-screen",
  warning: "accent-screen",
} satisfies Record<PullActionTone, string>;

const SETTLE = { duration: 180 };
const CHANGE = { duration: 120 };

const HUB = 18;
const RADIUS = 80;
const BUTTON = 44;
const LABEL_WIDTH = 76;
const WHEEL_HEIGHT = 122;
const HUB_Y = WHEEL_HEIGHT - HUB / 2 - 2;
const NEEDLE = RADIUS - BUTTON / 2;
const RING_RADIUS = HUB / 2 - 1.5;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const SCRIM_SOLID = WHEEL_HEIGHT + 8;
const SCRIM_FADE = 48;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const armedHaptic = () => {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};
const selectionHaptic = () => {
  void Haptics.selectionAsync();
};

interface RegisteredEventHandler {
  readonly workletEventHandler: {
    registerForEvents(viewTag: number): void;
    unregisterFromEvents(viewTag: number): void;
  };
}

// Wire scrollRef to the scroll view, plus stretchEvents (Android) or onFinger (iOS).
export function usePullActionWheel(actions: ReadonlyArray<PullAction>, defaultIndex: number) {
  const enabled = actions.length > 0;
  const count = actions.length;
  const enabledMask = actions.reduce(
    (mask, action, index) => (action.enabled ? mask | (1 << index) : mask),
    0,
  );
  const choices = useDerivedValue(() => ({ count, defaultIndex, enabledMask }));
  const latestActions = useRef(actions);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a release on the UI thread calls back into the actions this commit rendered
  useLayoutEffect(() => {
    latestActions.current = actions;
  });
  const [runAction] = useState(() => (index: number) => {
    const action = latestActions.current[index];
    if (action?.enabled) action.run();
  });

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const distance = useSharedValue(0);
  const armedAt = useSharedValue<number | null>(null);
  const drag = useSharedValue<"idle" | "pulling" | "keyboard">("idle");
  const needle = useSharedValue(0);
  const pointed = useSharedValue(-1);
  const selected = useSharedValue(-1);
  const aimDx = useSharedValue(0);
  const aimDy = useSharedValue(0);
  const fingerX = useSharedValue(0);
  const fingerY = useSharedValue(0);
  const pullStartX = useSharedValue<number | null>(null);
  const pullStartY = useSharedValue(0);
  const { progress: keyboard } = useReanimatedKeyboardAnimation();

  const steer = (tick: boolean) => {
    "worklet";
    const options = choices.get();
    const dx = aimDx.get();
    const dy = aimDy.get();
    needle.set(pullNeedleAngle(dx, dy, options.count, options.defaultIndex));
    const nextPointed = pointPullAction(
      dx,
      dy,
      armedAt.get() !== null,
      pointed.get(),
      options.count,
      options.defaultIndex,
    );
    pointed.set(nextPointed);
    const next = selectedPullAction(nextPointed, options.enabledMask);
    if (next === selected.get()) return;
    selected.set(next);
    if (tick && next >= 0) runOnJS(selectionHaptic)();
  };
  const aim = (dx: number, dy: number) => {
    "worklet";
    aimDx.set(dx);
    aimDy.set(dy);
  };
  const begin = () => {
    "worklet";
    armedAt.set(null);
    pullStartX.set(null);
    aim(0, 0);
    drag.set(keyboard.get() < 0.01 ? "pulling" : "keyboard");
    pointed.set(-1);
    selected.set(-1);
    steer(false);
  };
  const update = (next: number) => {
    "worklet";
    if (drag.get() !== "pulling" || next === distance.get()) return;
    if (next === 0) {
      pullStartX.set(null);
      aim(0, 0);
    } else if (SCROLL_PULL_SWING_FROM_FEED_TOUCHES && pullStartX.get() === null) {
      pullStartX.set(fingerX.get());
      pullStartY.set(fingerY.get());
      aim(0, 0);
    }
    distance.set(next);
    const nextArmedAt = trackPull(armedAt.get(), next, THRESHOLD, Date.now());
    const arming = nextArmedAt !== null && armedAt.get() === null;
    armedAt.set(nextArmedAt);
    steer(!arming);
    if (arming && selected.get() >= 0) runOnJS(armedHaptic)();
  };
  const swing = (dx: number, dy: number) => {
    "worklet";
    if (drag.get() !== "pulling") return;
    aim(dx, dy);
    steer(true);
  };
  const release = (released: boolean, velocity: number) => {
    "worklet";
    const index = selected.get();
    const run =
      index >= 0 &&
      isPullActionEnabled(choices.get().enabledMask, index) &&
      shouldRunPullAction(armedAt.get(), Date.now(), released, velocity);
    drag.set("idle");
    armedAt.set(null);
    pullStartX.set(null);
    distance.set(withTiming(0, SETTLE));
    if (run) runOnJS(runAction)(index);
  };

  const scrollEvents = useEvent<ScrollEvent>((event) => {
    "worklet";
    if (event.eventName.endsWith("onScrollBeginDrag")) begin();
    else {
      update(overscrollPastEnd(event));
      if (event.eventName.endsWith("onScrollEndDrag")) release(true, event.velocity?.y ?? 0);
    }
  }, SCROLL_PULL_FEED_EVENTS) as unknown as RegisteredEventHandler;
  const stretchEvents = useEvent<ScrollPullEvent>(
    (event) => {
      "worklet";
      if ("released" in event) {
        release(event.released, event.velocity);
        return;
      }
      if (drag.get() === "idle") begin();
      aim(event.dx, event.dy);
      update(pullFromStretch(event.distance));
      swing(event.dx, event.dy);
    },
    ["onPull", "onPullEnd"],
  );
  const touchAt = (x: number, y: number) => {
    "worklet";
    fingerX.set(x);
    fingerY.set(y);
    const startX = pullStartX.get();
    if (startX !== null) swing(x - startX, pullStartY.get() - y);
  };
  const onFinger = (x: number, y: number) => runOnUI(touchAt)(x, y);
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
    onFinger: enabled && SCROLL_PULL_SWING_FROM_FEED_TOUCHES ? onFinger : undefined,
    wheel: enabled ? { actions, distance, armedAt, needle, selected } : null,
  };
}

type Wheel = NonNullable<ReturnType<typeof usePullActionWheel>["wheel"]>;

function useToneColors(): Record<PullActionTone, string> {
  return {
    primary: String(useResolveClassNames("text-primary").color),
    success: String(useResolveClassNames("text-adaptive-emerald-600-400").color),
    warning: String(useResolveClassNames("text-warning-foreground").color),
  };
}

function slot(index: number, count: number) {
  const angle = (pullSlotAngle(index, count) * Math.PI) / 180;
  return { x: RADIUS * Math.sin(angle), y: HUB_Y - RADIUS * Math.cos(angle) };
}

function wheelGeometry(count: number) {
  const halfWidth = Math.max(Math.abs(slot(0, count).x) + LABEL_WIDTH / 2, BUTTON);
  const arcAngle = ((Math.abs(pullSlotAngle(0, count)) + 16) * Math.PI) / 180;
  const arcX = RADIUS * Math.sin(arcAngle);
  const arcY = HUB_Y - RADIUS * Math.cos(arcAngle);
  return {
    halfWidth,
    width: halfWidth * 2,
    arc: `M ${halfWidth - arcX} ${arcY} A ${RADIUS} ${RADIUS} 0 0 1 ${halfWidth + arcX} ${arcY}`,
  };
}

export function PullActionWheel(props: {
  readonly wheel: Wheel;
  readonly bottom: number;
  readonly screenColor: string;
}) {
  const { actions, distance, armedAt, needle, selected } = props.wheel;
  const count = actions.length;
  const toneColors = useToneColors();
  const colors = actions.map((action) => toneColors[action.tone]);
  const mutedColor = String(useResolveClassNames("text-border").color);
  const { halfWidth, width, arc } = wheelGeometry(count);

  const appearStyle = useAnimatedStyle(() => {
    const value = distance.get();
    return {
      opacity: interpolate(value, [THRESHOLD * 0.2, THRESHOLD * 0.7], [0, 1], "clamp"),
      transform: [
        { translateY: interpolate(value, [0, THRESHOLD], [24, 0], "clamp") },
        { scale: interpolate(value, [0, THRESHOLD], [0.85, 1], "clamp") },
      ],
    };
  });
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(distance.get(), [THRESHOLD * 0.2, THRESHOLD * 0.7], [0, 1], "clamp"),
  }));
  const needleStyle = useAnimatedStyle(() => ({
    backgroundColor: colors[selected.get()] ?? mutedColor,
    transform: [{ rotate: `${needle.get()}deg` }],
  }));
  const ringProps = useAnimatedProps(() => ({
    stroke: colors[selected.get()] ?? mutedColor,
    strokeDashoffset: RING_LENGTH * (1 - Math.min(distance.get() / THRESHOLD, 1)),
  }));
  const hubDotStyle = useAnimatedStyle(() => ({
    backgroundColor: colors[selected.get()] ?? mutedColor,
    opacity: withTiming(armedAt.get() === null || selected.get() < 0 ? 0 : 1, CHANGE),
  }));

  return (
    <>
      <Animated.View
        pointerEvents="none"
        className="absolute inset-x-0 bottom-0"
        style={[{ height: props.bottom + SCRIM_SOLID + SCRIM_FADE }, scrimStyle]}
      >
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id="pull-action-wheel-scrim" x1="0%" x2="0%" y1="0%" y2="100%">
              <Stop offset="0%" stopColor={props.screenColor} stopOpacity={0} />
              <Stop
                offset={SCRIM_FADE / (props.bottom + SCRIM_SOLID + SCRIM_FADE)}
                stopColor={props.screenColor}
                stopOpacity={1}
              />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#pull-action-wheel-scrim)" />
        </Svg>
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        className="absolute inset-x-0 items-center"
        style={[{ bottom: props.bottom }, appearStyle]}
      >
        <View style={{ height: WHEEL_HEIGHT, width }}>
          <Svg width={width} height={WHEEL_HEIGHT} style={StyleSheet.absoluteFill}>
            <Path d={arc} fill="none" stroke={mutedColor} strokeWidth={1.5} strokeDasharray="3 5" />
          </Svg>
          <Animated.View
            style={[
              {
                position: "absolute",
                left: halfWidth - 1,
                top: HUB_Y - NEEDLE,
                width: 2,
                height: NEEDLE,
                borderRadius: 1,
                transformOrigin: "50% 100%",
              },
              needleStyle,
            ]}
          />
          {actions.map((action, index) => {
            const { x, y } = slot(index, count);
            return (
              <WheelButton
                key={action.id}
                action={action}
                index={index}
                color={colors[index] ?? mutedColor}
                labelBackground={props.screenColor}
                left={halfWidth + x}
                top={y}
                armedAt={armedAt}
                selected={selected}
              />
            );
          })}
          <View
            className="absolute items-center justify-center rounded-full bg-card"
            style={{ left: halfWidth - HUB / 2, top: HUB_Y - HUB / 2, width: HUB, height: HUB }}
          >
            <Animated.View className="size-2 rounded-full" style={hubDotStyle} />
            <Svg width={HUB} height={HUB} style={StyleSheet.absoluteFill}>
              <Circle
                cx={HUB / 2}
                cy={HUB / 2}
                r={RING_RADIUS}
                fill="none"
                stroke={mutedColor}
                strokeWidth={2.5}
              />
              <AnimatedCircle
                cx={HUB / 2}
                cy={HUB / 2}
                r={RING_RADIUS}
                fill="none"
                strokeWidth={2.5}
                strokeDasharray={RING_LENGTH}
                strokeLinecap="round"
                rotation={-90}
                origin={`${HUB / 2}, ${HUB / 2}`}
                animatedProps={ringProps}
              />
            </Svg>
          </View>
        </View>
      </Animated.View>
    </>
  );
}

function WheelButton(props: {
  readonly action: PullAction;
  readonly index: number;
  readonly color: string;
  readonly labelBackground: string;
  readonly left: number;
  readonly top: number;
  readonly armedAt: SharedValue<number | null>;
  readonly selected: SharedValue<number>;
}) {
  const { index, armedAt, selected } = props;
  const buttonStyle = useAnimatedStyle(() => ({
    transform: [
      {
        scale: withTiming(
          selected.get() !== index ? 1 : armedAt.get() === null ? 1.08 : 1.2,
          CHANGE,
        ),
      },
    ],
  }));
  const fillStyle = useAnimatedStyle(() => ({
    opacity: withTiming(selected.get() !== index ? 0 : armedAt.get() === null ? 0.2 : 1, CHANGE),
  }));
  const mutedIconStyle = useAnimatedStyle(() => ({
    opacity: withTiming(selected.get() === index ? 0 : 1, CHANGE),
  }));
  const toneIconStyle = useAnimatedStyle(() => ({
    opacity: withTiming(selected.get() === index && armedAt.get() === null ? 1 : 0, CHANGE),
  }));
  const onFillIconStyle = useAnimatedStyle(() => ({
    opacity: withTiming(selected.get() === index && armedAt.get() !== null ? 1 : 0, CHANGE),
  }));
  const labelStyle = useAnimatedStyle(() => ({
    opacity: withTiming(selected.get() === index ? 1 : 0.6, CHANGE),
  }));
  const icon = (
    className: string | undefined,
    style: ReturnType<typeof useAnimatedStyle>,
    tintColor?: string,
  ) => (
    <Animated.View className="items-center justify-center" style={[StyleSheet.absoluteFill, style]}>
      <SymbolView
        name={props.action.icon}
        size={18}
        tintColor={tintColor}
        tintColorClassName={className}
        type="monochrome"
      />
    </Animated.View>
  );
  return (
    <View
      className="absolute items-center"
      style={{
        left: props.left - LABEL_WIDTH / 2,
        top: props.top - BUTTON / 2,
        width: LABEL_WIDTH,
        opacity: props.action.enabled ? 1 : 0.35,
      }}
    >
      <Animated.View
        className="overflow-hidden rounded-full border border-border bg-card"
        style={[{ width: BUTTON, height: BUTTON }, buttonStyle]}
      >
        <Animated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: props.color }, fillStyle]}
        />
        {icon("accent-icon-muted", mutedIconStyle)}
        {icon(undefined, toneIconStyle, props.color)}
        {icon(TONE_ON_FILL_CLASS[props.action.tone], onFillIconStyle)}
      </Animated.View>
      <Animated.View
        className="mt-1 rounded px-1"
        style={[{ backgroundColor: props.labelBackground }, labelStyle]}
      >
        <Text className="text-center text-[11px] font-t3-medium text-foreground" numberOfLines={1}>
          {props.action.label}
        </Text>
      </Animated.View>
    </View>
  );
}
