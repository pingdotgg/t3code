import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";

import { cn } from "~/lib/utils";

const rootClassName =
  "surface-well data-checked:bg-none data-checked:shadow-none data-indeterminate:bg-none data-indeterminate:shadow-none relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-kbd outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-invalid:surface-invalid data-disabled:opacity-64 sm:size-4";

const indicatorClassName =
  "-inset-px absolute flex items-center justify-center rounded-kbd text-primary-foreground in-aria-invalid:[box-shadow:inset_0_0_0_1px_var(--error),var(--lit-shadow)]! data-unchecked:hidden data-checked:surface-gloss-on data-indeterminate:surface-gloss-on in-[[data-slot=checkbox]:focus-visible]:outline-2 in-[[data-slot=checkbox]:focus-visible]:outline-solid in-[[data-slot=checkbox]:focus-visible]:-outline-offset-2 in-[[data-slot=checkbox]:focus-visible]:outline-inherit";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      className={cn(rootClassName, className)}
      data-slot="checkbox"
      {...props}
    >
      {/* Keep an inner gap in the focus outline. Explicit glyph colors resist row icon-muting rules. */}
      <CheckboxPrimitive.Indicator
        className={indicatorClassName}
        data-slot="checkbox-indicator"
        render={(props, state) => (
          <span {...props}>
            {state.indeterminate ? (
              <MinusIcon className="size-3.5 text-current sm:size-3" />
            ) : (
              <CheckIcon className="size-3.5 text-current sm:size-3" />
            )}
          </span>
        )}
      />
    </CheckboxPrimitive.Root>
  );
}

// Checkbox's look without its hidden input, for a row that is itself the button.
function CheckboxMark({ checked }: { checked: boolean }) {
  const state = checked ? { "data-checked": "" } : { "data-unchecked": "" };
  return (
    <span aria-hidden className={rootClassName} data-slot="checkbox" {...state}>
      <span className={indicatorClassName} data-slot="checkbox-indicator" {...state}>
        <svg
          className="size-3.5 text-current sm:size-3"
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
      </span>
    </span>
  );
}

export { Checkbox, CheckboxMark };
