import { useEffect, useId, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { hexToHsv, hsvToHex, type HsvColor } from "../../../../lib/mobileTheme";

const THUMB_SIZE = 24;
const HUE_STOPS: ReadonlyArray<{ readonly offset: number; readonly color: string }> = [
  { offset: 0, color: "#ff0000" },
  { offset: 1 / 6, color: "#ffff00" },
  { offset: 2 / 6, color: "#00ff00" },
  { offset: 3 / 6, color: "#00ffff" },
  { offset: 4 / 6, color: "#0000ff" },
  { offset: 5 / 6, color: "#ff00ff" },
  { offset: 1, color: "#ff0000" },
];

function clamp01(value: number): number {
  "worklet";
  return Math.min(1, Math.max(0, value));
}

function quantize(color: HsvColor): HsvColor {
  return {
    h: Math.round(color.h),
    s: Math.round(color.s * 100) / 100,
    v: Math.round(color.v * 100) / 100,
  };
}

/**
 * Saturation/brightness pad plus hue slider. Thumbs track on the UI thread
 * via shared values; the color is committed to React state and preferences
 * once on release, so dragging never re-renders the SVG surfaces.
 */
export function HsvColorPicker(props: {
  readonly disabled?: boolean;
  readonly value: string;
  readonly onChange: (hex: string) => void;
}) {
  const idPrefix = useId().replaceAll(":", "");
  const [hsv, setHsv] = useState<HsvColor>(
    () => hexToHsv(props.value) ?? { h: 210, s: 0.8, v: 0.9 },
  );
  const [syncedValue, setSyncedValue] = useState(props.value);

  // Adopt external changes (hex field, preset then custom) without fighting
  // our own commits, which round-trip to the same hex.
  if (props.value !== syncedValue) {
    setSyncedValue(props.value);
    const parsed = hexToHsv(props.value);
    if (parsed !== null && hsvToHex(hsv) !== props.value) setHsv(quantize(parsed));
  }

  const saturation = useSharedValue(hsv.s);
  const brightness = useSharedValue(hsv.v);
  const huePosition = useSharedValue(hsv.h / 360);
  const padWidth = useSharedValue(0);
  const padHeight = useSharedValue(0);
  const hueWidth = useSharedValue(0);

  useEffect(() => {
    saturation.value = hsv.s;
    brightness.value = hsv.v;
    huePosition.value = hsv.h / 360;
  }, [brightness, hsv, huePosition, saturation]);

  const latest = useRef({ hsv, onChange: props.onChange });
  latest.current = { hsv, onChange: props.onChange };

  const commitPad = (s: number, v: number) => {
    const next = quantize({ h: latest.current.hsv.h, s, v });
    setHsv(next);
    latest.current.onChange(hsvToHex(next));
  };
  const commitHue = (position: number) => {
    const next = quantize({ ...latest.current.hsv, h: position * 360 });
    setHsv(next);
    latest.current.onChange(hsvToHex(next));
  };
  const commitPadRef = useRef(commitPad);
  commitPadRef.current = commitPad;
  const commitHueRef = useRef(commitHue);
  commitHueRef.current = commitHue;

  const runCommitPad = useMemo(() => (s: number, v: number) => commitPadRef.current(s, v), []);
  const runCommitHue = useMemo(() => (position: number) => commitHueRef.current(position), []);

  const padGesture = useMemo(() => {
    const track = (x: number, y: number) => {
      "worklet";
      if (padWidth.value <= 0 || padHeight.value <= 0) return;
      saturation.value = clamp01(x / padWidth.value);
      brightness.value = clamp01(1 - y / padHeight.value);
    };
    // Axis-independent activation: brightness-only drags are vertical, so the
    // pad must win over the surrounding ScrollView in both directions.
    const pan = Gesture.Pan()
      .enabled(!props.disabled)
      .minDistance(6)
      .onUpdate((event) => track(event.x, event.y))
      .onEnd(() => {
        runOnJS(runCommitPad)(saturation.value, brightness.value);
      });
    const tap = Gesture.Tap()
      .enabled(!props.disabled)
      .onEnd((event) => {
        track(event.x, event.y);
        runOnJS(runCommitPad)(saturation.value, brightness.value);
      });
    return Gesture.Race(pan, tap);
  }, [brightness, padHeight, padWidth, props.disabled, runCommitPad, saturation]);

  const hueGesture = useMemo(() => {
    const track = (x: number) => {
      "worklet";
      if (hueWidth.value <= 0) return;
      huePosition.value = clamp01(x / hueWidth.value);
    };
    const pan = Gesture.Pan()
      .enabled(!props.disabled)
      .activeOffsetX([-6, 6])
      .failOffsetY([-12, 12])
      .onUpdate((event) => track(event.x))
      .onEnd(() => {
        runOnJS(runCommitHue)(huePosition.value);
      });
    const tap = Gesture.Tap()
      .enabled(!props.disabled)
      .onEnd((event) => {
        track(event.x);
        runOnJS(runCommitHue)(huePosition.value);
      });
    return Gesture.Race(pan, tap);
  }, [hueWidth, huePosition, props.disabled, runCommitHue]);

  const padThumbStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: saturation.value * padWidth.value - THUMB_SIZE / 2 },
      { translateY: (1 - brightness.value) * padHeight.value - THUMB_SIZE / 2 },
    ],
  }));
  const hueThumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: huePosition.value * hueWidth.value - THUMB_SIZE / 2 }],
  }));

  const hueColor = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  const currentColor = hsvToHex(hsv);
  const thumbStyle = {
    borderColor: "#ffffff",
    borderWidth: 2,
    height: THUMB_SIZE,
    shadowColor: "#000000",
    shadowOffset: { height: 1, width: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 2,
    width: THUMB_SIZE,
  } as const;

  return (
    <View className={props.disabled ? "gap-3 opacity-[0.45]" : "gap-3"}>
      <GestureDetector gesture={padGesture}>
        <View
          accessibilityLabel="Saturation and brightness"
          className="h-40 overflow-hidden rounded-2xl border border-border"
          onLayout={(event) => {
            padWidth.value = event.nativeEvent.layout.width;
            padHeight.value = event.nativeEvent.layout.height;
          }}
        >
          <Svg height="100%" width="100%">
            <Defs>
              <LinearGradient id={`${idPrefix}-s`} x1="0" x2="1" y1="0" y2="0">
                <Stop offset="0" stopColor="#ffffff" stopOpacity={1} />
                <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
              </LinearGradient>
              <LinearGradient id={`${idPrefix}-v`} x1="0" x2="0" y1="0" y2="1">
                <Stop offset="0" stopColor="#000000" stopOpacity={0} />
                <Stop offset="1" stopColor="#000000" stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect fill={hueColor} height="100%" width="100%" />
            <Rect fill={`url(#${idPrefix}-s)`} height="100%" width="100%" />
            <Rect fill={`url(#${idPrefix}-v)`} height="100%" width="100%" />
          </Svg>
          <Animated.View
            className="absolute left-0 top-0 rounded-full"
            pointerEvents="none"
            style={[{ ...thumbStyle, backgroundColor: currentColor }, padThumbStyle]}
          />
        </View>
      </GestureDetector>
      <GestureDetector gesture={hueGesture}>
        <View
          accessibilityLabel="Hue"
          className="h-11 justify-center"
          onLayout={(event) => {
            hueWidth.value = event.nativeEvent.layout.width;
          }}
        >
          <View className="h-3 overflow-hidden rounded-full">
            <Svg height="100%" width="100%">
              <Defs>
                <LinearGradient id={`${idPrefix}-hue`} x1="0" x2="1" y1="0" y2="0">
                  {HUE_STOPS.map((stop) => (
                    <Stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
                  ))}
                </LinearGradient>
              </Defs>
              <Rect fill={`url(#${idPrefix}-hue)`} height="100%" width="100%" />
            </Svg>
          </View>
          <Animated.View
            className="absolute left-0 rounded-full"
            pointerEvents="none"
            style={[{ ...thumbStyle, backgroundColor: hueColor }, hueThumbStyle]}
          />
        </View>
      </GestureDetector>
    </View>
  );
}
