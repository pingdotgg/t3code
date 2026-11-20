import { MessageSquareIcon, XIcon } from "lucide-react";
import { useGT } from "gt-react";
import type { ReactNode, RefObject } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * The floating comment button at a detail's bottom corner and the popover it opens, shared by
 * pull requests and issues. The popover stays mounted so a draft outlives dismissal.
 */
export function WorkItemComposerPopover({
  open,
  onOpenChange,
  triggerLabel,
  badge,
  popupLabel,
  initialFocus,
  header,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerLabel: string;
  /** Drawn on the button's corner, such as how many review comments wait. */
  badge?: ReactNode;
  popupLabel: string;
  initialFocus: RefObject<HTMLTextAreaElement | null>;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<Button size="icon" variant="floating" />} aria-label={triggerLabel}>
        <MessageSquareIcon className="size-4" />
        {badge}
      </PopoverTrigger>
      <PopoverPopup
        keepMounted
        side="top"
        align="end"
        sideOffset={8}
        width="lg"
        initialFocus={initialFocus}
        aria-label={popupLabel}
      >
        {header}
        {children}
      </PopoverPopup>
    </Popover>
  );
}

export function WorkItemComposerClose() {
  const gt = useGT();
  return (
    <PopoverClose
      render={<Button size="icon-xs" variant="ghost" />}
      aria-label={gt("Close composer")}
    >
      <XIcon className="size-3.5" />
    </PopoverClose>
  );
}
