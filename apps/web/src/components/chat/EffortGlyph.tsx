import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { ZapIcon } from "lucide-react";
import { useId } from "react";

import type { ComposerControlSize } from "./ComposerControl";

const GLYPH_HEIGHT_SM = 14;
const GLYPH_HEIGHT_XS = 12;
// Bars stop this far above the box's bottom, which puts their flat base on the text baseline.
const BASELINE_INSET = 2;

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

// Older servers offer Ultracode as a level. It changes the workflow, so it keeps its name.
// Max is named too, so the full scale stops short of it. Default leaves the level to the agent.
const NAMED_LEVELS = new Set(["ultracode", "max", "default"]);
const OFF_LEVELS = new Set(["off", "none"]);
// More bars than this no longer fit the glyph's height in whole pixels.
const MAX_BARS = 7;

/**
 * Maps a reasoning select to bars: one per ordinary level, filled up to the current one, with an
 * off level as none filled. Max, Default, prompt-injected and workflow levels are named instead.
 */
export function resolveEffortGlyph(descriptor: SelectDescriptor, current: string | null) {
  const special = new Set([...(descriptor.promptInjectedValues ?? []), ...NAMED_LEVELS]);
  const levels = descriptor.options.filter((option) => !special.has(option.id));
  if (levels.length < 2 || levels.length > MAX_BARS || current === null) return null;
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

// lucide's `zap` path, on its 24-unit grid.
const ZAP_PATH =
  "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z";

/** One bolt for Fast. Ultrafast adds an outlined echo behind it, masked clear of the front bolt. */
export function FastBolt(props: { ultra: boolean }) {
  const maskId = useId();
  if (!props.ultra) {
    return (
      <ZapIcon aria-hidden="true" data-composer-control-icon className="size-3 fill-current" />
    );
  }
  // A mask rather than a surface-colored stroke, so the gap shows on any background (popups too).
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 30 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Inline size and the icon marker keep the composer control CSS from resizing or shifting it.
      style={{ width: 15, height: 12 }}
      className="shrink-0"
      data-composer-control-icon
    >
      <mask id={maskId}>
        {/* oxlint-disable-next-line shadcn/no-raw-colors -- mask luminance, never painted */}
        <rect width={30} height={24} fill="white" stroke="none" />
        {/* oxlint-disable-next-line shadcn/no-raw-colors -- mask luminance, never painted */}
        <path d={ZAP_PATH} fill="black" stroke="black" strokeWidth={4} />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path d={ZAP_PATH} transform="translate(6 0)" />
      </g>
      <path d={ZAP_PATH} fill="currentColor" stroke="none" />
    </svg>
  );
}
