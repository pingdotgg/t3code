"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "~/lib/utils";

/**
 * `mixed` renders the thumb centred on a muted track for a selection whose
 * targets disagree (the macOS mixed-state convention). It is presentational:
 * the caller still decides what a click sets, usually on for everyone.
 */
function Switch({
  className,
  size = "default",
  mixed = false,
  ...props
}: SwitchPrimitive.Root.Props & { size?: "default" | "sm"; mixed?: boolean }) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-[calc(var(--thumb-size)+2px)] w-[calc(var(--thumb-size)*2-2px)] shrink-0 cursor-pointer items-center rounded-full p-[2px] outline-none transition-[background-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input data-disabled:cursor-not-allowed data-disabled:opacity-64 data-[mixed]:bg-input",
        size === "sm"
          ? "[--thumb-size:--spacing(4)] sm:[--thumb-size:--spacing(3.5)]"
          : "[--thumb-size:--spacing(5)] sm:[--thumb-size:--spacing(4)]",
        className,
      )}
      data-size={size}
      data-slot="switch"
      data-mixed={mixed ? "" : undefined}
      aria-checked={mixed ? "mixed" : undefined}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-[calc(var(--thumb-size)-2px)] shrink-0 origin-left in-[[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:not-data-disabled:scale-x-110 in-[[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.1)] rounded-(--thumb-size) bg-background shadow-sm/5 will-change-transform [transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s] data-checked:origin-right data-checked:translate-x-[calc(var(--thumb-size)-4px)]",
          mixed &&
            "translate-x-[calc((var(--thumb-size)-4px)/2)] opacity-70 data-checked:translate-x-[calc((var(--thumb-size)-4px)/2)]",
        )}
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
