import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

const buttonVariants = cva(
  "[--control-icon-color:currentColor] kbd-in-control [&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border text-label outline-none transition-[box-shadow,scale] [&:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:will-change-[scale] [&:active:not([aria-haspopup])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        compact:
          "h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-meta before:rounded-[calc(var(--radius-md)-1px)] [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
        standard: "h-7 gap-1.5 px-[calc(--spacing(3)-1px)] text-[0.8125rem]",
        notice: "h-6.5 gap-1.5 px-[calc(--spacing(3)-1px)] text-meta",
        icon: "size-9 sm:size-8",
        "icon-micro":
          "size-5 rounded-sm p-0 before:rounded-[calc(var(--radius-sm)-1px)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-8 sm:size-7 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm-pill":
          "size-8 rounded-full before:rounded-full sm:size-7 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs":
          "size-7 sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        micro:
          "h-5 gap-1 rounded-sm px-[calc(--spacing(1.5)-1px)] text-caption before:rounded-[calc(var(--radius-sm)-1px)] [&_svg:not([class*='size-'])]:size-3 sm:[&_svg:not([class*='size-'])]:size-3",
        multiline:
          "min-h-9 px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] whitespace-normal sm:min-h-8",
        sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7 [&_svg:not([class*='size-'])]:[scale:calc(14/18)] sm:[&_svg:not([class*='size-'])]:[scale:calc(14/16)]",
        "sm-pill":
          "h-8 gap-1.5 rounded-full px-2.5 before:rounded-full sm:h-7 [&_svg:not([class*='size-'])]:[scale:calc(14/18)] sm:[&_svg:not([class*='size-'])]:[scale:calc(14/16)]",
        "sm-multiline":
          "min-h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] whitespace-normal sm:min-h-7",
        xs: "h-7 gap-1 px-[calc(--spacing(2)-1px)] text-meta sm:h-6 [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        // Primary: the lit recipe.
        default:
          "surface-lit focus-visible:[--surface-rim:var(--lit-fill)] kbd-on-lit text-primary-foreground [:hover,[data-pressed]]:surface-lit-hover",
        destructive:
          "surface-destructive focus-visible:[--surface-rim:var(--surface-fill)] kbd-on-destructive text-destructive-fill-foreground [:hover,[data-pressed]]:surface-destructive-hover",
        // Destructive-secondary: raised, red label, a red rim on hover.
        "destructive-outline":
          "surface-raised focus-visible:[--surface-rim:var(--surface-fill)] text-destructive-foreground [:hover,[data-pressed]]:surface-danger-hover",
        // Icon buttons and ghost rows stay chrome-less: a hover fill, and the
        // muted icon brightens to the label color.
        ghost:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground [:hover,[data-pressed]]:surface-ghost-hover [:hover,[data-pressed]]:[--control-icon-color:currentColor]",
        "ghost-muted":
          "[--control-icon-color:currentColor] border-transparent text-muted-foreground [:hover,[data-pressed]]:surface-ghost-hover [:hover,[data-pressed]]:text-foreground",
        // Icon only, no surface at any state: hover brightens the muted icon.
        // For controls sitting on a shape that already frames them.
        bare: "[--control-icon-color:currentColor] border-transparent text-muted-foreground [:hover,[data-pressed]]:text-foreground",
        "ghost-destructive":
          "[--control-icon-color:currentColor] border-transparent text-muted-foreground [:hover,[data-pressed]]:surface-ghost-hover [:hover,[data-pressed]]:text-destructive-foreground",
        // Floats over content: a solid round chip.
        floating:
          "bg-background [--control-icon-color:var(--contrast-muted-foreground)] rounded-full border-border/60 text-foreground shadow-sm before:rounded-full [:hover,[data-pressed]]:border-border",
        link: "border-transparent underline-offset-4 [:hover,[data-pressed]]:underline",
        "media-close":
          "[--control-icon-color:currentColor] border-transparent bg-black/65 text-white shadow-sm ring-1 ring-white/20 [:hover,[data-pressed]]:bg-black/80 focus-visible:outline-white",
        "media-navigation":
          "[--control-icon-color:currentColor] absolute top-1/2 z-20 -translate-y-1/2 border-transparent text-white/90 [:hover,[data-pressed]]:bg-white/10 [:hover,[data-pressed]]:text-white focus-visible:outline-white",
        overlay: "border-transparent bg-black/70 text-white/65 [:hover,[data-pressed]]:bg-black/90",
        pill: "surface-pill [--pill-fill:var(--ss-default-pill-fill)] [--pill-foreground:var(--ss-default-pill-foreground)] [--pill-icon:var(--ss-default-pill-icon)] [--pill-rim:var(--ss-default-pill-rim,var(--ss-default-raised-rim))] [--pill-shadow:var(--ss-default-pill-shadow)] text-foreground [:hover,[data-pressed]]:surface-raised-hover",
        // Secondary: the raised recipe.
        secondary:
          "surface-raised focus-visible:[--surface-rim:var(--surface-fill)] text-foreground [:hover,[data-pressed]]:surface-raised-hover",
        "warning-outline":
          "surface-tint [--surface-tint:var(--warning-foreground)] text-warning-foreground [:hover,[data-pressed]]:[--surface-tint:color-mix(in_srgb,var(--warning-foreground),var(--foreground)_20%)]",
      },
    },
  },
);

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

// Controls framed by their content use inset focus rather than the standard
// button's rim, border and press animation.
const contentButtonVariants = cva("outline-none", {
  variants: {
    variant: {
      transport:
        "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-row text-white hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70",
      "selection-card":
        "cursor-pointer overflow-hidden rounded-card border border-transparent text-left transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-settings-effective-fill not-aria-pressed:surface-card-settings-rim not-aria-pressed:hover:surface-ghost-hover aria-pressed:shadow-[inset_0_0_0_1px_var(--settings-active-rim)]",
      "drag-chip":
        "flex h-6.5 cursor-grab items-center gap-1.5 rounded-item surface-raised px-2.25 text-meta text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing",
      panel:
        "flex flex-col overflow-hidden rounded-item bg-background text-start focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-expanded:ring-1 aria-expanded:ring-inset aria-expanded:ring-strong-foreground/70",
      "action-row":
        "flex h-7.5 items-center gap-2 rounded-control px-2 text-start text-label text-foreground hover:surface-ghost-hover focus-visible:surface-ghost-hover disabled:pointer-events-none disabled:opacity-64",
      "action-row-destructive":
        "flex h-7.5 items-center gap-2 rounded-control px-2 text-start text-label text-destructive-foreground hover:surface-ghost-hover focus-visible:surface-ghost-hover disabled:pointer-events-none disabled:opacity-64",
      tab: "inline-flex h-7 min-w-0 max-w-80 cursor-pointer items-center gap-1.75 rounded-control px-2.5 text-left text-control text-muted-foreground [-webkit-app-region:no-drag] hover:surface-ghost-hover hover:text-foreground focus-visible:inset-ring-2 focus-visible:inset-ring-ring",
      "tab-close":
        "flex size-4 cursor-pointer items-center justify-center rounded-kbd text-foreground opacity-0 [-webkit-app-region:no-drag] hover:opacity-100 focus-visible:opacity-100 focus-visible:inset-ring-2 focus-visible:inset-ring-ring",
    },
  },
});

/** Inset controls whose content supplies their frame, without standard button chrome. */
export function ContentButton({
  className,
  variant,
  render,
  ...props
}: useRender.ComponentProps<"button"> & VariantProps<typeof contentButtonVariants>) {
  const defaultProps = {
    type: render ? undefined : ("button" as const),
    className: cn(contentButtonVariants({ variant }), className),
    "data-slot": "content-button",
  };
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(defaultProps, props),
  });
}

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    "data-slot": "button",
    "data-variant": variant ?? "default",
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export { Button, buttonVariants, type ButtonSize, type ButtonVariant };

const inlineButtonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 [text-align:var(--inline-button-text-align,center)] [white-space:var(--inline-button-white-space,nowrap)] hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64",
  {
    defaultVariants: { tone: "default" },
    variants: {
      tone: {
        default: "text-foreground",
        muted: "text-muted-foreground hover:text-foreground",
        destructive: "text-destructive/80 hover:text-destructive",
        ghost:
          "rounded-kbd px-0.5 [font-weight:inherit] text-muted-foreground hover:surface-ghost-hover hover:text-foreground hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        "ghost-dim":
          "rounded-kbd px-0.5 [font-weight:inherit] text-muted-foreground/70 hover:surface-ghost-hover hover:text-foreground hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        picker:
          "gap-1.5 text-inherit [font-weight:inherit] underline decoration-current/30 decoration-dotted decoration-from-font underline-offset-4 hover:decoration-foreground hover:decoration-solid data-popup-open:decoration-foreground data-popup-open:decoration-solid",
      },
    },
  },
);

export function InlineButton({
  className,
  tone,
  render,
  ...props
}: useRender.ComponentProps<"button"> & VariantProps<typeof inlineButtonVariants>) {
  const defaultProps = {
    className: cn(inlineButtonVariants({ tone }), className),
    "data-slot": "inline-button",
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}
