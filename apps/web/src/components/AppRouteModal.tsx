import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { T, useGT } from "gt-react";
import { XIcon } from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { getCommandPaletteOpener } from "../commandPaletteStore";
import { useNativeTitlebarHeight } from "../lib/windowControlsOverlay";
import { requestWorkspaceFocus } from "../lib/workspaceFocus";
import { useCloseAppModal } from "./sidebar/mainAppLocation";
import { GlobalVoiceInputIndicator } from "./chat/GlobalVoiceInputIndicator";
import { Button } from "./ui/button";
import { DialogBackdrop } from "./ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Past this much travel a press in the titlebar band is a window drag, not a dismissing click.
const TITLEBAR_DRAG_THRESHOLD_PX = 4;

/**
 * Large modal for the Settings and Usage routes. Esc, the close button, or a press on the
 * backdrop returns to the page that opened it. Keyboard guards that skip dialogs exempt
 * `[data-app-modal]`, because these pages own their shortcuts.
 */
export function AppRouteModal({ label, children }: { label: string; children: ReactNode }) {
  const closeAppModal = useCloseAppModal();
  const [open, setOpen] = useState(true);
  // Text selection that ends on the backdrop is not a dismissal.
  const backdropPressRef = useRef(false);
  // Where a press in the native titlebar band began, until it ends; `moving` once it is a drag.
  const titlebarPressRef = useRef<{ x: number; y: number; moving: boolean } | null>(null);
  // Focus the surface, not its first control: no stray focus ring, no phone keyboard.
  // On close, return focus to the opener only after a keyboard close; after a pointer close it
  // would paint a focus ring.
  const popupRef = useRef<HTMLDivElement>(null);
  const [opener] = useState(
    () =>
      getCommandPaletteOpener() ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null),
  );
  // Clear the native window controls (macOS traffic lights, the Windows and Linux caption
  // buttons). Below sm the modal fills the window and leaves that strip empty; up to lg its
  // 1.5rem inset is shorter than the strip.
  const nativeTitlebarHeight = useNativeTitlebarHeight();
  const nativeTitlebarDragBand =
    window.desktopBridge !== undefined && typeof window.desktopBridge.dragWindow !== "function";

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
        <DialogBackdrop />
        <DialogPrimitive.Viewport
          style={
            {
              "--app-modal-titlebar-height": `${nativeTitlebarHeight}px`,
              "--app-modal-top-inset": `max(env(safe-area-inset-top), ${nativeTitlebarHeight}px)`,
              "--app-modal-sm-top": `max(1.5rem, ${nativeTitlebarHeight}px)`,
            } as CSSProperties
          }
          // Electron hit-tests drag regions under the backdrop regardless of z-index, and a drag
          // region takes the click too. So the backdrop is no-drag and moves the window itself:
          // a click above the modal dismisses it, a drag in the titlebar band moves the window.
          // Only a drag region moves a Wayland window, so there the band below gives up the click.
          className="fixed inset-0 z-50 flex items-center justify-center [-webkit-app-region:no-drag] sm:p-6 sm:pt-(--app-modal-sm-top) lg:p-10"
          onPointerDown={(event) => {
            backdropPressRef.current = event.target === event.currentTarget;
            const dragWindow = window.desktopBridge?.dragWindow;
            if (
              !backdropPressRef.current ||
              event.button !== 0 ||
              event.clientY >= nativeTitlebarHeight ||
              typeof dragWindow !== "function"
            ) {
              return;
            }
            const press = { x: event.screenX, y: event.screenY, moving: false };
            titlebarPressRef.current = press;
            event.currentTarget.setPointerCapture(event.pointerId);
            // A window that cannot move (fullscreen, maximized) keeps the press a plain click.
            void dragWindow("start").then((movable) => {
              if (!movable && titlebarPressRef.current === press) titlebarPressRef.current = null;
            });
          }}
          onPointerMove={(event) => {
            const press = titlebarPressRef.current;
            if (!press) return;
            if (!press.moving) {
              const distance = Math.hypot(event.screenX - press.x, event.screenY - press.y);
              if (distance < TITLEBAR_DRAG_THRESHOLD_PX) return;
              press.moving = true;
              backdropPressRef.current = false;
            }
            void window.desktopBridge?.dragWindow?.("move");
          }}
          onLostPointerCapture={() => {
            titlebarPressRef.current = null;
          }}
          onClick={(event) => {
            if (backdropPressRef.current && event.target === event.currentTarget) setOpen(false);
            backdropPressRef.current = false;
          }}
        >
          {/* Electron applies regions in DOM order: after the no-drag viewport, before the popup. */}
          {nativeTitlebarDragBand ? (
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 h-(--app-modal-titlebar-height) [-webkit-app-region:drag]"
            />
          ) : null}
          <DialogPrimitive.Popup
            ref={popupRef}
            initialFocus={popupRef}
            finalFocus={(closeType) => {
              if (closeType !== "keyboard" || !opener?.isConnected) return false;
              if (!opener.closest("[inert]")) return opener;
              // The thread behind the modal stays inert until the route closes, so its area
              // takes focus once it is usable again.
              const area = opener.closest<HTMLElement>("[data-workspace-area]");
              if (area?.dataset.workspaceArea)
                requestWorkspaceFocus({ area: area.dataset.workspaceArea });
              return false;
            }}
            aria-label={label}
            data-slot="dialog-popup"
            data-app-modal=""
            className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background max-sm:pt-(--app-modal-top-inset) max-sm:pb-safe text-foreground outline-none transition-[opacity,scale] duration-150 ease-out [-webkit-app-region:no-drag] data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-starting-style:scale-[0.985] data-starting-style:opacity-0 sm:max-h-[60rem] sm:max-w-[80rem] sm:rounded-2xl sm:border sm:shadow-2xl/40"
          >
            {/* The emptied strip still moves the window, as the titlebar it replaces does. */}
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 hidden h-(--app-modal-titlebar-height) [-webkit-app-region:drag] max-sm:block"
            />
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
