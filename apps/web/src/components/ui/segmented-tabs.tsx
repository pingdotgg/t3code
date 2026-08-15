import type { ComponentProps, HTMLAttributes } from "react";

import { cn } from "~/lib/utils";
import { Toggle } from "~/components/ui/toggle";

function SegmentedTabList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "inline-flex w-fit items-center gap-0.5 rounded-lg bg-muted/45 p-0.5",
        className,
      )}
      role="group"
      {...props}
    />
  );
}

function SegmentedTab({
  selected,
  density = "default",
  className,
  ...props
}: {
  selected: boolean;
  density?: "default" | "compact";
} & Omit<ComponentProps<typeof Toggle>, "aria-pressed" | "pressed" | "size" | "type" | "variant">) {
  return (
    <Toggle
      type="button"
      pressed={selected}
      size={density === "compact" ? "segmented-compact" : "segmented"}
      variant="segmented"
      className={className}
      {...props}
    />
  );
}

export { SegmentedTab, SegmentedTabList };
