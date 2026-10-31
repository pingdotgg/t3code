import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "~/lib/utils";

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      className={cn("flex flex-col gap-3", className)}
      data-slot="radio-group"
      {...props}
    />
  );
}

function Radio({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      className={cn(
        "surface-well data-checked:bg-none data-checked:shadow-none data-indeterminate:bg-none data-indeterminate:shadow-none relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-full outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-invalid:surface-invalid data-disabled:opacity-64 sm:size-4",
        className,
      )}
      data-slot="radio"
      {...props}
    >
      <RadioPrimitive.Indicator
        className="-inset-px absolute flex size-4.5 items-center justify-center rounded-full before:size-2 before:rounded-full before:bg-primary-foreground in-aria-invalid:[box-shadow:inset_0_0_0_1px_var(--error),var(--lit-shadow)]! data-unchecked:hidden data-checked:surface-gloss-on sm:size-4 sm:before:size-1.5 in-[[data-slot=radio]:focus-visible]:outline-2 in-[[data-slot=radio]:focus-visible]:outline-solid in-[[data-slot=radio]:focus-visible]:-outline-offset-2 in-[[data-slot=radio]:focus-visible]:outline-inherit"
        data-slot="radio-indicator"
      />
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, Radio, Radio as RadioGroupItem };
