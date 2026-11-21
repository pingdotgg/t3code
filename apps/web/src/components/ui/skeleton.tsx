import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";
import { definePluginComponent } from "~/plugins/features";

const Skeleton = definePluginComponent(
  "component:components/ui/skeleton/Skeleton",
  PluginOriginalSkeleton,
);

const skeletonVariants = cva("bg-muted-foreground/15 motion-safe:animate-skeleton", {
  variants: {
    shape: {
      block: "rounded-sm",
      card: "rounded-lg",
      pill: "rounded-full",
    },
  },
  defaultVariants: { shape: "block" },
});

function PluginOriginalSkeleton({
  className,
  shape,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof skeletonVariants>) {
  return (
    <div className={cn(skeletonVariants({ shape }), className)} data-slot="skeleton" {...props} />
  );
}

export { Skeleton };
