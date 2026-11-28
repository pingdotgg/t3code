import type { SourceControlIcon } from "@t3tools/client-runtime/source-control-clients";
import { useId, type SVGProps } from "react";

/** Draws a host's mark from its definition's artwork. */
export function SourceControlIconArtwork({
  icon,
  ...props
}: { readonly icon: SourceControlIcon } & SVGProps<SVGSVGElement>) {
  // Gradient ids are document-wide, and one page can show the same mark many times.
  const idPrefix = useId().replace(/[^\w-]/gu, "");
  const paint = (value: SourceControlIcon["paths"][number]["fill"]) =>
    value === undefined
      ? "none"
      : typeof value === "string"
        ? value
        : `url(#${idPrefix}-${value.gradient})`;
  return (
    <svg aria-hidden {...props} viewBox={icon.viewBox} fill="none">
      {icon.gradients ? (
        <defs>
          {icon.gradients.map((gradient) => (
            <linearGradient
              key={gradient.id}
              id={`${idPrefix}-${gradient.id}`}
              x1={gradient.x1}
              y1={gradient.y1}
              x2={gradient.x2}
              y2={gradient.y2}
              gradientTransform={gradient.transform}
              gradientUnits="userSpaceOnUse"
            >
              {gradient.stops.map((stop) => (
                <stop
                  key={stop.offset}
                  offset={stop.offset}
                  stopColor={stop.color}
                  stopOpacity={stop.opacity}
                />
              ))}
            </linearGradient>
          ))}
        </defs>
      ) : null}
      {icon.paths.map((path, index) => (
        <path
          // Paths repeat with different paints, so their data is not a key.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          d={path.d}
          fill={paint(path.fill)}
          fillRule={path.fillRule}
          fillOpacity={path.fillOpacity}
          stroke={path.stroke}
          strokeWidth={path.strokeWidth}
        />
      ))}
    </svg>
  );
}
