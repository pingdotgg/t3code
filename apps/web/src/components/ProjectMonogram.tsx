import type { ProjectIconColor } from "@t3tools/contracts";
import { projectIconColorClassName } from "../projectIconColors";
import { cn } from "~/lib/utils";

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function ProjectMonogram({
  text,
  color,
  className,
}: {
  readonly text: string;
  readonly color: ProjectIconColor;
  readonly className?: string | undefined;
}) {
  const glyphCount = Array.from(monogramSegmenter.segment(text)).length;
  // Wrap the tile to avoid menu/button SVG margin trimming.
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      <svg
        viewBox="0 0 16 16"
        className={cn(
          "size-full overflow-hidden rounded-[25%] font-sans select-none",
          projectIconColorClassName(color),
        )}
        style={{
          backgroundColor: "color-mix(in srgb, currentColor 16%, transparent)",
        }}
      >
        <text
          x="8"
          y="11.4"
          textAnchor="middle"
          fill="currentColor"
          className="font-sans"
          fontSize={glyphCount === 1 ? 9.5 : 7.5}
          fontWeight="600"
          {...(glyphCount > 1 ? { textLength: 12, lengthAdjust: "spacingAndGlyphs" as const } : {})}
          textRendering="geometricPrecision"
        >
          {text}
        </text>
      </svg>
    </span>
  );
}
