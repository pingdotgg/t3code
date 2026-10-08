import type { CSSProperties, SVGProps } from "react";

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
  return (
    <svg
      {...props}
      viewBox={icon.viewBox}
      fill="none"
      className={cn("fill-(--icon-light) dark:fill-(--icon-dark)", className)}
      style={
        {
          "--icon-light": icon.fill.light,
          "--icon-dark": icon.fill.dark,
        } as CSSProperties
      }
    >
      {icon.paths.map((path) => (
        <path
          key={path.d}
          d={path.d}
          fillRule={path.fillRule}
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
