import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ComposerMenuSegments({ onKeyDown, ...props }: MenuPrimitive.RadioGroup.Props) {
  return (
    <MenuPrimitive.RadioGroup
      {...props}
      className="flex gap-0.5 rounded-lg bg-input/40 p-0.5"
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || (event.key !== "ArrowLeft" && event.key !== "ArrowRight"))
          return;
        // Left/Right stay in this row; Up/Down navigate the surrounding menu.
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            '[role="menuitemradio"]:not([aria-disabled="true"])',
          ),
        );
        const index = items.findIndex((item) => item === document.activeElement);
        const next = items[index + (event.key === "ArrowRight" ? 1 : -1)];
        if (index < 0 || !next) return;
        event.preventDefault();
        event.stopPropagation();
        next.focus();
      }}
    />
  );
}

export function ComposerMenuSegment({
  label,
  description,
  children,
  ...props
}: MenuPrimitive.RadioItem.Props & { label: string; description?: string | undefined }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <MenuPrimitive.RadioItem
            {...props}
            label={label}
            aria-label={label}
            aria-description={description}
            className="flex h-6 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1 rounded-md px-1 text-muted-foreground text-xs outline-none data-checked:bg-input/72 data-checked:text-foreground data-highlighted:text-foreground not-data-checked:data-highlighted:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-disabled:pointer-events-none data-disabled:opacity-64"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup role="tooltip">
        <span className="grid gap-0.5">
          <span className="font-medium">{label}</span>
          {description ? <span>{description}</span> : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
