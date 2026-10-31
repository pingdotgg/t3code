import { XIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { useCloseAppModal } from "./sidebar/mainAppLocation";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogPopup } from "./ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Settings and Usage own their shortcuts inside `[data-app-modal]` and return to the opener. */
export function AppRouteModal({ label, children }: { label: string; children: ReactNode }) {
  const closeAppModal = useCloseAppModal();
  const [open, setOpen] = useState(true);
  // Text selection that ends on the backdrop is not a dismissal.
  const backdropPressRef = useRef(false);
  // Focus the surface, not its first control: no stray focus ring, no phone keyboard.
  // On close, leave focus alone; returning it to the opener paints a focus ring.
  const popupRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog
      open={open}
      // Portaled layers outside this tree (toasts, Clerk, confirm dialogs) are not backdrop presses.
      disablePointerDismissal
      onOpenChange={(nextOpen) => {
        if (nextOpen) return;
        // Closing unmounts a focused field without a blur, so commit-on-blur rows would
        // drop what was typed. Blur first so they commit.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && popupRef.current?.contains(focused)) focused.blur();
        setOpen(false);
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) void closeAppModal();
      }}
    >
      <DialogPopup
        variant="app"
        showCloseButton={false}
        bottomStickOnMobile={false}
        ref={popupRef}
        initialFocus={popupRef}
        finalFocus={false}
        aria-label={label}
        data-app-modal=""
        viewportProps={{
          onPointerDown: (event) => {
            backdropPressRef.current = event.target === event.currentTarget;
          },
          onClick: (event) => {
            if (backdropPressRef.current && event.target === event.currentTarget) setOpen(false);
            backdropPressRef.current = false;
          },
        }}
      >
        {children}
      </DialogPopup>
    </Dialog>
  );
}

export function AppRouteModalClose() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DialogClose aria-label="Close" render={<Button size="icon-sm" variant="ghost" />} />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
    </Tooltip>
  );
}
