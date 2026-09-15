import type { ProjectIconColor } from "@t3tools/contracts";
import type { ProjectMonogramColor } from "@t3tools/contracts/settings";
import { projectIconColorClassName } from "../projectIconColors";
import { cn } from "~/lib/utils";

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function ProjectMonogram({
  text,
  color,
  colorMode = "auto",
  className,
}: {
  readonly text: string;
  readonly color: ProjectIconColor;
  readonly colorMode?: ProjectMonogramColor;
  readonly className?: string | undefined;
}) {
  const isAccent = colorMode === "accent";

  // Wrapped like the emoji and Lucide branches so the monogram sits where an
  // <img> favicon would. Menu items, buttons and the like pull every bare svg
  // in with [&_svg]:-mx-0.5 to trim the padding stroke icons carry, and this
  // tile has no such padding.
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      <svg
        viewBox="0 0 16 16"
        className={cn(
          "size-full overflow-hidden rounded-[25%] font-mono select-none",
          isAccent ? "text-primary-foreground" : projectIconColorClassName(color),
        )}
        style={{
          backgroundColor: isAccent
            ? "var(--primary)"
            : "color-mix(in srgb, currentColor 14%, transparent)",
        }}
      >
        <text
          x="8"
          y="10.8"
          textAnchor="middle"
          fill={isAccent ? "var(--primary-foreground)" : "currentColor"}
          className="font-mono"
          fontSize="8.25"
          fontWeight="700"
          textLength={Array.from(monogramSegmenter.segment(text)).length === 1 ? 6 : 12}
          lengthAdjust="spacingAndGlyphs"
          textRendering="geometricPrecision"
        >
          {text}
        </text>
      </svg>
    </span>
  );
}
