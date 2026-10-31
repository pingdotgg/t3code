import { PinIcon, PinOffIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "./ui/button";

/**
 * Pin toggle for a project row in a menu or list. A pinned project always shows its pin;
 * an unpinned one shows it only on the highlighted row. Keyboard users get a shortcut
 * from the list that hosts it, so the button stays out of the tab order.
 */
export function ProjectPinButton(props: {
  readonly name: string;
  readonly pinned: boolean;
  readonly onToggle: () => void;
  readonly shortcutLabel?: string | null;
}) {
  const action = `${props.pinned ? "Unpin" : "Pin"} ${props.name}`;
  return (
    <span
      className={cn(
        "group/pin ml-auto flex",
        !props.pinned && "opacity-0 in-data-highlighted:opacity-100 pointer-coarse:opacity-100",
      )}
    >
      <Button
        size="icon-xs"
        variant="ghost-muted"
        tabIndex={-1}
        aria-hidden="true"
        title={props.shortcutLabel ? `${action} (${props.shortcutLabel})` : action}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onToggle();
        }}
      >
        {props.pinned ? (
          <>
            <PinIcon className="size-3.5 group-hover/pin:hidden" />
            <PinOffIcon className="hidden size-3.5 group-hover/pin:block" />
          </>
        ) : (
          <PinIcon className="size-3.5" />
        )}
      </Button>
    </span>
  );
}
