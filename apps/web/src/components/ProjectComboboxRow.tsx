import type { MouseEvent, PointerEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { CheckboxMark } from "./ui/checkbox";

/**
 * A project row's icon slot in a combobox, with the machine badge on its corner. With `selection`,
 * a checkbox takes the icon's place on the highlighted row and stays while the row is checked.
 * Touch has no hover, so it always shows the checkbox. Render it after the name: it moves itself
 * first, so the option reads "name, On machine".
 */
export function ProjectRowLeading(props: {
  readonly icon: ReactNode;
  readonly machine?: ReactNode;
  readonly selection?:
    | {
        readonly checked: boolean;
        readonly onToggle: () => void;
      }
    | undefined;
}) {
  const { selection } = props;
  // The badge covers part of the checkbox, so it toggles too instead of picking the row.
  const toggleHandlers = selection
    ? {
        onPointerDown: (event: PointerEvent) => event.stopPropagation(),
        onMouseDown: (event: MouseEvent) => event.preventDefault(),
        onClick: (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          selection.onToggle();
        },
      }
    : {};
  return (
    <span className="relative order-first mr-1 grid shrink-0">
      <span
        className={cn(
          "col-start-1 row-start-1 flex",
          selection &&
            (selection.checked
              ? "invisible"
              : "pointer-coarse:invisible pointer-fine:in-data-highlighted:invisible"),
        )}
      >
        {props.icon}
      </span>
      {selection ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className={cn(
            "col-start-1 row-start-1 flex cursor-pointer items-center justify-center",
            !selection.checked &&
              "invisible pointer-coarse:visible pointer-fine:in-data-highlighted:visible",
          )}
          {...toggleHandlers}
        >
          <CheckboxMark checked={selection.checked} />
        </button>
      ) : null}
      {props.machine ? (
        <span
          className={cn("absolute -right-1.5 -bottom-1 z-10 flex", selection && "cursor-pointer")}
          {...toggleHandlers}
        >
          {props.machine}
        </span>
      ) : null}
    </span>
  );
}

/** Settings shows only on the highlighted row; the pin keeps the far-right column. */
export function ProjectRowActions(props: {
  readonly settings?: ReactNode;
  readonly pin?: ReactNode;
}) {
  return (
    <span className="ml-auto flex shrink-0 items-center pointer-coarse:gap-5">
      {props.settings ? (
        <span className="flex pointer-fine:invisible pointer-fine:in-data-highlighted:visible">
          {props.settings}
        </span>
      ) : null}
      {props.pin ?? <span className="size-7 sm:size-6" />}
    </span>
  );
}
