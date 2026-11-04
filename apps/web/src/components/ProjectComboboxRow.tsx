import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { CheckboxMark } from "./ui/checkbox";

/**
 * A project row's icon slot. With `selection`, a checked row marks its icon with a small check, and
 * a checkbox takes the icon's place on the highlighted row. Touch has no hover, so it always shows
 * the checkbox.
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
  return (
    <span className="grid shrink-0">
      <span
        className={cn(
          "relative col-start-1 row-start-1 flex",
          selection && "pointer-coarse:invisible pointer-fine:in-data-highlighted:invisible",
        )}
      >
        {props.icon}
        {selection?.checked ? (
          <span className="pointer-events-none absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-primary ring-2 ring-popover">
            <CheckIcon className="size-2 text-primary-foreground" strokeWidth={4} aria-hidden />
          </span>
        ) : null}
      </span>
      {selection ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className={cn(
            "invisible col-start-1 row-start-1 flex cursor-pointer items-center justify-center pointer-coarse:visible pointer-fine:in-data-highlighted:visible",
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            selection.onToggle();
          }}
        >
          <CheckboxMark checked={selection.checked} />
        </button>
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
