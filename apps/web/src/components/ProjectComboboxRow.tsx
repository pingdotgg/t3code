import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * A project row's icon slot. A checked row's icon wears a small check. With `onToggle`, the icon
 * toggles the row, and an unchecked one shows an empty ring there on the highlighted row (always on
 * touch).
 */
export function ProjectRowLeading(props: {
  readonly icon: ReactNode;
  readonly checked: boolean;
  readonly onToggle?: (() => void) | undefined;
}) {
  const { checked, onToggle } = props;
  const mark = (
    <span className="relative flex">
      {props.icon}
      {checked || onToggle ? (
        <span
          className={cn(
            "pointer-events-none absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full",
            checked
              ? "bg-primary group-hover/toggle:brightness-125"
              : "invisible border border-foreground/50 bg-popover group-hover/toggle:border-primary group-hover/toggle:bg-primary/40 pointer-coarse:visible pointer-fine:in-data-highlighted:visible",
          )}
        >
          {checked ? (
            <CheckIcon className="size-2 text-primary-foreground" strokeWidth={4} aria-hidden />
          ) : null}
        </span>
      ) : null}
    </span>
  );
  if (!onToggle) return <span className="flex shrink-0 pointer-coarse:mr-2">{mark}</span>;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      className="group/toggle -m-1 flex shrink-0 cursor-pointer p-1 pointer-coarse:-my-2 pointer-coarse:mr-0 pointer-coarse:-ml-3 pointer-coarse:py-2 pointer-coarse:pr-2 pointer-coarse:pl-3"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      {mark}
    </button>
  );
}

/** Settings shows only on the highlighted row; the pin keeps the far-right column. */
export function ProjectRowActions(props: {
  readonly settings?: ReactNode;
  readonly pin?: ReactNode;
}) {
  return (
    <span className="ml-auto flex shrink-0 items-center pointer-coarse:gap-1">
      {props.settings ? (
        <span className="flex pointer-fine:invisible pointer-fine:in-data-highlighted:visible">
          {props.settings}
        </span>
      ) : null}
      {props.pin ?? <span className="size-7 sm:size-6" />}
    </span>
  );
}
