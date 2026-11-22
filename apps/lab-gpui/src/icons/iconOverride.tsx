// Lab stand-in for apps/web/src/icons/iconOverride.ts (vite.config.ts, STUBBED). Draws the new icon
// set in place of Lucide and Phosphor. Only the glyph changes: size, className, aria and the rest
// of the props stay as the caller gave them. Switch modes with `?icons=` or the corner switcher.
import type { LucideProps } from "lucide-react-original";
import { useLayoutEffect, useRef, useState, type ReactElement, type Ref } from "react";
import { CONCEPT_MARKUP, LUCIDE_TO_CONCEPT } from "./iconSet.generated";
import { useIconMode, type IconMode } from "./iconMode";

const normalize = (name: string) => name.replace(/-/g, "").toLowerCase();

const warned = new Set<string>();
function warnUnmapped(name: string) {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`[icon lab] no concept for Lucide icon "${name}"; drawing the original`);
}

const SPACING_PX = 4;
const TAILWIND_SIZE = /^(size|w|h)-(px|\d+(?:\.\d+)?|\[(\d+(?:\.\d+)?)(px|rem)\])$/;

/** Size in px from `size-4`, `w-5 h-5` or `size-[18px]`. Variant-prefixed classes are skipped. */
function sizeFromClassName(className: string | undefined): number | null {
  if (!className) return null;
  let size: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  for (const token of className.split(/\s+/)) {
    const match = TAILWIND_SIZE.exec(token);
    if (!match) continue;
    const px =
      match[3] !== undefined
        ? Number(match[3]) * (match[4] === "rem" ? 16 : 1)
        : match[2] === "px"
          ? 1
          : Number(match[2]) * SPACING_PX;
    if (match[1] === "size") size = px;
    else if (match[1] === "w") width = px;
    else height = px;
  }
  return size ?? width ?? height;
}

function sizeFromProp(size: LucideProps["size"]): number | null {
  if (size === undefined) return null;
  const px = typeof size === "number" ? size : Number.parseFloat(size);
  return Number.isFinite(px) ? px : null;
}

/** Index into a concept's [outline 24, solid 24, solid 20, solid 16] markup. */
function variantFor(mode: Exclude<IconMode, "original">, size: number): 0 | 1 | 2 | 3 {
  switch (mode) {
    case "outline":
      return 0;
    case "solid24":
      return 1;
    case "solid20":
      return 2;
    case "solid16":
      return 3;
    case "auto":
      return size <= 16 ? 3 : size <= 20 ? 2 : 1;
  }
}
const VIEW_BOX = ["0 0 24 24", "0 0 24 24", "0 0 20 20", "0 0 16 16"] as const;

function LabIcon(props: {
  readonly concept: string;
  readonly mode: Exclude<IconMode, "original">;
  readonly name: string;
  readonly scoped: boolean;
  readonly iconProps: Omit<LucideProps, "ref">;
  readonly iconRef: Ref<SVGSVGElement>;
}) {
  const { concept, mode, name, scoped, iconRef } = props;
  const {
    size = 24,
    color,
    className,
    strokeWidth: _strokeWidth,
    absoluteStrokeWidth: _absolute,
    children: _children,
    ...rest
  } = props.iconProps;

  // `auto` needs a size: the size prop, then size-*/w-*/h-* classes, then the box as laid out
  // (parent selectors such as `[&_svg]:size-4` set it), then 24.
  const declared = sizeFromProp(props.iconProps.size) ?? sizeFromClassName(className);
  const [measured, setMeasured] = useState<number | null>(null);
  const elementRef = useRef<SVGSVGElement | null>(null);
  const setRef = (node: SVGSVGElement | null) => {
    elementRef.current = node;
    assignRef(iconRef, node);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the laid-out size exists only after mount
  useLayoutEffect(() => {
    if (mode !== "auto" || declared !== null || !elementRef.current) return;
    const width = elementRef.current.getBoundingClientRect().width;
    setMeasured(width > 0 ? width : null);
  }, [mode, declared]);

  const variant = variantFor(mode, declared ?? measured ?? 24);
  const outline = variant === 0;
  const labelled =
    rest["aria-label"] !== undefined ||
    rest["aria-labelledby"] !== undefined ||
    rest.role !== undefined;

  return (
    <svg
      ref={setRef}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={VIEW_BOX[variant]}
      fill={outline ? "none" : (color ?? "currentColor")}
      stroke={outline ? (color ?? "currentColor") : undefined}
      strokeWidth={outline ? 1.5 : undefined}
      aria-hidden={labelled ? undefined : true}
      className={[scoped ? `lucide-${name}` : `lucide lucide-${name}`, className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
      dangerouslySetInnerHTML={{ __html: CONCEPT_MARKUP[concept]![variant] }}
    />
  );
}

function assignRef(ref: Ref<SVGSVGElement>, node: SVGSVGElement | null) {
  if (typeof ref === "function") ref(node);
  else if (ref) ref.current = node;
}

export function useIconOverride(
  name: string,
  props: Omit<LucideProps, "ref">,
  ref: Ref<SVGSVGElement>,
  scoped: boolean,
): ReactElement | null {
  const mode = useIconMode();
  if (mode === "original") return null;
  const concept = LUCIDE_TO_CONCEPT[normalize(name)];
  if (!concept) {
    warnUnmapped(name);
    return null;
  }
  return (
    <LabIcon
      concept={concept}
      mode={mode}
      name={name}
      scoped={scoped}
      iconProps={props}
      iconRef={ref}
    />
  );
}
