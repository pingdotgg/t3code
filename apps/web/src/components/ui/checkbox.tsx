"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";

import { cn } from "~/lib/utils";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-[.25rem] border border-input bg-background not-dark:bg-clip-padding shadow-xs/5 outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[3px] not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:outline-destructive/48 data-disabled:opacity-64 sm:size-4 dark:not-data-checked:bg-input/32 dark:focus-visible:aria-invalid:outline-destructive/24 dark:not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] [[data-disabled],[data-checked],[aria-invalid]]:shadow-none",
        className,
      )}
      data-slot="checkbox"
      {...props}
    >
      {/* Leave a contrasting inner gap inside the 2px focus outline. */}
      <CheckboxPrimitive.Indicator
        className="-inset-px absolute flex items-center justify-center rounded-[.25rem] text-primary-foreground data-unchecked:hidden data-checked:bg-primary data-indeterminate:text-foreground in-[[data-slot=checkbox]:focus-visible]:inset-shadow-[0_0_0_3px_var(--background)] in-[[data-slot=checkbox]:focus-visible]:outline-2 in-[[data-slot=checkbox]:focus-visible]:outline-solid in-[[data-slot=checkbox]:focus-visible]:-outline-offset-2 in-[[data-slot=checkbox]:focus-visible]:outline-inherit"
        data-slot="checkbox-indicator"
        render={(props, state) => (
          <span {...props}>
            {state.indeterminate ? (
              <svg
                className="size-3.5 sm:size-3"
                fill="none"
                height="24"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3"
                viewBox="0 0 24 24"
                width="24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M5.252 12h13.496" />
              </svg>
            ) : (
              <svg
                className="size-3.5 sm:size-3"
                fill="none"
                height="24"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3"
                viewBox="0 0 24 24"
                width="24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
              </svg>
            )}
          </span>
        )}
      />
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
