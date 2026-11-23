import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

const floatingToolbarVariants = cva(
  "inline-flex w-fit items-center rounded-control border surface-floating text-foreground",
  {
    defaultVariants: {
      density: "default",
      orientation: "horizontal",
    },
    variants: {
      density: {
        default: "gap-1 p-1",
        compact: "gap-0.5 p-0.5",
      },
      orientation: {
        horizontal: "flex-row",
        vertical: "flex-col",
      },
    },
  },
);

/** Control group on `surface-floating` for canvas overlays such as zoom controls. */
function FloatingToolbar({
  className,
  density,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof floatingToolbarVariants>) {
  return (
    <div
      data-orientation={orientation ?? "horizontal"}
      data-slot="floating-toolbar"
      role="group"
      className={cn(floatingToolbarVariants({ density, orientation }), className)}
      {...props}
    />
  );
}

export { FloatingToolbar };
