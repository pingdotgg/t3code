"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "~/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-[calc(var(--thumb-size)+2px)] w-[calc(var(--thumb-size)*2-2px)] shrink-0 cursor-pointer items-center rounded-full p-px outline-none transition-[background-color,box-shadow] duration-200 [--thumb-size:--spacing(5)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input data-disabled:cursor-not-allowed data-disabled:opacity-64 sm:[--thumb-size:--spacing(4)]",
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block aspect-square size-[14px] origin-left ml-[2px] rounded-(--thumb-size) bg-white shadow-sm/10 will-change-transform in-[[role=switch]:hover,[data-slot=label]:hover,[data-slot=field-label]:hover,[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:not-data-disabled:scale-x-115 in-[[role=switch]:hover,[data-slot=label]:hover,[data-slot=field-label]:hover,[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.1)] [transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s] data-checked:origin-[var(--thumb-size)_50%] data-checked:translate-x-[calc(var(--thumb-size)-5px)]",
        )}
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
