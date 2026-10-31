import { mergeProps } from "@base-ui/react/merge-props";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useRender } from "@base-ui/react/use-render";
import type { ComponentType, SVGProps } from "react";

import { cn } from "~/lib/utils";

export type ComposerControlSize = "sm" | "xs";
export type ComposerControlVariant = "toolbar" | "settings";

/**
 * The composer toolbar's control look. `sm` is the expanded toolbar; `xs` is the quiet 22px chip in
 * the tray row. `aria-pressed` marks a toggle that is on (plan mode).
 */
function composerControlClassName(
  size: ComposerControlSize,
  className?: string,
  variant: ComposerControlVariant = "toolbar",
) {
  return cn(
    "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-(--control-radius) border border-transparent text-base outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-disabled:pointer-events-none data-disabled:opacity-64 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&:active:not([aria-haspopup])]:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:-mx-0.5 [&_svg[data-composer-control-icon]]:mx-0",
    "[&_:is([data-composer-control-label],[data-chat-provider-model-picker-label])]:[text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:[&_:is([data-composer-control-label],[data-chat-provider-model-picker-label])]:py-1.5",
    size === "xs"
      ? "h-7 gap-1.25 has-[[data-composer-label]]:gap-1.5 px-2 font-medium text-muted-foreground text-xs hover:text-foreground sm:h-5.5 [&_svg]:mx-0 [&_svg:not([class*='size-'])]:size-3 has-[svg[data-composer-chevron]]:pe-1.25"
      : "h-7 gap-1.5 px-2.5 font-medium text-secondary-label [&_svg:not([class*='text-'])]:text-muted-foreground hover:text-foreground sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
    "aria-pressed:surface-selected-soft aria-pressed:text-strong-foreground aria-pressed:hover:surface-ghost-hover",
    variant === "settings"
      ? "surface-raised text-foreground hover:surface-raised-hover data-pressed:surface-raised-hover"
      : "hover:surface-ghost-hover data-pressed:surface-ghost-hover",
    // Settings rows set it beside `SelectTrigger size="sm"`, so it takes the same heights.
    variant === "settings" && size === "sm" && "h-8 sm:h-7",
    className,
  );
}

type ComposerControlProps = useRender.ComponentProps<"button"> & {
  size?: ComposerControlSize;
  variant?: ComposerControlVariant;
};

export function ComposerControl({
  className,
  size = "sm",
  variant = "toolbar",
  render,
  ...props
}: ComposerControlProps) {
  const defaultProps = {
    className: composerControlClassName(size, className, variant),
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export function ComposerControlIcon({
  icon: Icon,
  className,
  opticalSize = "default",
  size = "sm",
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  className?: string | undefined;
  opticalSize?: "default" | "large";
  size?: ComposerControlSize;
}) {
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "shrink-0",
        size === "xs" ? "size-3" : opticalSize === "large" ? "size-4.5" : "size-4",
        className,
      )}
      data-composer-control-icon
    />
  );
}

export function ComposerSelectControl({
  className,
  children,
  size = "sm",
  ...props
}: Omit<SelectPrimitive.Trigger.Props, "className"> & {
  className?: string | undefined;
  size?: ComposerControlSize;
}) {
  return (
    <SelectPrimitive.Trigger className={composerControlClassName(size, className)} {...props}>
      {children}
    </SelectPrimitive.Trigger>
  );
}
