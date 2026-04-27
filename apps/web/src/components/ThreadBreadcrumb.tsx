import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export const THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME =
  "inline-flex min-w-0 shrink items-center gap-1.5 rounded-md border border-border/80 bg-muted/30 px-2 py-0.5 font-medium text-muted-foreground shadow-sm";
export const THREAD_BREADCRUMB_PROJECT_CHIP_INTERACTIVE_CLASS_NAME =
  "cursor-pointer transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";
export const THREAD_BREADCRUMB_PROJECT_DIVIDER_CLASS_NAME =
  "-my-0.5 w-px self-stretch bg-border/80";
export const THREAD_BREADCRUMB_SEPARATOR_ICON_CLASS_NAME =
  "size-2.5 shrink-0 fill-muted-foreground/70";

export function ThreadBreadcrumbProjectChipContent({
  icon,
  label,
  labelClassName,
}: {
  icon: ReactNode;
  label: string;
  labelClassName?: string;
}) {
  return (
    <>
      {icon}
      <span className={THREAD_BREADCRUMB_PROJECT_DIVIDER_CLASS_NAME} aria-hidden />
      <span className={cn("min-w-0 truncate", labelClassName)}>{label}</span>
    </>
  );
}
