import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { SparkleIcon, ZapIcon } from "lucide-react";

import type { ComposerControlSize } from "./ComposerControl";

const GLYPH_HEIGHT_SM = 14;
const GLYPH_HEIGHT_XS = 12;
// Bars stop this far above the box's bottom, which puts their flat base on the text baseline.
const BASELINE_INSET = 2;

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

// Max and workflow levels sit above the scale: full bars plus sparkles rather than more bars.
const NAMED_LEVELS = new Set(["ultra", "ultracode", "max"]);
const OFF_LEVELS = new Set(["off", "none"]);
// More bars than this no longer fit the glyph's height in whole pixels.
const MAX_BARS = 7;

// Color marks cost, not difference from a default, so ordinary levels stay quiet.
// Amber, red, then purple: no green, so the ramp holds up for red/green color blindness.
const EFFORT_TONES: Record<string, string> = {
  high: "text-amber-700 dark:text-amber-500",
  xhigh: "text-red-600 dark:text-red-500",
  max: "text-purple-600 dark:text-purple-400",
  ultra: "text-fuchsia-600 dark:text-fuchsia-400",
  ultracode: "text-fuchsia-600 dark:text-fuchsia-400",
  ultrathink: "text-fuchsia-600 dark:text-fuchsia-400",
};

export function effortTone(level: string | null) {
  return (level !== null && EFFORT_TONES[level]) || null;
}

/**
 * Maps a reasoning select to bars: one per ordinary level, filled up to the current one, with an
 * off level as none filled. Max draws full bars and one sparkle; prompt-injected and workflow
 * levels draw two.
 */
export function resolveEffortGlyph(descriptor: SelectDescriptor, current: string | null) {
  const special = new Set([...(descriptor.promptInjectedValues ?? []), ...NAMED_LEVELS]);
  const levels = descriptor.options.filter((option) => !special.has(option.id));
  if (descriptor.options.length < 2 || levels.length > MAX_BARS || current === null) return null;
  const startsAtOff = levels[0] !== undefined && OFF_LEVELS.has(levels[0].id);
  // A scale of only named levels still draws one bar under its sparkles.
  const count = Math.max(1, startsAtOff ? levels.length - 1 : levels.length);
  if (special.has(current)) {
    const label = descriptor.options.find((option) => option.id === current)?.label ?? current;
    return {
      count,
      filled: count,
      label,
      sparkles: current === "max" ? 1 : 2,
      tone: effortTone(current),
    };
  }
  const index = levels.findIndex((option) => option.id === current);
  if (index < 0) return null;
  return {
    count,
    filled: startsAtOff ? index : index + 1,
    label: levels[index]!.label,
    sparkles: 0,
    tone: effortTone(current),
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

export function EffortSparkles(props: { count: number }) {
  return Array.from({ length: props.count }, (_, index) => (
    <SparkleIcon
      key={index}
      aria-hidden="true"
      data-composer-control-icon
      className="size-3 fill-current text-current"
    />
  ));
}

/** One bolt for Fast. Ultrafast adds an outlined echo behind it, cut away by the surface color. */
export function FastBolt(props: { ultra: boolean }) {
  if (!props.ultra) {
    return (
      <ZapIcon aria-hidden="true" data-composer-control-icon className="size-3 fill-current" />
    );
  }
  return (
    <span aria-hidden="true" className="relative h-3 w-3.75 shrink-0">
      <ZapIcon className="absolute top-0 left-0.75 size-3" />
      <ZapIcon
        strokeWidth={4}
        className="absolute top-0 left-0 size-3 fill-current stroke-(--chat-composer-glass-surface) [paint-order:stroke]"
      />
    </span>
  );
}
