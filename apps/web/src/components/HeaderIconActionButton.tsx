import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

import { Button } from "./ui/button";

type HeaderIconActionButtonProps = Omit<ComponentProps<typeof Button>, "size" | "variant"> & {
  pressed?: boolean | undefined;
};

export function HeaderIconActionButton({
  className,
  pressed,
  ...props
}: HeaderIconActionButtonProps) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-pressed={pressed}
      data-pressed={pressed ? "" : undefined}
      className={cn("shrink-0 [&_svg]:fill-current", className)}
      {...props}
    />
  );
}
