import type { ProviderOptionDescriptor } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import type { ComposerControlSize } from "./ComposerControl";

const GLYPH_HEIGHT_SM = 14;
const GLYPH_HEIGHT_XS = 12;
// Bars stop this far above the box's bottom, which puts their flat base on the text baseline.
const BASELINE_INSET = 2;

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

// Ultracode changes the workflow, not only intensity, so it keeps its name like Ultrathink.
// Max is named too, so the full scale stops short of it.
const NAMED_LEVELS = new Set(["ultracode", "max"]);
const OFF_LEVELS = new Set(["off", "none"]);

/**
 * Maps a reasoning select to bars: one per ordinary level, filled up to the current one, with an
 * off level as none filled. Max, prompt-injected and workflow levels are named instead of drawn.
 */
export function resolveEffortGlyph(descriptor: SelectDescriptor, current: string | null) {
  const special = new Set([...(descriptor.promptInjectedValues ?? []), ...NAMED_LEVELS]);
  const levels = descriptor.options.filter((option) => !special.has(option.id));
  if (levels.length < 2 || current === null) return null;
  const startsAtOff = OFF_LEVELS.has(levels[0]!.id);
  const count = startsAtOff ? levels.length - 1 : levels.length;
  if (special.has(current)) {
    const label = descriptor.options.find((option) => option.id === current)?.label ?? current;
    return { count, filled: count, special: label, label };
  }
  const index = levels.findIndex((option) => option.id === current);
  if (index < 0) return null;
  return {
    count,
    filled: startsAtOff ? index : index + 1,
    special: null,
    label: levels[index]!.label,
  };
}

/** Bar heights that rise by one whole-pixel step, from about half height up to `maxBar`. */
export function effortBarHeights(count: number, maxBar: number): number[] {
  // Rounding each bar separately mixes 1px and 2px steps, so round the step once.
  const step = Math.max(1, Math.round(maxBar / 2 / Math.max(count - 1, 1)));
  return Array.from({ length: count }, (_, index) => maxBar - (count - 1 - index) * step);
}

/**
 * Rising bars on whole pixels so they stay sharp on 1x displays. Color follows the text.
 * The box is centered like the icons beside it; the bars sit on the text baseline inside it.
 */
export function EffortGlyph(props: { count: number; filled: number; size?: ComposerControlSize }) {
  const height = props.size === "xs" ? GLYPH_HEIGHT_XS : GLYPH_HEIGHT_SM;
  const step = 4;
  const width = step * props.count - 2;
  const maxBar = height - BASELINE_INSET;
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      // Inline size: the composer control CSS forces unsized SVGs to 16px.
      style={{ width, height }}
      className="shrink-0 text-current"
      data-composer-effort-glyph
      // Opts out of the control's negative icon margins, so the row's gaps stay true.
      data-composer-control-icon
    >
      {effortBarHeights(props.count, maxBar).map((barHeight, index) => {
        const x = index * step;
        return (
          <rect
            key={x}
            x={x}
            y={maxBar - barHeight}
            width={2}
            height={barHeight}
            fill="currentColor"
            opacity={index < props.filled ? 1 : 0.4}
          />
        );
      })}
    </svg>
  );
}

// Lucide's gauge: a 10-unit arc around (12, 14) from 210° to -30°, and a 5.66-unit needle.
const GAUGE_ARC_START = "M3.34 19";
const GAUGE_RADIUS = 10;
const GAUGE_NEEDLE_LENGTH = 5.66;
const GAUGE_OFF_ANGLE = 210;

/** The needle sweeps left to right across the levels; off rests it at the arc's start. */
export function effortGaugeAngle(count: number, filled: number): number {
  if (filled === 0) return GAUGE_OFF_ANGLE;
  return count === 1 ? 0 : 180 - (180 * (filled - 1)) / (count - 1);
}

function gaugePoint(angle: number, radius: number): string {
  const radians = (angle * Math.PI) / 180;
  const x = 12 + radius * Math.cos(radians);
  const y = 14 - radius * Math.sin(radians);
  return `${x.toFixed(2)} ${y.toFixed(2)}`;
}

/** Lucide's gauge with the needle at the current level and the arc filled up to it. */
export function EffortGauge(props: { count: number; filled: number; size?: ComposerControlSize }) {
  const angle = effortGaugeAngle(props.count, props.filled);
  const largeArc = GAUGE_OFF_ANGLE - angle > 180 ? 1 : 0;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      className={cn("shrink-0 text-current", props.size === "xs" ? "size-3" : "size-4")}
      data-composer-effort-glyph
      data-composer-control-icon
    >
      <path d={`${GAUGE_ARC_START}a10 10 0 1 1 17.32 0`} opacity={0.4} />
      {props.filled > 0 ? (
        <path d={`${GAUGE_ARC_START}A10 10 0 ${largeArc} 1 ${gaugePoint(angle, GAUGE_RADIUS)}`} />
      ) : null}
      <path d={`M12 14L${gaugePoint(angle, GAUGE_NEEDLE_LENGTH)}`} />
    </svg>
  );
}
