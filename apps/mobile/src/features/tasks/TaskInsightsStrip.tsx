import {
  formatInsightValue,
  INSIGHTS,
  insightChangeTone,
  insightResults,
  insightTrend,
  type InsightId,
  type InsightResult,
  type InsightSpec,
  type TrendPoint,
} from "@t3tools/client-runtime/orbit-gateway";
import * as Haptics from "expo-haptics";
import { useGT, useMessages } from "gt-react-native";
import { useId, useState } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import Reanimated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { isDarkThemeColor } from "../../lib/mobileTheme";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { labInsightTrend, useOrbitTaskInsights } from "./orbitTasks";

const SPARK_HEIGHT = 28;

type Placed = { readonly x: number; readonly y: number };

/** Splits at missing values, so a gap in the data is a gap in the line. */
function segments(points: ReadonlyArray<{ x: number; y: number | null }>) {
  const runs: Placed[][] = [];
  let run: Placed[] = [];
  for (const point of points) {
    if (point.y === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push({ x: point.x, y: point.y });
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

const pathOf = (run: ReadonlyArray<Placed>) =>
  run
    .map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");

const areaOf = (run: ReadonlyArray<Placed>, baseline: number) =>
  `${pathOf(run)} L${run.at(-1)!.x.toFixed(1)},${baseline} L${run[0]!.x.toFixed(1)},${baseline} Z`;

/** Desktop pads the range by 12%, so a flat series sits mid-height instead of on the edge. */
function extent(values: ReadonlyArray<number>) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.12 || Math.abs(max) * 0.1 || 1;
  return [min - pad, max + pad] as const;
}

/** An axis on round steps (1, 2, 2.5 or 5 × 10ⁿ) that covers the data in at most four gridlines. */
function niceScale(min: number, max: number) {
  const span = max - min || Math.abs(max) || 1;
  const power = 10 ** Math.floor(Math.log10(span / 3));
  const candidates = [1, 2, 2.5, 5, 10, 20, 25, 50].map((factor) => factor * power);
  const fits = (step: number) => Math.ceil(max / step) - Math.floor(min / step) <= 3;
  const step = candidates.find(fits) ?? candidates.at(-1)!;
  const low = Math.floor(min / step) * step;
  const high = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let tick = low; tick <= high + step / 2; tick += step) {
    ticks.push(Math.round(tick / step) * step);
  }
  return { low, high: high === low ? low + step : high, ticks };
}

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dateLabel = (date: string) => {
  const time = Date.parse(`${date}T00:00:00`);
  return Number.isNaN(time) ? date : SHORT_DATE.format(time);
};

/**
 * The insight over the period, where Orbit reports a history; other numbers have none yet. Like
 * the desktop: a muted line over a fading area, broken where a point is missing.
 */
function Sparkline(props: { readonly points: ReadonlyArray<TrendPoint> }) {
  const { color } = useResolveClassNames("text-foreground-muted");
  const [width, setWidth] = useState(0);
  const fade = `spark${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const values = props.points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const [low, high] = values.length > 0 ? extent(values) : [0, 1];
  const x = (index: number) => 1 + (index / Math.max(1, props.points.length - 1)) * (width - 2);
  const y = (value: number) =>
    SPARK_HEIGHT - 3 - ((value - low) / (high - low)) * (SPARK_HEIGHT - 6);
  const runs = segments(
    props.points.map((point, index) => ({
      x: x(index),
      y: point.value === null ? null : y(point.value),
    })),
  );
  return (
    <View
      accessible={false}
      style={{ height: SPARK_HEIGHT }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {width > 0 && values.length > 1 ? (
        <Svg width={width} height={SPARK_HEIGHT}>
          <Defs>
            <LinearGradient id={fade} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={color} stopOpacity={0.22} />
              <Stop offset="1" stopColor={color} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          {runs
            .filter((run) => run.length > 1)
            .map((run) => (
              <G key={`${run[0]!.x}`}>
                <Path d={areaOf(run, SPARK_HEIGHT)} fill={`url(#${fade})`} />
                <Path
                  d={pathOf(run)}
                  fill="none"
                  stroke={color}
                  strokeOpacity={0.7}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </G>
            ))}
        </Svg>
      ) : null}
    </View>
  );
}

/** Desktop's trending-down / trending-up glyphs (Lucide), drawn here so they match in every build. */
function TrendGlyph(props: { readonly down: boolean; readonly color: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" accessible={false}>
      <Path
        d={props.down ? "M16 17h6v-6M22 17l-8.5-8.5-5 5L2 7" : "M16 7h6v6M22 7l-8.5 8.5-5-5L2 17"}
        stroke={props.color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function CloseGlyph(props: { readonly color: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" accessible={false}>
      <Path
        d="M18 6 6 18M6 6l12 12"
        stroke={props.color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * Variant B of the mobile lab's insight strip. A card is 160 wide: 1 border, 10/12/8/12 padding,
 * 20 label, 4 gap, 24 value row, 4 gap, 4 + 28 sparkline. Corners that face another card are square.
 */
const CARD_WIDTH = 160;
const CARD_GAP = 2;
const CARD_HEIGHT = 104;
const OUTER_RADIUS = 12;
/** The screen gutter, the same as the task rows below. */
const GUTTER = 12;
const FADE_WIDTH = 40;
const CHART_HEIGHT = 126;
const CHART_TOP = 18;
/** Label, change and period: 13/20. The value: 18/24, medium. Set in points: `leading-*` does not apply to `text-[13px]`. */
const LABEL_TYPE = { fontSize: 13, lineHeight: 20 } as const;
const VALUE_TYPE = { fontSize: 18, lineHeight: 24 } as const;
/** The app's spacing classes run at 0.87 of a point, so every pt value here is a style. */
const CARD_PADDING = {
  paddingTop: 10,
  paddingHorizontal: 12,
  paddingBottom: 8,
  rowGap: 4,
} as const;

function blockRadius(row: number, rows: number, column: number, columns: number) {
  const radius = (outer: boolean) => (outer ? OUTER_RADIUS : 0);
  const left = column === 0;
  const right = column === columns - 1;
  return {
    borderTopLeftRadius: radius(row === 0 && left),
    borderTopRightRadius: radius(row === 0 && right),
    borderBottomRightRadius: radius(row === rows - 1 && right),
    borderBottomLeftRadius: radius(row === rows - 1 && left),
  };
}

type Translate = ReturnType<typeof useGT>;

/** `+9%`, `−3 pts`, `±0`: the change against the period before, as the cards and the chart show it. */
function changeTextOf(gt: Translate, spec: InsightSpec, change: number | null) {
  if (change === null) return null;
  return `${change > 0 ? "+" : change < 0 ? "−" : "±"}${Math.abs(change)}${
    spec.unit === "pts" ? ` ${gt("pts", { $context: "share points" })}` : spec.unit
  }`;
}

/** The tone of a change: good reads green (700 in light, 400 in dark), bad red, the rest muted. */
function useToneClass(tone: "good" | "bad" | "neutral") {
  const theme = useUniwindTheme();
  if (tone === "bad") return "text-danger-foreground";
  if (tone === "neutral") return "text-foreground-muted";
  return isDarkThemeColor(theme["--color-screen"])
    ? "text-adaptive-emerald-600-400"
    : "text-adaptive-emerald-700-300";
}

/** The change with its trend glyph, in the tone of the change; shared by a card and its chart. */
function InsightChange(props: { readonly spec: InsightSpec; readonly result: InsightResult }) {
  const gt = useGT();
  const { spec, result } = props;
  const toneClass = useToneClass(insightChangeTone(spec, result.change));
  const { color } = useResolveClassNames(toneClass);
  const change = result.change;
  if (result.value === null) return null;
  if (change === null) {
    return (
      <Text className="shrink text-foreground-tertiary" style={LABEL_TYPE} numberOfLines={1}>
        {gt("No earlier data")}
      </Text>
    );
  }
  return (
    <View className="shrink flex-row items-center" style={{ columnGap: 4 }}>
      {change === 0 ? null : (
        <TrendGlyph down={change < 0} color={typeof color === "string" ? color : "gray"} />
      )}
      <Text className={cn("tabular-nums", toneClass)} style={LABEL_TYPE} numberOfLines={1}>
        {changeTextOf(gt, spec, change)}
      </Text>
    </View>
  );
}

function InsightCard(props: {
  readonly spec: InsightSpec;
  readonly result: InsightResult;
  readonly trend: ReadonlyArray<TrendPoint> | null;
  readonly row: number;
  readonly radius: ReturnType<typeof blockRadius>;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { spec, result } = props;
  const label = m(spec.label);
  const value = result.value === null ? null : formatInsightValue(spec.id, result.value, m);
  // Only the top row has a border (its highlighted top edge); the rest keep it transparent so
  // every card measures the same.
  return (
    <View
      className={cn(
        "overflow-hidden border border-transparent bg-card-face",
        props.row === 0 && "border-t-card-face-edge",
      )}
      style={{ width: CARD_WIDTH, borderWidth: 1, ...props.radius }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          label,
          value ?? gt("Not reported"),
          changeTextOf(gt, spec, result.change),
        ]
          .filter(Boolean)
          .join(", ")}
        accessibilityHint={gt("Opens the chart")}
        onPress={props.onOpen}
        className="active:bg-foreground/5"
        style={CARD_PADDING}
      >
        <Text className="text-foreground-muted" style={LABEL_TYPE} numberOfLines={1}>
          {label}
        </Text>
        <View className="flex-row items-center" style={{ columnGap: 8 }}>
          <Text
            className={cn(
              "font-t3-medium tabular-nums",
              value === null ? "text-foreground-tertiary" : "text-foreground",
            )}
            style={VALUE_TYPE}
          >
            {value ?? "–"}
          </Text>
          <InsightChange spec={spec} result={result} />
        </View>
        <View style={{ marginTop: 4 }}>
          <Sparkline points={props.trend ?? []} />
        </View>
      </Pressable>
    </View>
  );
}

const LABEL_SIZE = 11;
/** The digits of an axis label are as wide as a 0; a letter or a dot is a little narrower. */
const labelWidthOf = (text: string) => Math.ceil(text.length * LABEL_SIZE * 0.6);
const AXIS_HEIGHT = 16;

/** A Catmull-Rom curve through the points, so the line flows instead of kinking. */
function smoothPathOf(run: ReadonlyArray<Placed>) {
  let path = `M${run[0]!.x.toFixed(1)},${run[0]!.y.toFixed(1)}`;
  for (let index = 0; index < run.length - 1; index++) {
    const p0 = run[index - 1] ?? run[index]!;
    const p1 = run[index]!;
    const p2 = run[index + 1]!;
    const p3 = run[index + 2] ?? p2;
    const c1 = [p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6] as const;
    const c2 = [p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6] as const;
    path += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return path;
}

/**
 * The insight's line over the period with a faint dashed grid. Touching or dragging snaps a
 * crosshair to the nearest day and reports it, so the header can show that day's value.
 */
function TrendChart(props: {
  readonly points: ReadonlyArray<TrendPoint>;
  readonly format: (value: number) => string;
  readonly label: string;
  readonly toneClass: string;
  readonly hover: number | null;
  readonly onHover: (index: number | null) => void;
}) {
  const [width, setWidth] = useState(0);
  const fade = `chart${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const { color: toneColor } = useResolveClassNames(props.toneClass);
  const { color: tertiaryColor } = useResolveClassNames("text-foreground-tertiary");
  const { color: foregroundColor } = useResolveClassNames("text-foreground");
  const { backgroundColor: screenColor } = useResolveClassNames("bg-screen");
  const line = typeof toneColor === "string" ? toneColor : "gray";
  const axis = typeof tertiaryColor === "string" ? tertiaryColor : "gray";
  const foreground = typeof foregroundColor === "string" ? foregroundColor : "white";
  const ring = typeof screenColor === "string" ? screenColor : "black";
  const { points, format, hover } = props;
  const height = CHART_HEIGHT;
  const count = points.length;
  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const { low, high, ticks } = niceScale(
    values.length > 0 ? Math.min(...values) : 0,
    values.length > 0 ? Math.max(...values) : 1,
  );
  const left = Math.max(...ticks.map((tick) => labelWidthOf(format(tick)))) + 6;
  const x = (index: number) => left + (index / Math.max(1, count - 1)) * (width - left);
  const y = (value: number) => 6 + (1 - (value - low) / (high - low)) * (height - AXIS_HEIGHT - 6);
  const runs = segments(
    points.map((point, index) => ({
      x: x(index),
      y: point.value === null ? null : y(point.value),
    })),
  );
  const baseline = y(low);
  const pick = (touchX: number) => {
    const ratio = width > left ? (touchX - left) / (width - left) : 0;
    props.onHover(Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1)))));
  };
  // Horizontal drags read the chart; a vertical move scrolls the Tasks list instead.
  const gesture = usePanGesture({
    runOnJS: true,
    activeOffsetX: [-4, 4],
    failOffsetY: [-14, 14],
    onBegin: (event) => pick(event.x),
    onUpdate: (event) => pick(event.x),
    onFinalize: () => props.onHover(null),
  });
  const axisIndexes = [
    ...new Set([0, 1, 2, 3].map((step) => Math.round((step * (count - 1)) / 3))),
  ];
  const hoveredValue = hover === null ? null : (points[hover]?.value ?? null);
  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        style={{ height, marginTop: CHART_TOP }}
        onLayout={(event) => setWidth(Math.round(event.nativeEvent.layout.width))}
      >
        {width > 0 ? (
          <Svg
            width={width}
            height={height}
            accessible
            accessibilityRole="image"
            accessibilityLabel={props.label}
          >
            <Defs>
              <LinearGradient id={fade} x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={line} stopOpacity={0.2} />
                <Stop offset="1" stopColor={line} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            {ticks.map((tick) => (
              <G key={tick}>
                <Line
                  x1={left}
                  x2={width}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke={foreground}
                  strokeOpacity={0.085}
                  strokeWidth={1}
                  strokeDasharray="2 5"
                />
                <SvgText x={0} y={y(tick) + 4} fontSize={LABEL_SIZE} fill={axis}>
                  {format(tick)}
                </SvgText>
              </G>
            ))}
            {runs.map((run) => (
              <G key={`${run[0]!.x}`}>
                <Path
                  d={`${smoothPathOf(run)} L${run.at(-1)!.x.toFixed(1)},${baseline} L${run[0]!.x.toFixed(1)},${baseline} Z`}
                  fill={`url(#${fade})`}
                />
                <Path
                  d={smoothPathOf(run)}
                  fill="none"
                  stroke={line}
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </G>
            ))}
            {axisIndexes.map((index, position) => (
              <SvgText
                key={index}
                x={x(index)}
                y={height - 3}
                textAnchor={
                  position === 0 ? "start" : position === axisIndexes.length - 1 ? "end" : "middle"
                }
                fontSize={LABEL_SIZE}
                fill={axis}
              >
                {dateLabel(points[index]?.date ?? "")}
              </SvgText>
            ))}
            {hover === null ? null : (
              <G>
                <Line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={2}
                  y2={baseline}
                  stroke={foreground}
                  strokeOpacity={0.28}
                  strokeWidth={1}
                />
                {hoveredValue === null ? null : (
                  <Circle
                    cx={x(hover)}
                    cy={y(hoveredValue)}
                    r={4.5}
                    fill={line}
                    stroke={ring}
                    strokeWidth={2.5}
                  />
                )}
              </G>
            )}
          </Svg>
        ) : null}
      </View>
    </GestureDetector>
  );
}

/**
 * One insight in the grid's place, at exactly the grid's height: the card's type (label, value,
 * change) over the period's chart. While a finger is on the chart the header shows that day.
 */
function InsightDetail(props: {
  readonly spec: InsightSpec;
  readonly label: string;
  readonly result: InsightResult;
  readonly trend: ReadonlyArray<TrendPoint> | null;
  readonly height: number;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { spec, result, trend } = props;
  const [hover, setHover] = useState<number | null>(null);
  const toneClass = useToneClass(insightChangeTone(spec, result.change));
  const { color: closeColor } = useResolveClassNames("text-foreground-muted");
  const format = (value: number) => formatInsightValue(spec.id, value, m);
  const hovered = hover === null ? undefined : trend?.[hover];
  const shownValue = hovered?.value ?? null;
  return (
    <View
      accessible={false}
      className="overflow-hidden border border-card-face-border border-t-card-face-edge bg-card-face"
      style={{
        height: props.height,
        marginHorizontal: GUTTER,
        borderWidth: 1,
        borderRadius: OUTER_RADIUS,
        paddingTop: 10,
        paddingHorizontal: 12,
        paddingBottom: 8,
      }}
      onAccessibilityEscape={props.onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("Close chart")}
        onPress={props.onClose}
        hitSlop={8}
        className="absolute z-10 items-center justify-center bg-foreground/6 active:bg-foreground/10"
        style={{ top: 10, right: 10, width: 28, height: 28, borderRadius: 14 }}
      >
        <CloseGlyph color={typeof closeColor === "string" ? closeColor : "gray"} />
      </Pressable>
      <View style={{ paddingRight: 36 }}>
        <Text className="text-foreground-muted" style={LABEL_TYPE} numberOfLines={1}>
          {props.label}
        </Text>
        <View className="flex-row items-center" style={{ marginTop: 4, columnGap: 8 }}>
          <Text className="font-t3-medium text-foreground tabular-nums" style={VALUE_TYPE}>
            {hovered
              ? shownValue === null
                ? "–"
                : format(shownValue)
              : result.value === null
                ? "–"
                : format(result.value)}
          </Text>
          {hovered ? null : <InsightChange spec={spec} result={result} />}
          <Text className="text-foreground-tertiary" style={LABEL_TYPE} numberOfLines={1}>
            {hovered ? dateLabel(hovered.date) : gt("30 days")}
          </Text>
        </View>
      </View>
      {trend ? (
        <TrendChart
          points={trend}
          format={format}
          label={gt("{label} over the period", { label: props.label })}
          toneClass={toneClass}
          hover={hover}
          onHover={setHover}
        />
      ) : (
        <View
          className="items-center justify-center"
          style={{ height: CHART_HEIGHT, marginTop: CHART_TOP }}
        >
          <Text className="text-center text-[13px] text-foreground-muted">
            {gt("Orbit reports no history for this number yet.")}
          </Text>
        </View>
      )}
    </View>
  );
}

/** A fade over the strip's clipped edge: the right one while there is more to come, the left once you scrolled. */
function EdgeFade(props: {
  readonly side: "left" | "right";
  readonly progress: SharedValue<number>;
}) {
  const { backgroundColor } = useResolveClassNames("bg-screen");
  const color = typeof backgroundColor === "string" ? backgroundColor : "black";
  const id = `insightsEdgeFade-${props.side}`;
  const style = useAnimatedStyle(() => {
    const p = Math.min(1, Math.max(0, props.progress.value));
    return { opacity: Math.min(1, Math.max(0, props.side === "right" ? 1 - p * 1.6 : p * 1.6)) };
  });
  return (
    <Reanimated.View
      pointerEvents="none"
      className={cn("absolute inset-y-0", props.side === "right" ? "right-0" : "left-0")}
      style={[{ width: FADE_WIDTH }, style]}
    >
      <Svg width={FADE_WIDTH} height="100%">
        <Defs>
          <LinearGradient
            id={id}
            x1={props.side === "right" ? "0" : "1"}
            y1="0"
            x2={props.side === "right" ? "1" : "0"}
            y2="0"
          >
            <Stop offset="0" stopColor={color} stopOpacity={0} />
            <Stop offset="0.85" stopColor={color} stopOpacity={1} />
            <Stop offset="1" stopColor={color} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width={FADE_WIDTH} height="100%" fill={`url(#${id})`} />
      </Svg>
    </Reanimated.View>
  );
}

/**
 * The board's insights above the Tasks list (variant B of the mobile lab): a card per number in two
 * rows of 160pt cards, 2pt apart, scrolling sideways off the screen's right edge. A number Orbit
 * does not report, or a failed read, is a dash. A tap opens a card's chart in the grid's place, at
 * the same height; its X brings the grid back.
 */
export function TaskInsightsStrip() {
  const gt = useGT();
  const m = useMessages();
  const { width } = useWindowDimensions();
  const state = useOrbitTaskInsights("30d");
  const insights = state.status === "ok" ? state.value : null;
  const results = insightResults(insights);
  const trendOf = (id: InsightId) => labInsightTrend(id) ?? insightTrend(insights, id);
  const [expanded, setExpanded] = useState<InsightId | null>(null);
  const [gridHeight, setGridHeight] = useState(2 * CARD_HEIGHT + CARD_GAP);
  const columns = Math.ceil(INSIGHTS.length / 2);
  const rows = [INSIGHTS.slice(0, columns), INSIGHTS.slice(columns)];
  const open = INSIGHTS.find((spec) => spec.id === expanded);
  const progress = useSharedValue(0);
  const reach = Math.max(1, 2 * GUTTER + columns * CARD_WIDTH + (columns - 1) * CARD_GAP - width);
  const onScroll = useAnimatedScrollHandler((event) => {
    progress.set(event.contentOffset.x / reach);
  });
  return (
    <View style={{ marginTop: 8, marginBottom: 20 }}>
      {open ? (
        <InsightDetail
          spec={open}
          label={m(open.label)}
          result={results[open.id]}
          trend={trendOf(open.id)}
          height={gridHeight}
          onClose={() => setExpanded(null)}
        />
      ) : (
        <>
          <Reanimated.ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: GUTTER }}
            snapToInterval={CARD_WIDTH + CARD_GAP}
            decelerationRate="fast"
            scrollEventThrottle={16}
            onScroll={onScroll}
            accessibilityLabel={gt("Task insights, last {days} days", { days: 30 })}
            accessibilityHint={
              state.status === "error"
                ? gt("Orbit did not answer: {message}", { message: state.message })
                : gt("Last {days} days against the {days} before.", { days: 30 })
            }
          >
            <View
              style={{ gap: CARD_GAP }}
              onLayout={(event) => setGridHeight(event.nativeEvent.layout.height)}
            >
              {rows.map((row, rowIndex) => (
                <View key={row[0]?.id} className="flex-row" style={{ gap: CARD_GAP }}>
                  {row.map((spec, column) => (
                    <InsightCard
                      key={spec.id}
                      spec={spec}
                      result={results[spec.id]}
                      trend={trendOf(spec.id)}
                      row={rowIndex}
                      radius={blockRadius(rowIndex, rows.length, column, row.length)}
                      onOpen={() => {
                        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setExpanded(spec.id);
                      }}
                    />
                  ))}
                </View>
              ))}
            </View>
          </Reanimated.ScrollView>
          <EdgeFade side="right" progress={progress} />
          <EdgeFade side="left" progress={progress} />
        </>
      )}
    </View>
  );
}
