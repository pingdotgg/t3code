import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-badge border border-transparent outline-none transition-shadow focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
  {
    defaultVariants: {
      size: "default",
      variant: "secondary",
    },
    variants: {
      size: {
        control:
          "h-7 min-w-7 rounded-[var(--control-radius)] px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:min-w-6 sm:text-xs",
        default: "h-5.5 min-w-5.5 px-[calc(--spacing(1)-1px)] text-caption sm:h-4.5 sm:min-w-4.5",
        lg: "h-6.5 min-w-6.5 px-[calc(--spacing(1.5)-1px)] text-meta sm:h-5.5 sm:min-w-5.5",
        // Fractional leading rounds font metrics and raises fixed-height labels, especially under zoom.
        sm: "h-5 min-w-5 rounded-badge px-[calc(--spacing(1)-1px)] text-micro leading-none sm:h-4 sm:min-w-4",
        // Row status pill (sidebar thread cards): 18px tall, 5px inset (4px padding plus the
        // 1px transparent border), 10px glyph at full strength. The label keeps the row meta size.
        status:
          "h-4.5 px-[4px] text-micro leading-none [&_svg:not([class*='opacity-'])]:opacity-100 [&_svg:not([class*='size-'])]:size-2.5 sm:[&_svg:not([class*='size-'])]:size-2.5",
      },
      variant: {
        // State badges: an exact 31/255 tint of the status hue with its readable label.
        // PR states map onto them: Open success, Merged merged, Conflicts
        // warning, Closed error, Unavailable unavailable, New info, Draft
        // secondary.
        error: "bg-error-tint text-error-foreground",
        info: "bg-info-tint text-info-foreground",
        merged: "bg-merged-tint text-merged-foreground",
        outline:
          "border-border bg-transparent text-muted-foreground [button&,a&]:hover:surface-ghost-hover",
        // Neutral: the quiet fill with a muted label.
        secondary:
          "bg-badge-neutral bg-(image:--badge-neutral-fill) text-muted-foreground [button&,a&]:hover:surface-ghost-hover",
        success: "bg-success-tint text-success-foreground",
        unavailable: "bg-badge-neutral bg-(image:--badge-neutral-fill) text-dim-foreground",
        // Quieter than unavailable: the faintest neutral fill with a dim label (snoozed rows).
        quiet: "bg-badge-quiet text-dim-foreground",
        warning: "bg-warning-tint text-warning-foreground",
        // A status hue the consumer sets as --badge-tone in style: the hue as the label and a
        // 26/255 (light) or 31/255 (dark) tint of it as the fill.
        tone: "bg-[color-mix(in_srgb,var(--badge-tone)_10.2%,transparent)] text-(--badge-tone) dark:bg-[color-mix(in_srgb,var(--badge-tone)_12.2%,transparent)] [button&,a&]:hover:bg-[color-mix(in_srgb,var(--badge-tone)_20%,transparent)]",
        label:
          "bg-[color-mix(in_srgb,var(--label)_8%,transparent)] text-[color-mix(in_srgb,var(--label)_30%,var(--color-foreground))] dark:bg-[color-mix(in_srgb,var(--label)_12%,transparent)] dark:text-[color-mix(in_srgb,var(--label)_45%,var(--color-foreground))]",
      },
    },
  },
);

interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"];
  size?: VariantProps<typeof badgeVariants>["size"];
}

function Badge({ className, variant, size, render, ...props }: BadgeProps) {
  const defaultProps = {
    className: cn(badgeVariants({ className, size, variant })),
    "data-slot": "badge",
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

export { Badge, badgeVariants };
