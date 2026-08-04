import * as Haptics from "expo-haptics";
import type { ModelSelection, ProviderOptionDescriptor } from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  View,
  type GestureResponderEvent,
} from "react-native";
import Animated, {
  Easing,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path, Rect } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { OverlayPortal } from "../../../components/OverlayPortal";
import { ProviderIcon } from "../../../components/ProviderIcon";
import type { ModelOption } from "../../../lib/modelOptions";
import { useThemeColor } from "../../../lib/useThemeColor";
import { hasDeliberateGestureTravel, takeUniquePaletteIds } from "./modelPickerPrototypeState";

type ModelChoice = {
  readonly id: string;
  readonly compactLabel?: string;
  readonly label: string;
  readonly provider: string;
  readonly selection: ModelSelection;
};

type ReasoningChoice = {
  readonly id: string;
  readonly compactLabel?: string;
  readonly intensity: number | "max";
  readonly label: string;
};

const MARKING_MENU_WIDTH = 300;
const MARKING_MENU_HEIGHT = 230;
const MARKING_MENU_INNER_RADIUS = 96;
const MARKING_MENU_OUTER_RADIUS = 144;
const MARKING_MENU_LONG_PRESS_DELAY = 150;
const MARKING_MENU_GESTURE_MIN_RADIUS = MARKING_MENU_INNER_RADIUS;
const MARKING_MENU_GESTURE_MIN_TRAVEL = 16;
const MARKING_MENU_EXIT_DURATION = 90;
const MARKING_MENU_BACKDROP_OPACITY = 0.64;
const MARKING_MENU_OPTION_OPACITY = 0.94;
const MAX_PALETTE_CHOICES = 4;
const MODEL_MENU_GEOMETRY = {
  center: { x: 90, y: 206 },
  endAngle: 360,
  startAngle: 240,
} as const;
const REASONING_MENU_GEOMETRY = {
  center: { x: MARKING_MENU_WIDTH / 2, y: 206 },
  endAngle: 345,
  startAngle: 195,
} as const;

const REASONING_OPTION_IDS = new Set(["reasoningEffort", "effort", "reasoning"]);

function compactModelLabel(label: string): string {
  const compact = label.replace(/^Claude\s+/i, "").replace(/^GPT-/i, "");
  if (compact.length <= 11) return compact;
  const words = compact.split(/\s+/);
  const tail = words.slice(-2).join(" ");
  return tail.length <= 11 ? tail : `${compact.slice(0, 10)}…`;
}

function compactReasoningLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (normalized === "medium") return "Med";
  if (normalized === "extra high" || normalized === "xhigh") return "X-high";
  if (normalized === "ultrathink") return "Ultra";
  if (label.length <= 9) return label;
  return `${label.slice(0, 8)}…`;
}

function findReasoningDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): Extract<ProviderOptionDescriptor, { type: "select" }> | null {
  const descriptor = descriptors.find(
    (candidate) =>
      candidate.type === "select" &&
      (REASONING_OPTION_IDS.has(candidate.id) || /reasoning|effort/i.test(candidate.label)),
  );
  return descriptor?.type === "select" ? descriptor : null;
}

function reasoningIntensity(value: string, index: number, total: number): number | "max" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "max") return "max";
  if (normalized === "none") return 0;
  if (normalized === "minimal" || normalized === "low") return 1;
  if (normalized === "medium") return 2;
  if (normalized === "high") return 3;
  if (normalized === "xhigh" || normalized.startsWith("ultra")) return 4;
  return Math.max(1, Math.min(4, Math.round(((index + 1) / Math.max(total, 1)) * 4)));
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function initialPaletteIds<T extends ModelChoice | ReasoningChoice>(
  choices: readonly T[],
  selectedId: string,
): ReadonlySet<string> {
  const ids = choices.map((choice) => choice.id);
  return takeUniquePaletteIds(
    ids.includes(selectedId) ? [selectedId, ...ids] : ids,
    MAX_PALETTE_CHOICES,
  );
}

function usePaletteIds<T extends ModelChoice | ReasoningChoice>(
  choices: readonly T[],
  selectedId: string,
) {
  const [enabledIds, setEnabledIds] = useState<ReadonlySet<string>>(() =>
    initialPaletteIds(choices, selectedId),
  );

  useEffect(() => {
    setEnabledIds((current) => {
      const availableIds = new Set(choices.map((choice) => choice.id));
      const candidates = [selectedId, ...current, ...availableIds];
      const next = takeUniquePaletteIds(
        candidates.filter((id) => availableIds.has(id)),
        MAX_PALETTE_CHOICES,
      );
      return setsEqual(current, next) ? current : next;
    });
  }, [choices, selectedId]);

  return [enabledIds, setEnabledIds] as const;
}

function polarPoint(center: { x: number; y: number }, radius: number, angle: number) {
  const radians = (angle * Math.PI) / 180;
  return {
    x: center.x + radius * Math.cos(radians),
    y: center.y + radius * Math.sin(radians),
  };
}

function ringSectorPath(
  center: { x: number; y: number },
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number,
) {
  const outerStart = polarPoint(center, outerRadius, startAngle);
  const outerEnd = polarPoint(center, outerRadius, endAngle);
  const innerEnd = polarPoint(center, innerRadius, endAngle);
  const innerStart = polarPoint(center, innerRadius, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

function useMarkingMenuMotion(open: boolean, center: { readonly x: number; readonly y: number }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(open ? 1 : 0, {
      duration: open ? 120 : 90,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    });
  }, [open, progress]);

  return useAnimatedStyle(() => {
    const scale = interpolate(progress.value, [0, 1], [0.82, 1]);
    return {
      opacity: progress.value,
      transform: [
        { translateX: center.x },
        { translateY: center.y },
        { scale },
        { translateX: -center.x },
        { translateY: -center.y },
      ],
    };
  });
}

function ReasoningIntensityIcon(props: {
  readonly choice: ReasoningChoice;
  readonly color: string;
  readonly size: number;
}) {
  const intensity = props.choice.intensity;
  if (intensity === "max") {
    return (
      <Svg height={props.size} viewBox="0 0 18 18" width={props.size}>
        <Path
          d="M 1.5 9 C 3.5 4.8 6.3 4.8 9 9 C 11.7 13.2 14.5 13.2 16.5 9 C 14.5 4.8 11.7 4.8 9 9 C 6.3 13.2 3.5 13.2 1.5 9"
          fill="none"
          stroke={props.color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </Svg>
    );
  }

  const heights = [5, 8, 11, 14] as const;
  return (
    <Svg height={props.size} viewBox="0 0 18 18" width={props.size}>
      {heights.map((height, index) => {
        const active = index < intensity;
        return (
          <Rect
            key={height}
            fill={props.color}
            height={height}
            opacity={active ? 1 : 0.2}
            rx={1.25}
            width={2.75}
            x={1 + index * 4.25}
            y={16 - height}
          />
        );
      })}
    </Svg>
  );
}

function PickerIcon(props: {
  readonly choice: ModelChoice | ReasoningChoice;
  readonly color: string;
  readonly size?: number;
  readonly tintProvider?: boolean;
}) {
  if ("provider" in props.choice) {
    return (
      <ProviderIcon
        experimentalProviderIcons
        provider={props.choice.provider}
        size={props.size ?? 22}
        tintColor={props.tintProvider ? props.color : undefined}
      />
    );
  }
  return (
    <ReasoningIntensityIcon choice={props.choice} color={props.color} size={props.size ?? 20} />
  );
}

type MarkingItem<T extends ModelChoice | ReasoningChoice> =
  | {
      readonly id: T["id"];
      readonly kind: "choice";
      readonly choice: T;
    }
  | { readonly id: "edit"; readonly kind: "edit"; readonly label: "Edit" };

function PickerSheet(props: {
  readonly children: ReactNode;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      animationType="fade"
      onRequestClose={props.onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={props.visible}
    >
      <View className="flex-1 justify-end bg-black/35">
        <Pressable
          accessibilityLabel={props.closeLabel}
          className="absolute inset-0"
          onPress={props.onClose}
        />
        <View
          className="gap-4 rounded-t-[28px] bg-sheet px-5 pt-5"
          style={{ paddingBottom: Math.max(insets.bottom, 18) }}
        >
          {props.children}
        </View>
      </View>
    </Modal>
  );
}

function PaletteEditor<T extends ModelChoice | ReasoningChoice>(props: {
  readonly choices: readonly T[];
  readonly enabledIds: ReadonlySet<T["id"]>;
  readonly lockedId: T["id"];
  readonly name: "model" | "reasoning";
  readonly onClose: () => void;
  readonly onToggle: (choice: T) => void;
  readonly visible: boolean;
}) {
  const foreground = String(useThemeColor("--color-foreground"));
  return (
    <PickerSheet
      closeLabel={`Close ${props.name} palette editor`}
      onClose={props.onClose}
      visible={props.visible}
    >
      <View className="flex-row items-center justify-between gap-4">
        <View>
          <Text className="text-xl font-t3-bold text-foreground">Edit {props.name} palette</Text>
          <Text className="text-sm text-foreground-muted">Keep two to four options.</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          className="h-10 justify-center rounded-full bg-primary px-4"
          onPress={props.onClose}
        >
          <Text className="text-sm font-t3-bold text-primary-foreground">Done</Text>
        </Pressable>
      </View>
      <ScrollView className="overflow-hidden rounded-[20px] bg-subtle" style={{ maxHeight: 420 }}>
        {props.choices.map((choice, index) => {
          const enabled = props.enabledIds.has(choice.id);
          const disabled =
            (enabled && (props.enabledIds.size <= 2 || choice.id === props.lockedId)) ||
            (!enabled && props.enabledIds.size >= MAX_PALETTE_CHOICES);
          return (
            <Pressable
              key={choice.id}
              accessibilityLabel={choice.label}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: enabled, disabled }}
              className="min-h-14 flex-row items-center gap-3 px-4"
              disabled={disabled}
              onPress={() => props.onToggle(choice)}
              style={{
                borderTopColor: "rgba(127,127,127,0.14)",
                borderTopWidth: index === 0 ? 0 : 1,
                opacity: disabled ? 0.5 : 1,
              }}
            >
              <PickerIcon choice={choice} color={foreground} size={20} />
              <Text className="min-w-0 flex-1 text-base font-t3-bold text-foreground">
                {choice.label}
              </Text>
              {enabled ? (
                <SymbolView
                  name="checkmark"
                  size={15}
                  tintColor={foreground}
                  type="monochrome"
                  weight="bold"
                />
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </PickerSheet>
  );
}

function PickerFallbackSheet<T extends ModelChoice | ReasoningChoice>(props: {
  readonly choices: readonly T[];
  readonly name: "model" | "reasoning";
  readonly onClose: () => void;
  readonly onEditPalette: () => void;
  readonly onSelect: (choice: T) => void;
  readonly selectedId: string;
  readonly visible: boolean;
}) {
  const foreground = String(useThemeColor("--color-foreground"));
  return (
    <PickerSheet
      closeLabel={`Close ${props.name} picker`}
      onClose={props.onClose}
      visible={props.visible}
    >
      <Text className="text-xl font-t3-bold text-foreground">Choose {props.name}</Text>
      <View className="overflow-hidden rounded-[20px] bg-subtle">
        {props.choices.map((choice, index) => {
          const selected = choice.id === props.selectedId;
          return (
            <Pressable
              key={choice.id}
              accessibilityLabel={choice.label}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              className="min-h-14 flex-row items-center gap-3 px-4"
              onPress={() => {
                props.onSelect(choice);
                props.onClose();
              }}
              style={{
                borderTopColor: "rgba(127,127,127,0.14)",
                borderTopWidth: index === 0 ? 0 : 1,
              }}
            >
              <PickerIcon choice={choice} color={foreground} size={20} />
              <Text className="min-w-0 flex-1 text-base font-t3-bold text-foreground">
                {choice.label}
              </Text>
              {selected ? (
                <SymbolView
                  name="checkmark"
                  size={15}
                  tintColor={foreground}
                  type="monochrome"
                  weight="bold"
                />
              ) : null}
            </Pressable>
          );
        })}
        <Pressable
          accessibilityRole="button"
          className="min-h-14 flex-row items-center gap-3 border-t border-border px-4"
          onPress={() => {
            props.onClose();
            requestAnimationFrame(props.onEditPalette);
          }}
        >
          <SymbolView
            name="square.and.pencil"
            size={19}
            tintColor={foreground}
            type="monochrome"
            weight="semibold"
          />
          <Text className="text-base font-t3-bold text-foreground">Edit palette</Text>
        </Pressable>
      </View>
    </PickerSheet>
  );
}
function MarkingMenu<T extends ModelChoice | ReasoningChoice>(props: {
  readonly choices: readonly T[];
  readonly placement: "center" | "corner";
  readonly selectedChoice: T;
  readonly onEditPalette: () => void;
  readonly onGestureActiveChange?: (active: boolean) => void;
  readonly onMenuOpenChange?: (open: boolean) => void;
  readonly onSelect: (choice: T) => void;
}) {
  const primary = String(useThemeColor("--color-primary"));
  const primaryForeground = String(useThemeColor("--color-primary-foreground"));
  const foreground = String(useThemeColor("--color-foreground"));
  const card = String(useThemeColor("--color-sheet"));
  const subtleStrong = String(useThemeColor("--color-subtle-strong"));
  const chevron = String(useThemeColor("--color-icon"));
  const triggerRef = useRef<View>(null);
  const gestureOriginRef = useRef<{ x: number; y: number } | null>(null);
  const gestureStartRef = useRef<{ x: number; y: number } | null>(null);
  const gestureHasTravelledRef = useRef(false);
  const menuOpenRef = useRef(false);
  const gestureConsumedRef = useRef(false);
  const highlightedIndexRef = useRef<number | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureActiveChangeRef = useRef(props.onGestureActiveChange);
  const menuOpenChangeRef = useRef(props.onMenuOpenChange);
  gestureActiveChangeRef.current = props.onGestureActiveChange;
  menuOpenChangeRef.current = props.onMenuOpenChange;
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [overlayMounted, setOverlayMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const geometry = props.placement === "center" ? REASONING_MENU_GEOMETRY : MODEL_MENU_GEOMETRY;
  const motionStyle = useMarkingMenuMotion(open, geometry.center);
  const items = useMemo<readonly MarkingItem<T>[]>(
    () => [
      ...props.choices.map(
        (choice): MarkingItem<T> => ({
          id: choice.id,
          kind: "choice",
          choice,
        }),
      ),
      { id: "edit", kind: "edit", label: "Edit" },
    ],
    [props.choices],
  );
  const sweep = geometry.endAngle - geometry.startAngle;
  const segmentAngle = sweep / items.length;
  const optionBox = props.placement === "corner" ? 48 : 54;
  const readoutItem =
    highlightedIndex === null
      ? items.find((item) => item.kind === "choice" && item.id === props.selectedChoice.id)
      : items[highlightedIndex];
  const readoutLabel =
    readoutItem?.kind === "choice"
      ? (readoutItem.choice.compactLabel ?? readoutItem.choice.label)
      : "Edit palette";

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      gestureActiveChangeRef.current?.(false);
      menuOpenChangeRef.current?.(false);
    },
    [],
  );

  const openMenu = () => {
    if (menuOpenRef.current) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    gestureConsumedRef.current = true;
    menuOpenRef.current = true;
    setOverlayMounted(true);
    setOpen(true);
    props.onMenuOpenChange?.(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const updateHighlight = (event: GestureResponderEvent) => {
    if (!menuOpenRef.current) return;
    const origin = gestureOriginRef.current;
    if (!origin) return;
    const dx = event.nativeEvent.pageX - origin.x;
    const dy = event.nativeEvent.pageY - origin.y;
    const radius = Math.hypot(dx, dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const normalizedAngle = angle <= 0 ? angle + 360 : angle;
    const insideRadius = radius >= MARKING_MENU_GESTURE_MIN_RADIUS;
    const insideAngle =
      normalizedAngle >= geometry.startAngle && normalizedAngle <= geometry.endAngle;
    const nextIndex =
      insideRadius && insideAngle
        ? Math.min(
            items.length - 1,
            Math.floor((normalizedAngle - geometry.startAngle) / segmentAngle),
          )
        : null;
    if (nextIndex === highlightedIndexRef.current) return;
    highlightedIndexRef.current = nextIndex;
    setHighlightedIndex(nextIndex);
    if (nextIndex !== null) void Haptics.selectionAsync();
  };

  const handlePressMove = (event: GestureResponderEvent) => {
    const current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
    if (
      !hasDeliberateGestureTravel(gestureStartRef.current, current, MARKING_MENU_GESTURE_MIN_TRAVEL)
    ) {
      return;
    }
    gestureHasTravelledRef.current = true;
    if (!menuOpenRef.current) {
      openMenu();
    }
    updateHighlight(event);
  };

  const closeMenu = () => {
    menuOpenRef.current = false;
    highlightedIndexRef.current = null;
    setHighlightedIndex(null);
    setOpen(false);
    props.onMenuOpenChange?.(false);
    closeTimerRef.current = setTimeout(() => {
      setOverlayMounted(false);
      closeTimerRef.current = null;
    }, MARKING_MENU_EXIT_DURATION);
  };

  const commitGesture = (event: GestureResponderEvent) => {
    props.onGestureActiveChange?.(false);
    if (!menuOpenRef.current) return;
    if (!gestureHasTravelledRef.current) {
      closeMenu();
      return;
    }
    updateHighlight(event);
    const committedIndex = highlightedIndexRef.current;
    const item = committedIndex === null ? null : items[committedIndex];
    closeMenu();
    if (!item) return;
    if (item.kind === "edit") {
      Keyboard.dismiss();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      requestAnimationFrame(props.onEditPalette);
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    props.onSelect(item.choice);
  };

  return (
    <View ref={triggerRef} collapsable={false} className="relative">
      {overlayMounted ? (
        <OverlayPortal>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            style={{
              height: MARKING_MENU_HEIGHT,
              left: (anchor?.x ?? 0) - geometry.center.x,
              position: "absolute",
              top: (anchor?.y ?? 0) - geometry.center.y,
              width: MARKING_MENU_WIDTH,
            }}
          >
            <Animated.View
              style={[{ height: MARKING_MENU_HEIGHT, width: MARKING_MENU_WIDTH }, motionStyle]}
            >
              <Svg
                height={MARKING_MENU_HEIGHT}
                pointerEvents="none"
                width={MARKING_MENU_WIDTH}
                style={{ position: "absolute" }}
              >
                <Path
                  d={ringSectorPath(
                    geometry.center,
                    1,
                    150,
                    geometry.startAngle,
                    geometry.endAngle,
                  )}
                  fill={card}
                  fillOpacity={MARKING_MENU_BACKDROP_OPACITY}
                />
                {items.map((item, index) => {
                  const gap = 2;
                  const start = geometry.startAngle + index * segmentAngle + gap;
                  const end = geometry.startAngle + (index + 1) * segmentAngle - gap;
                  const highlighted = highlightedIndex === index;
                  const selected = item.kind === "choice" && item.id === props.selectedChoice.id;
                  return (
                    <Path
                      key={item.id}
                      d={ringSectorPath(
                        geometry.center,
                        MARKING_MENU_INNER_RADIUS,
                        highlighted ? 150 : MARKING_MENU_OUTER_RADIUS,
                        start,
                        end,
                      )}
                      fill={highlighted ? primary : selected ? subtleStrong : card}
                      fillOpacity={highlighted ? 0.96 : MARKING_MENU_OPTION_OPACITY}
                      stroke={highlighted || selected ? primary : foreground}
                      strokeOpacity={highlighted || selected ? 0.9 : 0.2}
                      strokeWidth={highlighted || selected ? 2 : 1.25}
                    />
                  );
                })}
              </Svg>
              {items.map((item, index) => {
                const angle = geometry.startAngle + (index + 0.5) * segmentAngle;
                const point = polarPoint(geometry.center, 120, angle);
                const highlighted = highlightedIndex === index;
                return (
                  <View
                    key={item.id}
                    className="absolute items-center justify-center"
                    style={{
                      height: optionBox,
                      left: point.x - optionBox / 2,
                      top: point.y - optionBox / 2,
                      width: optionBox,
                    }}
                  >
                    {item.kind === "edit" ? (
                      <SymbolView
                        name="square.and.pencil"
                        size={props.placement === "corner" ? 18 : 19}
                        tintColor={highlighted ? primaryForeground : foreground}
                        type="monochrome"
                        weight="semibold"
                      />
                    ) : (
                      <PickerIcon
                        choice={item.choice}
                        color={highlighted ? primaryForeground : foreground}
                        size={props.placement === "corner" ? 18 : 19}
                        tintProvider={highlighted}
                      />
                    )}
                    {item.kind === "choice" ? (
                      <Text
                        className={
                          highlighted
                            ? "mt-0.5 text-[10px] font-t3-bold text-primary-foreground"
                            : "mt-0.5 text-[10px] font-t3-bold text-foreground"
                        }
                        numberOfLines={1}
                      >
                        {item.choice.compactLabel ?? item.choice.label}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
              <View
                className="absolute items-center rounded-full border border-border bg-sheet px-3 py-1.5"
                style={{
                  left: geometry.center.x - 54,
                  overflow: "hidden",
                  top: geometry.center.y - 74,
                  width: 108,
                }}
              >
                <Text className="text-[11px] font-t3-bold text-foreground" numberOfLines={1}>
                  {readoutLabel}
                </Text>
              </View>
            </Animated.View>
          </View>
        </OverlayPortal>
      ) : null}
      <Pressable
        accessibilityHint="Hold, slide to an option, then release to select"
        accessibilityLabel={`${props.placement === "corner" ? "Model" : "Reasoning"}: ${props.selectedChoice.label}`}
        accessibilityRole="button"
        cancelable={false}
        delayLongPress={MARKING_MENU_LONG_PRESS_DELAY}
        onLongPress={openMenu}
        onPress={() => {
          if (gestureConsumedRef.current) {
            gestureConsumedRef.current = false;
            return;
          }
          Keyboard.dismiss();
          setFallbackOpen(true);
        }}
        onPressIn={(event) => {
          props.onGestureActiveChange?.(true);
          gestureConsumedRef.current = false;
          gestureHasTravelledRef.current = false;
          highlightedIndexRef.current = null;
          setHighlightedIndex(null);
          const touchDown = {
            x: event.nativeEvent.pageX,
            y: event.nativeEvent.pageY,
          };
          gestureStartRef.current = touchDown;
          gestureOriginRef.current = touchDown;
          setAnchor(touchDown);
          triggerRef.current?.measureInWindow((x, y, width, height) => {
            const measuredAnchor = { x: x + width / 2, y: y + height / 2 };
            gestureOriginRef.current = measuredAnchor;
            setAnchor(measuredAnchor);
          });
        }}
        onPressMove={handlePressMove}
        onPressOut={commitGesture}
        pressRetentionOffset={320}
        className={
          open
            ? "h-11 flex-row items-center gap-2 rounded-full bg-subtle-strong px-3.5"
            : "h-11 flex-row items-center gap-2 rounded-full bg-subtle px-3.5"
        }
        style={({ pressed }) => ({
          borderColor: "rgba(127,127,127,0.14)",
          borderWidth: 1,
          opacity: pressed ? 0.82 : 1,
          transform: [{ scale: pressed ? 0.96 : 1 }],
        })}
      >
        <PickerIcon choice={props.selectedChoice} color={foreground} size={16} />
        <Text className="text-sm font-t3-bold text-foreground">{props.selectedChoice.label}</Text>
        <SymbolView
          name="chevron.up"
          size={11}
          tintColor={chevron}
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
      <PickerFallbackSheet
        choices={props.choices}
        name={props.placement === "corner" ? "model" : "reasoning"}
        onClose={() => setFallbackOpen(false)}
        onEditPalette={props.onEditPalette}
        onSelect={props.onSelect}
        selectedId={props.selectedChoice.id}
        visible={fallbackOpen}
      />
    </View>
  );
}

function MarkingMenuToolbar(props: {
  readonly modelChoices: readonly ModelChoice[];
  readonly reasoningChoices: readonly ReasoningChoice[];
  readonly model: ModelChoice;
  readonly reasoning: ReasoningChoice | null;
  readonly onGestureActiveChange?: (active: boolean) => void;
  readonly onMenuOpenChange?: (open: boolean) => void;
  readonly onSelectModel: (choice: ModelChoice) => void;
  readonly onSelectReasoning: (choice: ReasoningChoice) => void;
}) {
  const [paletteEditor, setPaletteEditor] = useState<"model" | "reasoning" | null>(null);
  const [enabledModelIds, setEnabledModelIds] = usePaletteIds(props.modelChoices, props.model.id);
  const [enabledReasoningIds, setEnabledReasoningIds] = usePaletteIds(
    props.reasoningChoices,
    props.reasoning?.id ?? props.reasoningChoices[0]?.id ?? "",
  );
  const paletteModels = useMemo(
    () => props.modelChoices.filter((model) => enabledModelIds.has(model.id)),
    [enabledModelIds, props.modelChoices],
  );
  const paletteReasoning = useMemo(
    () => props.reasoningChoices.filter((choice) => enabledReasoningIds.has(choice.id)),
    [enabledReasoningIds, props.reasoningChoices],
  );

  return (
    <View className="relative z-20 flex-row items-center gap-2">
      <MarkingMenu
        choices={paletteModels}
        placement="corner"
        selectedChoice={props.model}
        onEditPalette={() => setPaletteEditor("model")}
        onGestureActiveChange={props.onGestureActiveChange}
        onMenuOpenChange={props.onMenuOpenChange}
        onSelect={props.onSelectModel}
      />
      {props.reasoning && paletteReasoning.length > 0 ? (
        <MarkingMenu
          choices={paletteReasoning}
          placement="center"
          selectedChoice={props.reasoning}
          onEditPalette={() => setPaletteEditor("reasoning")}
          onGestureActiveChange={props.onGestureActiveChange}
          onMenuOpenChange={props.onMenuOpenChange}
          onSelect={props.onSelectReasoning}
        />
      ) : null}
      <PaletteEditor
        choices={props.modelChoices}
        enabledIds={enabledModelIds}
        lockedId={props.model.id}
        name="model"
        visible={paletteEditor === "model"}
        onClose={() => setPaletteEditor(null)}
        onToggle={(model) => {
          setEnabledModelIds((current) => {
            const next = new Set(current);
            if (next.has(model.id)) next.delete(model.id);
            else next.add(model.id);
            return next;
          });
        }}
      />
      {props.reasoning ? (
        <PaletteEditor
          choices={props.reasoningChoices}
          enabledIds={enabledReasoningIds}
          lockedId={props.reasoning.id}
          name="reasoning"
          visible={paletteEditor === "reasoning"}
          onClose={() => setPaletteEditor(null)}
          onToggle={(choice) => {
            setEnabledReasoningIds((current) => {
              const next = new Set(current);
              if (next.has(choice.id)) next.delete(choice.id);
              else next.add(choice.id);
              return next;
            });
          }}
        />
      ) : null}
    </View>
  );
}

export function ModelPickerPrototypeToolbar(props: {
  readonly currentModelSelection: ModelSelection;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly onGestureActiveChange?: (active: boolean) => void;
  readonly onMenuOpenChange?: (open: boolean) => void;
  readonly onUpdateModelSelection: (selection: ModelSelection) => void;
  readonly providerOptionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
}) {
  const runtimeModels = useMemo<readonly ModelChoice[]>(
    () =>
      props.modelOptions.map((option) => ({
        id: option.key,
        compactLabel: compactModelLabel(option.label),
        label: option.label,
        provider: option.providerDriver,
        selection: option.selection,
      })),
    [props.modelOptions],
  );
  const runtimeModel =
    runtimeModels.find(
      (choice) =>
        choice.selection.instanceId === props.currentModelSelection.instanceId &&
        choice.selection.model === props.currentModelSelection.model,
    ) ?? runtimeModels[0];
  const reasoningDescriptor = useMemo(
    () => findReasoningDescriptor(props.providerOptionDescriptors),
    [props.providerOptionDescriptors],
  );
  const runtimeReasoningChoices = useMemo<readonly ReasoningChoice[]>(
    () =>
      reasoningDescriptor?.options.map((option, index, options) => ({
        id: option.id,
        compactLabel: compactReasoningLabel(option.label),
        intensity: reasoningIntensity(option.id, index, options.length),
        label: option.label,
      })) ?? [],
    [reasoningDescriptor],
  );
  const currentReasoningValue = reasoningDescriptor
    ? getProviderOptionCurrentValue(reasoningDescriptor)
    : undefined;
  const runtimeReasoning = reasoningDescriptor
    ? (runtimeReasoningChoices.find((choice) => choice.id === currentReasoningValue) ??
      runtimeReasoningChoices[0] ??
      null)
    : null;

  if (!runtimeModel) return null;

  return (
    <MarkingMenuToolbar
      modelChoices={runtimeModels}
      reasoningChoices={runtimeReasoningChoices}
      model={runtimeModel}
      reasoning={runtimeReasoning}
      onGestureActiveChange={props.onGestureActiveChange}
      onMenuOpenChange={props.onMenuOpenChange}
      onSelectModel={(choice) => {
        props.onUpdateModelSelection(choice.selection);
      }}
      onSelectReasoning={(choice) => {
        if (!reasoningDescriptor) return;
        const nextDescriptors = props.providerOptionDescriptors.map((descriptor) =>
          descriptor.id === reasoningDescriptor.id && descriptor.type === "select"
            ? { ...descriptor, currentValue: choice.id }
            : descriptor,
        );
        const options = buildProviderOptionSelectionsFromDescriptors(nextDescriptors);
        props.onUpdateModelSelection(
          options
            ? { ...props.currentModelSelection, options }
            : {
                instanceId: props.currentModelSelection.instanceId,
                model: props.currentModelSelection.model,
              },
        );
      }}
    />
  );
}
