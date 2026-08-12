"use client";

import type { ButtonHTMLAttributes, HTMLAttributes } from "react";

import { cn } from "~/lib/utils";

function SegmentedTabList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "inline-flex w-fit items-center gap-0.5 rounded-lg bg-muted/45 p-0.5",
        className,
      )}
      role="group"
      {...props}
    />
  );
}

function SegmentedTab({
  selected,
  density = "default",
  className,
  ...props
}: {
  selected: boolean;
  density?: "default" | "compact";
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed">) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center rounded-md font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        density === "compact" ? "h-5 px-2 text-[11px]" : "h-6 px-2.5 text-xs",
        selected
          ? "bg-accent text-foreground shadow-xs/5"
          : "text-muted-foreground hover:bg-accent/45 hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { SegmentedTab, SegmentedTabList };
