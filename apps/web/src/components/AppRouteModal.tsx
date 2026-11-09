import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useAtomValue } from "@effect/atom-react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { useNativeTitlebarHeight } from "../lib/windowControlsOverlay";
import { PluginPart } from "../plugins/PluginPart";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { registerCommands } from "../shortcuts/dispatcher";
import {
  type AppPage,
  shownAppPageAtom,
  sidebarBackShownAtom,
  useCloseAppModal,
} from "./sidebar/mainAppLocation";
import { Button } from "./ui/button";
import { DialogBackdrop } from "./ui/dialog";
import { SidebarInset, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

// Set inside the page frame, where no dialog exists for the close button to close.
const AppRoutePageCloseContext = createContext<{
  readonly close: () => void;
  /** Drawn at the window's top as its title bar row, rather than inside a plugin's own frame. */
  readonly titleBar: boolean;
} | null>(null);
// The section list `AppRouteModalNav` draws; unset in the page frame, which hands it over.
const AppRouteNavContext = createContext<ReactNode>(null);

/**
 * Large modal for the Settings and Usage routes. Esc, the close button, or a press on the
 * backdrop returns to the page that opened it. Keyboard guards that skip dialogs exempt
 * `[data-app-modal]`, because these pages own their shortcuts. A plugin may show the page in
 * place of the thread instead (the `app.pageFrame` part), with `nav` drawn where it chooses.
 */
export function AppRouteModal({
  page,
  label,
  nav = null,
  children,
}: {
  page: AppPage;
  label: string;
  nav?: ReactNode;
  children: ReactNode;
}) {
  const closeAppModal = useCloseAppModal();
  const [open, setOpen] = useState(true);
  // Text selection that ends on the backdrop is not a dismissal.
  const backdropPressRef = useRef(false);
  // Focus the surface, not its first control: no stray focus ring, no phone keyboard.
  // On close, leave focus alone; returning it to the opener paints a focus ring.
  const popupRef = useRef<HTMLDivElement>(null);
  // Clear the native window controls (macOS traffic lights, the Windows and Linux caption
  // buttons). Below sm the modal fills the window and leaves that strip empty; up to lg its
  // 1.5rem inset is shorter than the strip.
  const nativeTitlebarHeight = useNativeTitlebarHeight();
  const content = <AppRouteNavContext value={nav}>{children}</AppRouteNavContext>;
  const close = () => void closeAppModal();

  const modal = (
    <DialogPrimitive.Root
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
          className="fixed inset-0 z-50 flex items-center justify-center sm:p-6 sm:pt-(--app-modal-sm-top) lg:p-10"
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
            className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background max-sm:pt-(--app-modal-top-inset) max-sm:pb-safe text-foreground outline-none transition-[opacity,scale] duration-150 ease-out [-webkit-app-region:no-drag] data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-starting-style:scale-[0.985] data-starting-style:opacity-0 sm:max-h-[60rem] sm:max-w-[80rem] sm:rounded-2xl sm:border sm:shadow-2xl/40"
          >
            {/* The emptied strip still moves the window, as the titlebar it replaces does. */}
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 hidden h-(--app-modal-titlebar-height) [-webkit-app-region:drag] max-sm:block"
            />
            {content}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
  return (
    <PluginPart
      part="app.pageFrame"
      pieces={{
        original: modal,
        // Outside T3's window there is no dialog for the close button to close.
        content: (
          <AppRoutePageCloseContext value={{ close, titleBar: false }}>
            {content}
          </AppRoutePageCloseContext>
        ),
        page: (
          <AppRoutePage page={page} label={label}>
            {children}
          </AppRoutePage>
        ),
        nav,
        kind: page,
        label,
        close,
      }}
    />
  );
}

/** Where a page draws its section list: nothing while the page frame hands it over. */
export function AppRouteModalNav() {
  return use(AppRouteNavContext);
}

/**
 * Settings or Usage in place of the thread, beside the sidebar. The thread stays mounted under it
 * (see `index.css`). Esc goes back unless a popup or dialog inside the page takes it.
 */
function AppRoutePage({
  page,
  label,
  children,
}: {
  page: AppPage;
  label: string;
  children: ReactNode;
}) {
  const closeAppModal = useCloseAppModal();
  const close = () => void closeAppModal();
  // Tells the sidebar which page it sits beside, for the `app.sidebar` part.
  const showPage = () => {
    appAtomRegistry.set(shownAppPageAtom, page);
    return () => appAtomRegistry.set(shownAppPageAtom, null);
  };
  const onEscape = useEffectEvent(close);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds Esc in the global shortcut dispatcher while the page is shown
  useEffect(
    () =>
      registerCommands(
        {},
        {
          observe: (event, consumed) => {
            if (consumed || event.repeat || event.isComposing || event.key !== "Escape") return;
            if (
              event.target instanceof Element &&
              event.target.closest('[role="dialog"], [role="alertdialog"], [data-slot$="popup"]')
            ) {
              return;
            }
            event.preventDefault();
            onEscape();
          },
        },
      ),
    [],
  );
  return (
    <SidebarInset
      ref={showPage}
      aria-label={label}
      data-app-modal=""
      data-app-route-page=""
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
    >
      <AppRoutePageCloseContext value={{ close, titleBar: true }}>
        {children}
      </AppRoutePageCloseContext>
    </SidebarInset>
  );
}

/**
 * The top row of a Settings or Usage page, ending in its close button. Shown as a page beside the
 * sidebar it is the window's title bar row, so it leaves room for the window controls and drags
 * the window like the thread's header.
 */
export function AppRouteHeader({
  className,
  actions,
  children,
}: {
  className?: string;
  /** Buttons that sit beside the close button, at the row's end. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const page = use(AppRoutePageCloseContext);
  if (page?.titleBar === true) {
    return (
      <WorkspacePageHeader electron={isElectron} className={className}>
        {children}
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {actions}
          <AppRoutePageClose close={page.close} />
        </div>
      </WorkspacePageHeader>
    );
  }
  return (
    <header
      className={cn("flex min-h-12 shrink-0 items-center gap-3 border-b ps-5 pe-2", className)}
    >
      {children}
      <div className="ms-auto flex shrink-0 items-center gap-1">
        {actions}
        <Tooltip>
          <TooltipTrigger
            render={
              page === null ? (
                <DialogPrimitive.Close
                  aria-label="Close"
                  render={<Button size="icon-sm" variant="ghost" />}
                />
              ) : (
                <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={page.close} />
              )
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{page === null ? "Close (Esc)" : "Close"}</TooltipPopup>
        </Tooltip>
      </div>
    </header>
  );
}

function AppRoutePageClose({ close }: { close: () => void }) {
  const { open, isMobile } = useSidebar();
  const sidebarBackShown = useAtomValue(sidebarBackShownAtom);
  // A Back button in the sidebar beside the page already closes it.
  if (sidebarBackShown && open && !isMobile) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button size="icon-sm" variant="ghost" aria-label="Close" onClick={close} />}
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
    </Tooltip>
  );
}
