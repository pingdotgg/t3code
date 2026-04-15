import type { ComponentPropsWithoutRef } from "react";
import { forwardRef } from "react";

import { cn } from "~/lib/utils";

export type ScrollFadeEffectProps = ComponentPropsWithoutRef<"div"> & {
  orientation?: "horizontal" | "vertical";
};

export const ScrollFadeEffect = forwardRef<HTMLDivElement, ScrollFadeEffectProps>(
  ({ className, orientation = "vertical", ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-orientation={orientation}
        className={cn(
          orientation === "horizontal"
            ? "scroll-fade-effect-x overflow-x-auto overflow-y-hidden"
            : "scroll-fade-effect-y overflow-x-hidden overflow-y-auto",
          className,
        )}
        {...props}
      />
    );
  },
);

ScrollFadeEffect.displayName = "ScrollFadeEffect";
