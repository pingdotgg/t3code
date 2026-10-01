import {
  resolveFloatingLayer,
  type ClientHost,
  type FloatingPopoverProps,
} from "@t3tools/extension-sdk/environment";
import type { ComponentType, CSSProperties } from "react";

import { floatingOverPage } from "./floating.js";

/**
 * What the panel's popovers render with: the host's floating layer, which
 * escapes the panel's clipping and caps the height to the viewport, and the
 * panel's theme, which portaled content does not inherit.
 */
export interface PanelFloating {
  readonly Popover: ComponentType<FloatingPopoverProps>;
  readonly style: CSSProperties;
}

/** The host's popover, or an in-place one stacked at `zIndex` on hosts without a floating layer. */
export function panelPopover(
  host: Pick<ClientHost, "floatingLayer">,
  zIndex: number,
): ComponentType<FloatingPopoverProps> {
  return resolveFloatingLayer(host)?.Popover ?? inlinePopover(zIndex);
}

/**
 * The pre-layer fallback: absolutely positioned against the anchor's parent,
 * so it stays inside the panel's clipping.
 */
function inlinePopover(zIndex: number): ComponentType<FloatingPopoverProps> {
  return function InlinePopover({
    anchor,
    side = "bottom",
    align = "end",
    offset = 6,
    elementRef,
    style,
    ...attributes
  }: FloatingPopoverProps) {
    if (anchor === null) return null;
    const inset = side === "inset" ? offset : 0;
    return (
      <div
        {...attributes}
        {...floatingOverPage}
        ref={elementRef}
        style={{
          ...style,
          position: "absolute",
          ...(side === "inset"
            ? { top: offset }
            : side === "top"
              ? { bottom: `calc(100% + ${offset}px)` }
              : { top: `calc(100% + ${offset}px)` }),
          ...(align === "start" ? { left: inset } : { right: inset }),
          zIndex,
        }}
      />
    );
  };
}
