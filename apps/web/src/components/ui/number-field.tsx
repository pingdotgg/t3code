import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { MinusIcon, PlusIcon } from "lucide-react";
import * as React from "react";
import { cn } from "~/lib/utils";

export function NumberField({
  id,
  className,
  size = "default",
  ...props
}: NumberFieldPrimitive.Root.Props & {
  size?: "sm" | "default";
}): React.ReactElement {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;
  return (
    <NumberFieldPrimitive.Root
      className={cn("flex w-full flex-col items-start gap-2", className)}
      data-size={size}
      data-slot="number-field"
      id={fieldId}
      {...props}
    />
  );
}

export function NumberFieldGroup({
  className,
  ...props
}: NumberFieldPrimitive.Group.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Group
      className={cn(
        "group/number-field surface-well relative flex w-full justify-between rounded-[var(--control-radius)] text-prompt text-foreground focus-within:surface-focus has-aria-invalid:surface-invalid focus-within:has-aria-invalid:surface-invalid-focus data-disabled:pointer-events-none data-disabled:opacity-64 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="number-field-group"
      {...props}
    />
  );
}

export function NumberFieldDecrement({
  className,
  ...props
}: NumberFieldPrimitive.Decrement.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Decrement
      className={cn(
        "relative flex shrink-0 cursor-pointer items-center justify-center rounded-s-[calc(var(--control-radius)-1px)] in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] px-[calc(--spacing(3)-1px)] transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:surface-ghost-hover hover:[&_svg]:text-foreground",
        className,
      )}
      data-slot="number-field-decrement"
      {...props}
    >
      <MinusIcon />
    </NumberFieldPrimitive.Decrement>
  );
}

export function NumberFieldIncrement({
  className,
  ...props
}: NumberFieldPrimitive.Increment.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Increment
      className={cn(
        "relative flex shrink-0 cursor-pointer items-center justify-center rounded-e-[calc(var(--control-radius)-1px)] in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] px-[calc(--spacing(3)-1px)] transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:surface-ghost-hover hover:[&_svg]:text-foreground",
        className,
      )}
      data-slot="number-field-increment"
      {...props}
    >
      <PlusIcon />
    </NumberFieldPrimitive.Increment>
  );
}

export function NumberFieldInput({
  className,
  ...props
}: NumberFieldPrimitive.Input.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Input
      className={cn(
        // With a unit the value hugs it and the pair centers between the steppers.
        "group-has-[[data-slot=number-field-unit]]/number-field:ms-auto group-has-[[data-slot=number-field-unit]]/number-field:w-auto group-has-[[data-slot=number-field-unit]]/number-field:min-w-[2ch] group-has-[[data-slot=number-field-unit]]/number-field:max-w-[7ch] group-has-[[data-slot=number-field-unit]]/number-field:grow-0 group-has-[[data-slot=number-field-unit]]/number-field:pe-1 group-has-[[data-slot=number-field-unit]]/number-field:text-end group-has-[[data-slot=number-field-unit]]/number-field:field-sizing-content",
        "h-8.5 in-data-[size=sm]:h-7.5 w-full min-w-0 grow bg-transparent in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] px-[calc(--spacing(3)-1px)] text-center tabular-nums in-data-[size=sm]:leading-7.5 leading-8.5 outline-none [transition:background-color_5000000s_ease-in-out_0s] sm:h-7.5 sm:in-data-[size=sm]:h-6.5 sm:in-data-[size=sm]:leading-8.5 sm:leading-7.5",
        className,
      )}
      data-slot="number-field-input"
      {...props}
    />
  );
}

/** A dim unit after the value ("sec", "days"), placed between the input and the increment. */
export function NumberFieldUnit({
  className,
  ...props
}: React.ComponentProps<"span">): React.ReactElement {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none me-auto self-center pe-1.5 text-meta text-dim-foreground",
        className,
      )}
      data-slot="number-field-unit"
      {...props}
    />
  );
}

export { NumberFieldPrimitive };
