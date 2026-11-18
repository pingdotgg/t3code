import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

import { cn } from "~/lib/utils";

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({
  className,
  variant,
  ...props
}: CollapsiblePrimitive.Trigger.Props & { variant?: "section" | "row" }) {
  return (
    <CollapsiblePrimitive.Trigger
      className={cn(
        "cursor-pointer",
        variant === "section" && "flex w-full items-center gap-2 py-2 font-medium",
        variant === "row" && "flex w-full items-start gap-2 py-2 text-left",
        className,
      )}
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

function CollapsiblePanel({
  className,
  animate = true,
  ...props
}: CollapsiblePrimitive.Panel.Props & { animate?: boolean }) {
  return (
    <CollapsiblePrimitive.Panel
      className={cn(
        "overflow-hidden",
        animate &&
          "h-(--collapsible-panel-height) transition-[height] duration-200 motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0 data-open:data-ending-style:[height:var(--collapsible-panel-height)]",
        className,
      )}
      data-slot="collapsible-panel"
      {...props}
    />
  );
}

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsiblePanel,
  CollapsiblePanel as CollapsibleContent,
};
