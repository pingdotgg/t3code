import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

import { cn } from "~/lib/utils";
import { definePluginComponent } from "~/plugins/features";

const Collapsible = definePluginComponent(
  "component:components/ui/collapsible/Collapsible",
  PluginOriginalCollapsible,
);
const CollapsibleTrigger = definePluginComponent(
  "component:components/ui/collapsible/CollapsibleTrigger",
  PluginOriginalCollapsibleTrigger,
);
const CollapsiblePanel = definePluginComponent(
  "component:components/ui/collapsible/CollapsiblePanel",
  PluginOriginalCollapsiblePanel,
);

function PluginOriginalCollapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function PluginOriginalCollapsibleTrigger({
  className,
  ...props
}: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      className={cn("cursor-pointer", className)}
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

function PluginOriginalCollapsiblePanel({
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
