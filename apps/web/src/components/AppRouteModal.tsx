import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { T, useGT } from "gt-react";
import { XIcon } from "lucide-react";
import { useRef, useState, type ComponentProps, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { useCloseAppModal } from "./sidebar/mainAppLocation";
import { GlobalVoiceInputIndicator } from "./chat/GlobalVoiceInputIndicator";
import { Button } from "./ui/button";
import { DialogBackdrop } from "./ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Large modal for Settings, Usage and Orbit; Esc, close or a backdrop press returns to the opener.
 * Keyboard guards that skip dialogs exempt `[data-app-modal]`. Its fill (`--shell-modal-fill`)
 * ignores the macOS glass thinning of `--shell-fill`, so a bright page behind it cannot tint it.
 */
export function AppRouteModal({ label, children }: { label: string; children: ReactNode }) {
  const closeAppModal = useCloseAppModal();
  const [open, setOpen] = useState(true);
  // Text selection that ends on the backdrop is not a dismissal.
  const backdropPressRef = useRef(false);
  // Focus the surface, not its first control: no stray focus ring, no phone keyboard.
  // On close, leave focus alone; returning it to the opener paints a focus ring.
  const popupRef = useRef<HTMLDivElement>(null);

  return (
    <DialogPrimitive.Root
      open={open}
      // Portaled layers outside this tree (toasts, Clerk, confirm dialogs) are not backdrop presses.
      disablePointerDismissal
      onOpenChange={(nextOpen, eventDetails) => {
        if (nextOpen) return;
        // Esc from a layer outside Base UI (Clerk's modals) is that layer's to handle.
        const target = eventDetails.event.target;
        if (
          eventDetails.reason === "escape-key" &&
          target !== document.body &&
          target instanceof Node &&
          !popupRef.current?.contains(target)
        ) {
          return eventDetails.cancel();
        }
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
      <DialogPrimitive.Portal>
        <DialogBackdrop variant="app" />
        <DialogPrimitive.Viewport
          // Electron hit-tests drag regions under the backdrop regardless of z-index; without
          // this, presses above the modal move the window instead of dismissing it.
          className="fixed inset-0 z-50 flex items-center justify-center [-webkit-app-region:no-drag] sm:p-6 lg:p-10"
          onPointerDown={(event) => {
            backdropPressRef.current = event.target === event.currentTarget;
          }}
          onClick={(event) => {
            if (backdropPressRef.current && event.target === event.currentTarget) setOpen(false);
            backdropPressRef.current = false;
          }}
        >
          <DialogPrimitive.Popup
            ref={popupRef}
            initialFocus={popupRef}
            finalFocus={false}
            aria-label={label}
            data-slot="dialog-popup"
            data-app-modal=""
            className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-(--shell-modal-fill) backdrop-blur-(--shell-blur) backdrop-saturate-(--shell-saturate) max-sm:pt-safe max-sm:pb-safe text-foreground outline-none transition-[opacity,scale] duration-100 ease-out [-webkit-app-region:no-drag] data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-starting-style:scale-[0.985] data-starting-style:opacity-0 sm:max-h-[60rem] sm:max-w-[80rem] sm:rounded-(--window-radius) sm:border sm:shadow-2xl/40"
          >
            {children}
            <GlobalVoiceInputIndicator />
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function AppRouteModalClose() {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DialogPrimitive.Close
            aria-label={gt("Close")}
            render={<Button size="icon-sm" variant="ghost" />}
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <T>Close (Esc)</T>
      </TooltipPopup>
    </Tooltip>
  );
}

/** Transparent 44px header over the frosted frame, like the chat header (Conn shell). */
export function AppRouteModalHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      className={cn(
        "relative z-10 flex h-(--shell-header-height) shrink-0 items-center gap-3 ps-5 pe-(--workspace-controls-right) [--control-radius:9999px]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Inset nav panel on the card's left, like the thread panel beside the chat: its left corners
 * follow the shell curve and one divider joins it to the card.
 */
export const APP_ROUTE_MODAL_NAV_CLASS =
  "ms-(--shell-inset) mb-(--shell-inset) overflow-hidden rounded-ss-(--shell-corner) rounded-es-(--shell-corner) border-e border-(--shell-divider)! shell-inner-panel";

/**
 * Inset content card under the header, the same card as the chat. Beside a nav panel only its
 * right corners round, so they match the nav panel's left corners.
 */
export function AppRouteModalCard({
  className,
  besideNav = false,
  ...props
}: ComponentProps<"div"> & { besideNav?: boolean }) {
  return (
    <div
      data-shell-join-left={besideNav ? "" : undefined}
      className={cn(
        "relative z-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden me-(--shell-inset) mb-(--shell-inset) rounded-se-(--shell-corner) rounded-ee-(--shell-corner) shell-inner-panel [--background:var(--shell-card)]",
        !besideNav && "ms-(--shell-inset) rounded-ss-(--shell-corner) rounded-es-(--shell-corner)",
        className,
      )}
      {...props}
    />
  );
}
