import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { ZapIcon } from "lucide-react";

import type { ComposerControlSize } from "./ComposerControl";

const GLYPH_HEIGHT_SM = 18;
const GLYPH_HEIGHT_XS = 16;
// Bars stop this far above the box's bottom, which puts their flat base on the text baseline.
const BASELINE_INSET = 2;

const NAMED_LEVELS = new Set(["ultra", "ultracode", "ultrathink"]);
const OFF_LEVELS = new Set(["off", "none"]);

/**
 * One bar per reasoning level; binary thinking has a distinct icon.
 * Prompt-injected and named modes keep their labels.
 */
export function resolveEffortGlyph(
  descriptor: ProviderOptionDescriptor,
  current: string | boolean | null,
) {
  if (descriptor.type === "boolean") {
    return typeof current === "boolean"
      ? {
          kind: "thinking" as const,
          enabled: current,
          label: `${descriptor.label} ${current ? "On" : "Off"}`,
        }
      : null;
  }
  if (typeof current !== "string") return null;
  const special = new Set([...(descriptor.promptInjectedValues ?? []), ...NAMED_LEVELS]);
  const levels = descriptor.options.filter((option) => !special.has(option.id));
  if (levels.length < 2) return null;
  if (special.has(current)) {
    const label = descriptor.options.find((option) => option.id === current)?.label ?? current;
    return { kind: "label" as const, label };
  }
  const index = levels.findIndex((option) => option.id === current);
  if (index < 0) return null;
  const label = levels[index]!.label;
  if (levels.length === 2 && levels.some((level) => OFF_LEVELS.has(level.id))) {
    return { kind: "thinking" as const, enabled: !OFF_LEVELS.has(current), label };
  }
  const startsAtOff = OFF_LEVELS.has(levels[0]!.id);
  return {
    kind: "bars" as const,
    count: startsAtOff ? levels.length - 1 : levels.length,
    filled: startsAtOff ? index : index + 1,
    label,
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
  const barWidth = props.count <= 3 ? 5 : 3;
  const step = barWidth + 2;
  const barsWidth = step * (props.count - 1) + barWidth;
  const width = Math.max(24, barsWidth);
  const inset = Math.floor((width - barsWidth) / 2);
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
        const x = inset + index * step;
        return (
          <rect
            key={x}
            x={x}
            y={maxBar - barHeight}
            width={barWidth}
            height={barHeight}
            fill="currentColor"
            opacity={index < props.filled ? 1 : 0.25}
          />
        );
      })}
    </svg>
  );
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
