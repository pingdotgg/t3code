import { useGT } from "gt-react-native";
import * as Haptics from "expo-haptics";
import { useEffectEvent, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { Gesture, type LegacyComposedGesture } from "react-native-gesture-handler";
import Animated, {
  FadeIn,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { cn } from "../lib/cn";
import type { ModelOption } from "../lib/modelOptions";
import { FAVORITE_FAN_TARGET_SIZE, hitFavoriteFan, layoutFavoriteFan } from "./modelFavoriteFan";
import { ProviderIcon } from "./ProviderIcon";
import { AppText as Text } from "./ui/AppText";
import { OverlayPortal } from "./ui/OverlayPortal";

const HOLD_MS = 340;
const ENTER = FadeIn.duration(140).reduceMotion(ReduceMotion.System);
const MOTION = { duration: 150, reduceMotion: ReduceMotion.System } as const;
type Point = { readonly x: number; readonly y: number };
type FanLayout = ReturnType<typeof layoutFavoriteFan>;
type Fan = { readonly origin: Point; readonly models: ReadonlyArray<ModelOption> };

export function ComposerFavoriteFan(props: {
  readonly models: ReadonlyArray<ModelOption>;
  readonly onSelect: (model: ModelOption) => void;
  readonly onPress: () => void;
  readonly children: (gesture: LegacyComposedGesture | undefined) => ReactNode;
}) {
  const [fan, setFan] = useState<Fan | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const session = useRef<Fan | null>(null);
  const origin = useSharedValue<Point>({ x: 0, y: 0 });
  const targets = useSharedValue<readonly Point[]>([]);
  const releasePoint = useSharedValue<Point | null>(null);
  const hoveredIndex = useSharedValue(-1);
  const open = useEffectEvent((x: number, y: number) => {
    const next = { origin: { x, y }, models: props.models };
    session.current = next;
    setActiveIndex(-1);
    setFan(next);
    void Haptics.selectionAsync();
  });
  const highlight = useEffectEvent((index: number) => {
    setActiveIndex(index);
    if (index >= 0) void Haptics.selectionAsync();
  });
  const finish = useEffectEvent((index: number) => {
    const key = session.current?.models[index]?.key;
    session.current = null;
    setFan(null);
    // The provider catalog can change while the finger is down.
    const model = props.models.find((candidate) => candidate.key === key);
    if (model) props.onSelect(model);
  });
  const tap = useEffectEvent(() => props.onPress());
  const [gesture] = useState(() =>
    Gesture.Race(
      Gesture.Pan()
        // Suppress normal distance activation before the hold timer.
        .minDistance(12)
        .maxPointers(1)
        .activateAfterLongPress(HOLD_MS)
        .shouldCancelWhenOutside(false)
        .onStart(({ absoluteX, absoluteY }) => {
          origin.set({ x: absoluteX, y: absoluteY });
          targets.set([]);
          releasePoint.set(null);
          hoveredIndex.set(-1);
          runOnJS(open)(absoluteX, absoluteY);
        })
        .onUpdate(({ absoluteX, absoluteY }) => {
          const index = hitFavoriteFan(targets.get(), origin.get(), absoluteX, absoluteY);
          if (index !== hoveredIndex.get()) {
            hoveredIndex.set(index);
            runOnJS(highlight)(index);
          }
        })
        .onTouchesUp(({ changedTouches }) => {
          const touch = changedTouches[0];
          if (touch) releasePoint.set({ x: touch.absoluteX, y: touch.absoluteY });
        })
        .onFinalize((event, success) => {
          const point = releasePoint.get();
          const index = success
            ? hitFavoriteFan(
                targets.get(),
                origin.get(),
                point?.x ?? event.absoluteX,
                point?.y ?? event.absoluteY,
              )
            : -1;
          targets.set([]);
          runOnJS(finish)(index);
        }),
      Gesture.Tap()
        .maxDistance(10)
        .maxDuration(HOLD_MS)
        .onEnd((_event, success) => {
          if (success) runOnJS(tap)();
        }),
    ),
  );

  return (
    <>
      {props.children(props.models.length > 0 || fan ? gesture : undefined)}
      {fan ? (
        <OverlayPortal>
          <FanWindow
            fan={fan}
            activeIndex={activeIndex}
            onLayoutTargets={(points) => {
              if (session.current === fan) targets.set(points);
            }}
          />
        </OverlayPortal>
      ) : null}
    </>
  );
}

function FanWindow(props: {
  readonly fan: Fan;
  readonly activeIndex: number;
  readonly onLayoutTargets: (targets: readonly Point[]) => void;
}) {
  const insets = useSafeAreaInsets();
  const overlay = useRef<ComponentRef<typeof View>>(null);
  const [position, setPosition] = useState<{ layout: FanLayout; offset: Point } | null>(null);
  const { fan } = props;

  const overlayView = (
    <View
      ref={overlay}
      collapsable={false}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-0"
      onLayout={() => {
        overlay.current?.measureInWindow((x, y, width) => {
          if (width === 0) return;
          const layout = layoutFavoriteFan(
            fan.origin,
            { left: x + insets.left, right: x + width - insets.right, top: y + insets.top },
            fan.models.length,
          );
          setPosition({ layout, offset: { x, y } });
          props.onLayoutTargets(layout.targets);
        });
      }}
    >
      <Animated.View entering={ENTER} className="absolute inset-0 bg-black/40" />
      {position ? <FanContent {...props} position={position} /> : null}
    </View>
  );

  return Platform.OS === "ios" ? (
    <FullWindowOverlay unstable_accessibilityContainerViewIsModal={false}>
      {overlayView}
    </FullWindowOverlay>
  ) : (
    overlayView
  );
}

function FanContent(props: {
  readonly fan: Fan;
  readonly activeIndex: number;
  readonly position: { readonly layout: FanLayout; readonly offset: Point };
}) {
  const gt = useGT();
  const { layout, offset } = props.position;
  const progress = useSharedValue(0);
  const revealed = useRef(false);
  const active = props.fan.models[props.activeIndex];
  return (
    <View
      className="absolute inset-0"
      onLayout={() => {
        if (revealed.current) return;
        revealed.current = true;
        progress.set(withTiming(1, MOTION));
      }}
    >
      <Animated.View
        entering={ENTER}
        className="absolute items-center justify-center rounded-2xl border border-border bg-card px-3 py-2"
        style={{
          left: layout.labelLeft - offset.x,
          width: layout.labelWidth,
          top: layout.labelBottom - offset.y - 46,
          minHeight: 46,
        }}
      >
        <Text className="text-center text-sm font-t3-semibold text-foreground" numberOfLines={1}>
          {active?.label ?? gt("Slide to a favorite")}
        </Text>
        {active ? (
          <Text className="text-center text-xs text-foreground-muted" numberOfLines={1}>
            {active.providerBadge?.displayName ?? active.providerLabel}
          </Text>
        ) : null}
      </Animated.View>
      {props.fan.models.map((model, index) => {
        const target = layout.targets[index]!;
        return (
          <FanTarget
            key={model.key}
            model={model}
            active={index === props.activeIndex}
            origin={props.fan.origin}
            target={target}
            offset={offset}
            progress={progress}
          />
        );
      })}
    </View>
  );
}

function FanTarget(props: {
  readonly model: ModelOption;
  readonly active: boolean;
  readonly origin: Point;
  readonly target: Point;
  readonly offset: Point;
  readonly progress: SharedValue<number>;
}) {
  const { active, origin, target, offset, progress } = props;
  const lift = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [
      { translateX: (origin.x - target.x) * (1 - progress.get()) },
      { translateY: (origin.y - target.y) * (1 - progress.get()) },
      { scale: withTiming(active ? 1.13 : 1, MOTION) },
    ],
  }));

  return (
    <Animated.View
      className={cn(
        "absolute items-center justify-center gap-0.5 rounded-full border bg-card",
        active ? "border-primary bg-subtle-strong" : "border-border",
      )}
      style={[
        {
          left: target.x - offset.x - FAVORITE_FAN_TARGET_SIZE / 2,
          top: target.y - offset.y - FAVORITE_FAN_TARGET_SIZE / 2,
          width: FAVORITE_FAN_TARGET_SIZE,
          height: FAVORITE_FAN_TARGET_SIZE,
        },
        lift,
      ]}
    >
      <ProviderIcon
        iconUrl={props.model.providerIconUrl}
        provider={props.model.providerDriver}
        size={19}
      />
      <Text
        className="max-w-[44px] text-center text-[9px] font-t3-medium text-foreground"
        numberOfLines={1}
      >
        {props.model.shortName ?? props.model.label}
      </Text>
    </Animated.View>
  );
}
