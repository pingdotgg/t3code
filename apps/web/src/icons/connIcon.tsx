import {
  createLucideIcon,
  type LucideIcon as OriginalLucideIcon,
  type LucideProps as OriginalLucideProps,
} from "lucide-react-original";
import { forwardRef, type ForwardRefExoticComponent, type RefAttributes } from "react";
import { useIconOverride } from "./iconOverride";

// Hand-drawn stroke icons (createLucideIcon) still render through Lucide.
export { createLucideIcon };
export type LucideProps = OriginalLucideProps;
export type LucideIcon = OriginalLucideIcon;

/** One Superheroicons 16px solid glyph: plain paths and rects, filled with the current color. */
export type IconNode = ReadonlyArray<
  readonly [tag: "path" | "rect", attrs: Readonly<Record<string, string>>]
>;

// Lucide's rule: an icon without a label or children is decorative.
function hasA11yProp(props: Record<string, unknown>): boolean {
  return Object.keys(props).some(
    (key) => key.startsWith("aria-") || key === "role" || key === "title",
  );
}

/**
 * A component with Lucide's props that draws a Conn glyph. `size` (default 24) and `color`
 * work as in Lucide; stroke props are ignored, since the glyphs are solid. The svg keeps
 * Lucide's `lucide lucide-<name>` classes for selectors. `viewBox` crops the 16-unit box for
 * glyphs drawn one size step up.
 */
export function connIcon(name: string, node: IconNode, viewBox = "0 0 16 16"): LucideIcon {
  const ConnIcon = forwardRef<SVGSVGElement, Omit<LucideProps, "ref">>(
    function ConnIcon(props, ref) {
      const override = useIconOverride(name, props, ref, false);
      if (override) return override;
      const {
        size = 24,
        color = "currentColor",
        strokeWidth: _strokeWidth,
        absoluteStrokeWidth: _absolute,
        className,
        children,
        ...rest
      } = props;
      return (
        <svg
          ref={ref}
          xmlns="http://www.w3.org/2000/svg"
          width={size}
          height={size}
          viewBox={viewBox}
          fill={color}
          className={className ? `lucide lucide-${name} ${className}` : `lucide lucide-${name}`}
          {...(!children && !hasA11yProp(rest) ? { "aria-hidden": true } : {})}
          {...rest}
        >
          {node.map(([Tag, attrs], index) => (
            // oxlint-disable-next-line react/no-array-index-key -- a glyph's elements never reorder
            <Tag key={index} {...attrs} />
          ))}
          {children}
        </svg>
      );
    },
  ) as ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>;
  ConnIcon.displayName = name;
  return ConnIcon;
}
