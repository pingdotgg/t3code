import { useId, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
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
 * Saturation/brightness pad plus hue slider. The thumb tracks while dragging;
 * the color is committed once on release so a drag writes preferences once.
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
  const [padSize, setPadSize] = useState({ height: 0, width: 0 });
  const [hueWidth, setHueWidth] = useState(0);

  // Adopt external changes (hex field, preset then custom) without fighting
  // our own commits, which round-trip to the same hex.
  if (props.value !== syncedValue) {
    setSyncedValue(props.value);
    const parsed = hexToHsv(props.value);
    if (parsed !== null && hsvToHex(hsv) !== props.value) setHsv(quantize(parsed));
  }

  const latest = useRef({ hsv, hueWidth, onChange: props.onChange, padSize });
  latest.current = { hsv, hueWidth, onChange: props.onChange, padSize };

  const padGesture = useMemo(() => {
    const apply = (x: number, y: number, commit: boolean) => {
      const { padSize: size, hsv: current, onChange } = latest.current;
      if (size.width <= 0 || size.height <= 0) return;
      const next = quantize({
        h: current.h,
        s: clamp01(x / size.width),
        v: clamp01(1 - y / size.height),
      });
      setHsv(next);
      if (commit) onChange(hsvToHex(next));
    };
    const pan = Gesture.Pan()
      .enabled(!props.disabled)
      .runOnJS(true)
      .activeOffsetX([-6, 6])
      .onUpdate((event) => apply(event.x, event.y, false))
      .onEnd((event) => apply(event.x, event.y, true));
    const tap = Gesture.Tap()
      .enabled(!props.disabled)
      .runOnJS(true)
      .onEnd((event) => apply(event.x, event.y, true));
    return Gesture.Race(pan, tap);
  }, [props.disabled]);

  const hueGesture = useMemo(() => {
    const apply = (x: number, commit: boolean) => {
      const { hueWidth: width, hsv: current, onChange } = latest.current;
      if (width <= 0) return;
      const next = quantize({ ...current, h: clamp01(x / width) * 360 });
      setHsv(next);
      if (commit) onChange(hsvToHex(next));
    };
    const pan = Gesture.Pan()
      .enabled(!props.disabled)
      .runOnJS(true)
      .activeOffsetX([-6, 6])
      .failOffsetY([-12, 12])
      .onUpdate((event) => apply(event.x, false))
      .onEnd((event) => apply(event.x, true));
    const tap = Gesture.Tap()
      .enabled(!props.disabled)
      .runOnJS(true)
      .onEnd((event) => apply(event.x, true));
    return Gesture.Race(pan, tap);
  }, [props.disabled]);

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
            const { height, width } = event.nativeEvent.layout;
            setPadSize({ height, width });
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
          <View
            className="absolute rounded-full"
            pointerEvents="none"
            style={{
              ...thumbStyle,
              backgroundColor: currentColor,
              left: hsv.s * padSize.width - THUMB_SIZE / 2,
              top: (1 - hsv.v) * padSize.height - THUMB_SIZE / 2,
            }}
          />
        </View>
      </GestureDetector>
      <GestureDetector gesture={hueGesture}>
        <View
          accessibilityLabel="Hue"
          className="h-11 justify-center"
          onLayout={(event) => setHueWidth(event.nativeEvent.layout.width)}
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
          <View
            className="absolute rounded-full"
            pointerEvents="none"
            style={{
              ...thumbStyle,
              backgroundColor: hueColor,
              left: (hsv.h / 360) * hueWidth - THUMB_SIZE / 2,
              top: "50%",
              marginTop: -THUMB_SIZE / 2,
            }}
          />
        </View>
      </GestureDetector>
    </View>
  );
}
