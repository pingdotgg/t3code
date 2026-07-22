import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type * as React from "react";

import { Kbd } from "../ui/kbd";

/**
 * Hold-modifier shortcut hint for a composer control. Rendered as a detached,
 * always-open tooltip anchored below the control's trigger so the trigger keeps
 * showing its current value while hints are visible. Portaled because the
 * composer footer is a horizontal scroll container that would clip an inline
 * absolutely-positioned badge.
 */
export function ComposerControlShortcutHint(props: {
  anchorRef: React.RefObject<Element | null>;
  label: string | null;
}) {
  if (!props.label) return null;
  return (
    <TooltipPrimitive.Root open>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          anchor={props.anchorRef}
          side="bottom"
          align="center"
          sideOffset={4}
          className="pointer-events-none z-50"
        >
          <TooltipPrimitive.Popup>
            <Kbd className="h-4 min-w-0 rounded-sm border bg-popover px-1.5 text-[10px] shadow-md/5">
              {props.label}
            </Kbd>
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
