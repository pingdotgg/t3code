import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { View, type AccessibilityActionEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { ComponentProps } from "react";

import { AppText as Text } from "../../../../components/AppText";
import { useThemeColor } from "../../../../lib/useThemeColor";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

const THUMB_SIZE = 26;
const TRACK_HEIGHT = 4;
const SNAP_ANIMATION = { duration: 120 } as const;

function clampFraction(value: number): number {
  "worklet";
  return Math.min(1, Math.max(0, value));
}

export function FontSizeSliderRow(props: {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly valueLabel: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  const icon = useThemeColor("--color-icon");
  const iconMuted = String(useThemeColor("--color-icon-muted"));
  const trackColor = String(useThemeColor("--color-secondary-border"));
  const fillColor = String(useThemeColor("--color-primary"));

  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  }, [props]);

  const { min, max, step, value, disabled } = props;
  const fraction = (value - min) / (max - min);

  const progress = useSharedValue(clampFraction(fraction));
  const trackWidth = useSharedValue(0);
  const dragging = useSharedValue(false);

  useEffect(() => {
    if (!dragging.value) {
      progress.value = withTiming(clampFraction(fraction), SNAP_ANIMATION);
    }
  }, [dragging, fraction, progress]);

  const commit = useCallback((next: number) => {
    if (next === latest.current.value) {
      return;
    }
    Haptics.selectionAsync().catch(() => undefined);
    latest.current.onChange(next);
  }, []);

  const gesture = useMemo(() => {
    const snapValue = (raw: number): number => {
      "worklet";
      const stepped = Math.round((raw - min) / step) * step + min;
      return Math.min(max, Math.max(min, stepped));
    };
    const fractionAt = (x: number): number => {
      "worklet";
      const usable = trackWidth.value - THUMB_SIZE;
      if (usable <= 0) {
        return 0;
      }
      return clampFraction((x - THUMB_SIZE / 2) / usable);
    };
    const valueAtFraction = (f: number): number => {
      "worklet";
      return snapValue(min + f * (max - min));
    };
    const fractionOfValue = (v: number): number => {
      "worklet";
      return clampFraction((v - min) / (max - min));
    };

    const pan = Gesture.Pan()
      .enabled(!disabled)
      .activeOffsetX([-8, 8])
      .failOffsetY([-12, 12])
      .onUpdate((event) => {
        dragging.value = true;
        const f = fractionAt(event.x);
        progress.value = f;
        runOnJS(commit)(valueAtFraction(f));
      })
      .onFinalize(() => {
        if (!dragging.value) {
          return;
        }
        dragging.value = false;
        progress.value = withTiming(
          fractionOfValue(valueAtFraction(progress.value)),
          SNAP_ANIMATION,
        );
      });

    const tap = Gesture.Tap()
      .enabled(!disabled)
      .onEnd((event) => {
        const next = valueAtFraction(fractionAt(event.x));
        progress.value = withTiming(fractionOfValue(next), SNAP_ANIMATION);
        runOnJS(commit)(next);
      });

    return Gesture.Race(pan, tap);
  }, [commit, disabled, dragging, max, min, progress, step, trackWidth]);

  const fillStyle = useAnimatedStyle(() => ({
    width: THUMB_SIZE / 2 + progress.value * Math.max(0, trackWidth.value - THUMB_SIZE),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * Math.max(0, trackWidth.value - THUMB_SIZE) }],
  }));

  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === "increment") {
      commit(Math.min(max, value + step));
    } else if (event.nativeEvent.actionName === "decrement") {
      commit(Math.max(min, value - step));
    }
  };

  return (
    <View className="gap-1 p-4" style={{ opacity: disabled ? 0.45 : 1 }}>
      <View className="flex-row items-center gap-4">
        <SymbolView
          name={props.icon}
          size={22}
          tintColor={icon}
          type="monochrome"
          weight="regular"
        />
        <Text className="flex-1 text-lg text-foreground">{props.label}</Text>
        <Text className="text-base font-t3-medium text-foreground-muted">{props.valueLabel}</Text>
      </View>
      <View className="flex-row items-center gap-3">
        <SymbolView
          name="textformat.size.smaller"
          size={15}
          tintColor={iconMuted}
          type="monochrome"
          weight="regular"
        />
        <GestureDetector gesture={gesture}>
          <View
            accessible
            accessibilityActions={[
              { name: "increment", label: `Increase ${props.label}` },
              { name: "decrement", label: `Decrease ${props.label}` },
            ]}
            accessibilityLabel={props.label}
            accessibilityRole="adjustable"
            accessibilityValue={{ min, max, now: value, text: props.valueLabel }}
            className="h-11 flex-1 justify-center"
            onAccessibilityAction={handleAccessibilityAction}
            onLayout={(event) => {
              trackWidth.value = event.nativeEvent.layout.width;
            }}
          >
            <View
              className="w-full rounded-full"
              style={{ backgroundColor: trackColor, height: TRACK_HEIGHT }}
            >
              <Animated.View
                className="absolute inset-y-0 left-0 rounded-full"
                style={[{ backgroundColor: fillColor }, fillStyle]}
              />
            </View>
            <Animated.View
              className="absolute left-0 rounded-full bg-white"
              style={[
                {
                  borderColor: "rgba(0, 0, 0, 0.06)",
                  borderWidth: 1,
                  height: THUMB_SIZE,
                  marginTop: -THUMB_SIZE / 2,
                  shadowColor: "#000000",
                  shadowOffset: { height: 2, width: 0 },
                  shadowOpacity: 0.18,
                  shadowRadius: 3,
                  top: "50%",
                  width: THUMB_SIZE,
                },
                thumbStyle,
              ]}
            />
          </View>
        </GestureDetector>
        <SymbolView
          name="textformat.size.larger"
          size={22}
          tintColor={iconMuted}
          type="monochrome"
          weight="regular"
        />
      </View>
    </View>
  );
}
