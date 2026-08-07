import type { ComponentProps } from "react";
import { ChevronDownIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SelectTrigger } from "../ui/select";

const composerControlClassName =
  "h-7 min-h-7 gap-1.5 px-2.5 text-secondary-label transition-none hover:text-foreground [&_svg[data-composer-control-icon]]:mx-0 [&_svg[data-composer-control-chevron]]:-mx-0.5";

export function ComposerControl({
  className,
  size = "sm",
  variant = "ghost",
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn(composerControlClassName, className)}
      size={size}
      variant={variant}
      {...props}
    />
  );
}

export function ComposerControlIcon({
  icon: Icon,
  className,
  opticalSize = "default",
}: {
  icon: LucideIcon;
  className?: string | undefined;
  opticalSize?: "default" | "large";
}) {
  return (
    <Icon
      aria-hidden="true"
      className={cn("shrink-0", opticalSize === "large" ? "size-4.5" : "size-4", className)}
      data-composer-control-icon
    />
  );
}

export function ComposerControlChevron() {
  return (
    <ChevronDownIcon
      aria-hidden="true"
      className="-mx-0.5 size-3.5 shrink-0 text-icon-muted"
      data-composer-control-chevron
      strokeWidth={2.25}
    />
  );
}

export function ComposerSelectControl({
  className,
  size = "sm",
  variant = "ghost",
  ...props
}: ComponentProps<typeof SelectTrigger>) {
  return (
    <SelectTrigger
      className={cn(composerControlClassName, className)}
      icon={<ComposerControlChevron />}
      size={size}
      variant={variant}
      {...props}
    />
  );
}
