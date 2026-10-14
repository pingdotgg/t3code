import { useId, type CSSProperties, type SVGProps } from "react";

import type { ProviderIcon } from "@t3tools/provider-core/client";

import { cn } from "~/lib/utils";

/**
 * Draws a provider package's plain-data glyph. Theme colors travel as CSS
 * variables so the `.dark` class switches them without a re-render.
 */
export function ProviderPackageIcon({
  icon,
  className,
  ...props
}: { readonly icon: ProviderIcon } & SVGProps<SVGSVGElement>) {
  const gradientId = useId();
  return (
    <svg
      {...props}
      viewBox={icon.viewBox}
      fill="none"
      // Lets monochrome renderings dim the whole glyph once instead of each path.
      data-provider-package-icon
      className={cn("fill-(--icon-light) dark:fill-(--icon-dark)", className)}
      style={
        {
          "--icon-light": icon.fill.light,
          "--icon-dark": icon.fill.dark,
        } as CSSProperties
      }
    >
      {icon.paths.some((path) => path.gradient) ? (
        <defs>
          {icon.paths.map((path, index) =>
            path.gradient ? (
              <linearGradient
                key={path.d}
                id={`${gradientId}-${index}`}
                x1={path.gradient.x1}
                y1={path.gradient.y1}
                x2={path.gradient.x2}
                y2={path.gradient.y2}
                gradientUnits="userSpaceOnUse"
              >
                {path.gradient.stops.map((stop) => (
                  <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
                ))}
              </linearGradient>
            ) : null,
          )}
        </defs>
      ) : null}
      {icon.paths.map((path, index) => (
        <path
          key={path.d}
          d={path.d}
          fillRule={path.fillRule}
          // An attribute, so monochrome renderings can still override it from CSS.
          fill={path.gradient ? `url(#${gradientId}-${index})` : undefined}
          // Monochrome renderings (the collapsed composer) clear these detail paths.
          data-icon-detail={path.fill ? true : undefined}
          className={path.fill ? "fill-(--path-light) dark:fill-(--path-dark)" : undefined}
          style={
            path.fill
              ? ({
                  "--path-light": path.fill.light,
                  "--path-dark": path.fill.dark,
                } as CSSProperties)
              : undefined
          }
        />
      ))}
    </svg>
  );
}
