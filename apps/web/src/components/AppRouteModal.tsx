import { XIcon } from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useNativeTitlebarHeight } from "../lib/windowControlsOverlay";
import { useCloseAppModal } from "./sidebar/mainAppLocation";
import { useThemeEditorStore } from "./settings/themeEditorStore";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogPopup } from "./ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Settings and Usage own their shortcuts inside `[data-app-modal]` and return to the opener. */
export function AppRouteModal({
  label,
  children,
  variant = "app",
}: {
  label: string;
  children: ReactNode;
  variant?: "app" | "app-panel";
}) {
  const closeAppModal = useCloseAppModal();
  const themeEditorOpen = useThemeEditorStore((store) => store.session !== null);
  const [open, setOpen] = useState(true);
  // Text selection that ends on the backdrop is not a dismissal.
  const backdropPressRef = useRef(false);
  // Focus the surface, not its first control: no stray focus ring, no phone keyboard.
  const popupRef = useRef<HTMLDivElement>(null);
  // Clear the native window controls (macOS traffic lights, the Windows and Linux caption
  // buttons). Below sm the modal fills the window and leaves that strip empty; up to lg its
  // 1.5rem inset is shorter than the strip.
  const nativeTitlebarHeight = useNativeTitlebarHeight();

  return (
    <Dialog
      open={open}
      // The floating editor lives outside this route and needs focus while editing.
      modal={!themeEditorOpen}
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
        variant={variant}
        showCloseButton={false}
        bottomStickOnMobile={false}
        ref={popupRef}
        initialFocus={popupRef}
        aria-label={label}
        data-app-modal=""
        viewportProps={{
          style: {
            "--app-modal-titlebar-height": `${nativeTitlebarHeight}px`,
            "--app-modal-top-inset": `max(env(safe-area-inset-top), ${nativeTitlebarHeight}px)`,
            "--app-modal-sm-top": `max(1.5rem, ${nativeTitlebarHeight}px)`,
          } as CSSProperties,
          onPointerDown: (event) => {
            backdropPressRef.current = event.target === event.currentTarget;
          },
          onClick: (event) => {
            if (backdropPressRef.current && event.target === event.currentTarget) setOpen(false);
            backdropPressRef.current = false;
          },
        }}
      >
        {/* The emptied strip still moves the window, as the titlebar it replaces does. */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 hidden h-(--app-modal-titlebar-height) [-webkit-app-region:drag] max-sm:block"
        />
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
