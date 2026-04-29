"use client";

import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";

import { cn } from "~/lib/utils";

const PreviewCard = PreviewCardPrimitive.Root;
const PreviewCardTrigger = PreviewCardPrimitive.Trigger;

function PreviewCardContent({
  children,
  className,
  side = "bottom",
  align = "end",
  sideOffset = 4,
  alignOffset = 0,
  ...props
}: PreviewCardPrimitive.Popup.Props & {
  side?: PreviewCardPrimitive.Positioner.Props["side"];
  align?: PreviewCardPrimitive.Positioner.Props["align"];
  sideOffset?: PreviewCardPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: PreviewCardPrimitive.Positioner.Props["alignOffset"];
}) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="z-50"
        data-slot="preview-card-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PreviewCardPrimitive.Popup
          className={cn(
            "outline-none transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0",
            className,
          )}
          data-slot="preview-card-popup"
          {...props}
        >
          {children}
        </PreviewCardPrimitive.Popup>
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { PreviewCard, PreviewCardContent, PreviewCardTrigger };
