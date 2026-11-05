import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * A project row's icon slot. With `selection`, the icon toggles the project: a checked one wears a
 * small check, and an unchecked one shows an empty ring there on the highlighted row (always on touch).
 */
export function ProjectRowLeading(props: {
  readonly icon: ReactNode;
  readonly selection?:
    | {
        readonly checked: boolean;
        readonly onToggle: () => void;
      }
    | undefined;
}) {
  const { selection } = props;
  if (!selection) return <span className="flex shrink-0 pointer-coarse:mr-2">{props.icon}</span>;
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
        selection.onToggle();
      }}
    >
      <span className="relative flex">
        {props.icon}
        <span
          className={cn(
            "pointer-events-none absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full",
            selection.checked
              ? "bg-primary group-hover/toggle:brightness-125"
              : "invisible border border-foreground/50 bg-popover group-hover/toggle:border-primary group-hover/toggle:bg-primary/40 pointer-coarse:visible pointer-fine:in-data-highlighted:visible",
          )}
        >
          {selection.checked ? (
            <CheckIcon className="size-2 text-primary-foreground" strokeWidth={4} aria-hidden />
          ) : null}
        </span>
      </span>
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
