import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const toggleVariants = cva(
  "[&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border text-label text-foreground outline-none pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64 aria-disabled:opacity-64 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        compact:
          "h-7 min-w-7 rounded-md px-[calc(--spacing(1)-1px)] text-meta [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-9 min-w-9 px-[calc(--spacing(2)-1px)] sm:h-8 sm:min-w-8",
        tile: "h-14 min-w-14 px-[calc(--spacing(2.5)-1px)]",
        lg: "h-10 min-w-10 px-[calc(--spacing(2.5)-1px)] sm:h-9 sm:min-w-9",
        segmented:
          "h-6 min-w-0 rounded-item px-2.5 text-label [&_svg:not([class*='size-'])]:[scale:calc(13/18)] sm:[&_svg:not([class*='size-'])]:[scale:calc(13/16)]",
        sm: "h-8 min-w-8 px-[calc(--spacing(1.5)-1px)] sm:h-7 sm:min-w-7",
      },
      variant: {
        "segmented-flat":
          "border-transparent rounded-row text-muted-foreground hover:text-foreground data-pressed:[background:var(--raised-fill)] data-pressed:text-foreground",
        // Chrome-less like an icon button: a muted icon, the hover fill, and
        // the selected fill while pressed.
        default:
          "border-transparent [&_svg:not([class*='text-'])]:text-muted-foreground hover:surface-ghost-hover hover:[&_svg:not([class*='text-'])]:text-foreground data-pressed:surface-selected data-pressed:text-strong-foreground data-pressed:[&_svg:not([class*='text-'])]:text-foreground",
        ghost:
          "border-transparent rounded-[var(--control-radius)] text-foreground [&_svg:not([class*='text-'])]:text-muted-foreground hover:surface-ghost-hover hover:[&_svg:not([class*='text-'])]:text-foreground data-pressed:surface-selected data-pressed:text-foreground data-pressed:[&_svg:not([class*='text-'])]:text-foreground disabled:opacity-100 disabled:text-muted-foreground",
        outline:
          "surface-well rounded-item text-dim-foreground hover:text-foreground data-pressed:surface-raised data-pressed:text-foreground",
        // An item of the segmented control: muted until pressed, then raised.
        segmented:
          "border-transparent text-muted-foreground transition-colors hover:text-foreground data-pressed:surface-raised data-pressed:text-foreground",
      },
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      className={cn(toggleVariants({ className, size, variant }))}
      data-slot="toggle"
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
