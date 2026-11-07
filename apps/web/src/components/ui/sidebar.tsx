import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { PanelLeft, PanelLeftClose } from "lucide";
import * as React from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useResizeDrag } from "~/hooks/useResizeDrag";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import {
  getLocalStorageItem,
  setLocalStorageItem,
  writeLocalStorageValue,
} from "~/hooks/useLocalStorage";
import { resolveSidebarState, type ResponsiveSidebarState } from "./sidebarState";
import * as Schema from "effect/Schema";
import { announceSidebarVisibility } from "~/lib/accessibilityAnnouncements";

const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_WIDTH_MOBILE = "calc(100vw - var(--spacing) * 3)";
const SIDEBAR_WIDTH_ICON = "3rem";
const SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH = 16 * 16;
const SIDEBAR_TITLEBAR_CONTROL_SIZE = "max-sm:[--workspace-titlebar-control-size:--spacing(8)]";

type SidebarContextProps = {
  state: ResponsiveSidebarState;
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  mobileSheetMounted: boolean;
  setMobileSheetElement: (element: HTMLDivElement | null) => void;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
  /** Runs before the desktop sidebar collapses. */
  onCollapse: (listener: () => void) => () => void;
};

type SidebarResizableOptions = {
  maxWidth?: number;
  minWidth?: number;
  onResize?: (width: number) => void;
  shouldAcceptWidth?: (context: {
    currentWidth: number;
    nextWidth: number;
    rail: HTMLButtonElement;
    side: "left" | "right";
    sidebarRoot: HTMLElement;
    wrapper: HTMLElement;
  }) => boolean;
  storageKey?: string;
};

type SidebarResolvedResizableOptions = {
  maxWidth: number;
  minWidth: number;
  onResize?: (width: number) => void;
  shouldAcceptWidth?: (context: {
    currentWidth: number;
    nextWidth: number;
    rail: HTMLButtonElement;
    side: "left" | "right";
    sidebarRoot: HTMLElement;
    wrapper: HTMLElement;
  }) => boolean;
  storageKey: string | null;
};

type SidebarInstanceContextProps = {
  resizable: SidebarResolvedResizableOptions | null;
  side: "left" | "right";
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);
const SidebarInstanceContext = React.createContext<SidebarInstanceContextProps | null>(null);

function useSidebar() {
  const context = React.use(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

function useSidebarVisibility() {
  const { isMobile, open, openMobile } = useSidebar();
  return isMobile ? openMobile : open;
}

// The `max-md` breakpoint, also read when a shortcut fires.
const SIDEBAR_MOBILE_QUERY = "(max-width: 767px)";

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(SIDEBAR_MOBILE_QUERY).matches;
}

function readStoredSidebarOpen(storageKey: string | undefined): boolean | null {
  if (!storageKey) return null;
  try {
    return getLocalStorageItem(storageKey, Schema.Boolean);
  } catch (error) {
    console.error("Could not restore persisted sidebar state.", error);
    return null;
  }
}

// An offcanvas sidebar turns inert once collapsed, which drops focus to the body.
function moveFocusOutOfCollapsingSidebar() {
  const sidebar = document.activeElement?.closest<HTMLElement>(
    '[data-slot="sidebar"][data-collapsible-mode="offcanvas"]',
  );
  const wrapper = sidebar?.closest<HTMLElement>('[data-slot="sidebar-wrapper"]');
  if (!sidebar || !wrapper) return;
  const trigger = Array.from(
    wrapper.querySelectorAll<HTMLElement>('[data-sidebar="trigger"]'),
  ).find((element) => !sidebar.contains(element));
  trigger?.focus({ preventScroll: true });
}

const SIDEBAR_SLIDE_ID = "sidebar-slide";

function sidebarSlideTargets() {
  const scope = '[data-panel-animations="true"]';
  const containers = document.querySelectorAll<HTMLElement>(
    `${scope} [data-slot="sidebar-container"]`,
  );
  const insets = document.querySelectorAll<HTMLElement>(`${scope} [data-slot="sidebar-inset"]`);
  return [
    ...Array.from(containers, (element) => ({ element, parent: null, inset: false })),
    ...Array.from(insets).flatMap((inset) => [
      { element: inset, parent: null, inset: true },
      ...Array.from(
        inset.querySelectorAll<HTMLElement>("[data-sidebar-slide-children] > *"),
        (element) => ({ element, parent: inset, inset: false }),
      ),
    ]),
  ].map((target) => ({ ...target, start: target.element.getBoundingClientRect().left }));
}

function sidebarSlideAnchors(insets: HTMLElement[]) {
  return insets.flatMap((inset) => [
    ...Array.from(inset.querySelectorAll<HTMLElement>("[data-sidebar-slide-hold]"), (element) => ({
      element,
      inset,
      via: null,
    })),
    ...Array.from(
      inset.querySelectorAll<HTMLElement>(
        "[data-sidebar-slide-children] > * [data-sidebar-slide-stay]",
      ),
      (element) => ({
        element,
        inset,
        via: element.closest<HTMLElement>("[data-sidebar-slide-children] > *"),
      }),
    ),
  ]);
}

function siblingSlot(element: Element | null, slot: string): HTMLElement | null {
  return element instanceof HTMLElement && element.dataset.slot === slot ? element : null;
}

function sidebarInsetEdgeRows(inset: HTMLElement, rect: DOMRect, underNotch: boolean) {
  const rows = Array.from(inset.querySelectorAll<HTMLElement>("[data-layout-pane-id]")).flatMap(
    (pane) => {
      const paneRect = pane.getBoundingClientRect();
      if (paneRect.width === 0 || paneRect.right < rect.right - 1 || paneRect.left >= rect.right) {
        return [];
      }
      const notch = underNotch
        ? pane.querySelector<HTMLElement>('[data-pane-notch="right"]')
        : null;
      const top = notch?.offsetWidth ? notch.getBoundingClientRect().bottom : paneRect.top;
      return [{ top: Math.max(top, rect.top), bottom: Math.min(paneRect.bottom, rect.bottom) }];
    },
  );
  return rows.length > 0 ? rows : [{ top: rect.top, bottom: rect.bottom }];
}

function fillSidebarInsetEdge(
  inset: HTMLElement,
  offset: number,
  timing: KeyframeAnimationOptions,
) {
  const opening = offset < 0;
  const edge = opening
    ? siblingSlot(inset.previousElementSibling, "sidebar-slide-surface")
    : siblingSlot(inset.nextElementSibling, "sidebar-slide-frame");
  if (!edge) return;
  const rect = inset.getBoundingClientRect();
  edge.style.left = `${opening ? rect.right + offset : rect.right}px`;
  edge.style.width = `${opening ? -offset : window.innerWidth - rect.right}px`;
  edge.replaceChildren(
    ...sidebarInsetEdgeRows(inset, rect, opening).flatMap(({ top, bottom }) => {
      if (opening) {
        const piece = document.createElement("div");
        piece.className = "absolute inset-x-0 rounded-pane bg-background";
        Object.assign(piece.style, { top: `${top}px`, height: `${bottom - top}px` });
        return [piece];
      }
      return (["top", "bottom"] as const).map((corner) => {
        const piece = document.createElement("div");
        piece.dataset.corner = corner;
        piece.style.top = `${corner === "top" ? top : bottom}px`;
        return piece;
      });
    }),
  );
  edge.animate({ opacity: [1, 1] }, timing);
}

function cancelSidebarSlide(elements: Iterable<Element | null>) {
  for (const element of elements) {
    for (const animation of element?.getAnimations() ?? []) {
      if (animation.id === SIDEBAR_SLIDE_ID) animation.cancel();
    }
  }
}

let sidebarSlidePending = false;

function slideSidebar(commit: () => void) {
  if (sidebarSlidePending) {
    commit();
    return;
  }
  const targets = sidebarSlideTargets();
  commit();
  const first = targets[0];
  if (!first) return;
  sidebarSlidePending = true;
  window.requestAnimationFrame(() => {
    sidebarSlidePending = false;
    const insets = targets.filter(({ inset }) => inset).map(({ element }) => element);
    const anchors = sidebarSlideAnchors(insets);
    cancelSidebarSlide([
      ...targets.map(({ element }) => element),
      ...anchors.map(({ element }) => element),
      ...insets.flatMap((inset) => [inset.previousElementSibling, inset.nextElementSibling]),
    ]);
    const offsets = new Map(
      targets.map(({ element, start }) => [element, start - element.getBoundingClientRect().left]),
    );
    const anchorStarts = anchors.map(({ element }) => element.getBoundingClientRect());
    const duration = Number.parseFloat(
      getComputedStyle(first.element).getPropertyValue("--panel-animation-duration"),
    );
    const timing: KeyframeAnimationOptions = {
      duration: Number.isFinite(duration) ? duration : 0,
      easing: "ease-out",
      id: SIDEBAR_SLIDE_ID,
    };
    const slides = new Map<HTMLElement, number>();
    for (const { element, parent, inset } of targets) {
      const ownOffset = offsets.get(element) ?? 0;
      if (parent && Math.abs(ownOffset) < 0.5) continue;
      const offset = ownOffset - (parent ? (offsets.get(parent) ?? 0) : 0);
      if (!element.isConnected || Math.abs(offset) < 0.5) continue;
      if (inset) fillSidebarInsetEdge(element, offset, timing);
      element.animate({ transform: [`translateX(${offset}px)`, "translateX(0)"] }, timing);
      slides.set(element, offset);
    }
    anchors.forEach(({ element, inset, via }, index) => {
      const start = anchorStarts[index];
      const insetOffset = slides.get(inset) ?? 0;
      const viaOffset = via ? (slides.get(via) ?? 0) : 0;
      if (!start || (via ? viaOffset === 0 : insetOffset === 0)) return;
      const contained = element.getBoundingClientRect();
      const x = start.left - contained.left;
      const y = start.top - contained.top;
      const from = via || insetOffset < 0 ? x + insetOffset : x;
      element.animate(
        {
          transform: [
            `translate(${from}px, ${y}px)`,
            `translate(${x + insetOffset + viaOffset}px, ${y}px)`,
          ],
        },
        timing,
      );
    });
  });
}

interface SidebarOpenState {
  readonly open: boolean;
  readonly openMobile: boolean;
}

/** Per-provider open state, kept outside React so shortcuts can toggle it at event time. */
function createSidebarOpenStore(defaultOpen: boolean, storageKey: string | undefined) {
  let state: SidebarOpenState = {
    open: readStoredSidebarOpen(storageKey) ?? defaultOpen,
    openMobile: false,
  };
  const listeners = new Set<() => void>();
  const collapseListeners = new Set<() => void>();
  const publish = (next: SidebarOpenState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const setOpen = (open: boolean) => {
    if (!open && state.open) {
      for (const listener of collapseListeners) listener();
      moveFocusOutOfCollapsingSidebar();
    }
    if (open !== state.open) {
      if (!isMobileViewport()) announceSidebarVisibility(open);
      slideSidebar(() => publish({ ...state, open }));
    }
    if (storageKey) writeLocalStorageValue(storageKey, open, defaultOpen, Schema.Boolean);
  };
  const setOpenMobile = (openMobile: boolean) => {
    if (openMobile !== state.openMobile) publish({ ...state, openMobile });
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    setOpen,
    setOpenMobile,
    toggle: () => (isMobileViewport() ? setOpenMobile(!state.openMobile) : setOpen(!state.open)),
    onCollapse: (listener: () => void) => {
      collapseListeners.add(listener);
      return () => {
        collapseListeners.delete(listener);
      };
    },
  };
}

function SidebarProvider({
  defaultOpen = true,
  storageKey,
  store: providedStore,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  storageKey?: string;
  store?: ReturnType<typeof createSidebarOpenStore>;
}) {
  const isMobile = useMediaQuery(SIDEBAR_MOBILE_QUERY);
  const [store] = React.useState(
    () => providedStore ?? createSidebarOpenStore(defaultOpen, storageKey),
  );
  const { open, openMobile } = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const [mobileSheetMounted, setMobileSheetMounted] = React.useState(false);
  const setMobileSheetElement = (element: HTMLDivElement | null) => {
    setMobileSheetMounted(element !== null);
  };

  const state = resolveSidebarState({ isMobile, open, openMobile });

  const contextValue: SidebarContextProps = {
    isMobile,
    open,
    openMobile,
    mobileSheetMounted,
    setMobileSheetElement,
    setOpen: store.setOpen,
    setOpenMobile: store.setOpenMobile,
    state,
    toggleSidebar: store.toggle,
    onCollapse: store.onCollapse,
  };

  return (
    <SidebarContext value={contextValue}>
      <div
        className={cn(
          "group/sidebar-wrapper flex min-h-svh w-full",
          SIDEBAR_TITLEBAR_CONTROL_SIZE,
          className,
        )}
        data-sidebar-state={state}
        data-slot="sidebar-wrapper"
        style={
          {
            "--sidebar-width": SIDEBAR_WIDTH,
            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
            "--workspace-titlebar-content-left":
              "calc(var(--workspace-controls-left) + var(--workspace-titlebar-control-size) + var(--workspace-titlebar-control-gap))",
            ...style,
          } as React.CSSProperties
        }
        {...props}
      >
        {children}
      </div>
    </SidebarContext>
  );
}

function resolveSidebarResizable({
  collapsible,
  isMobile,
  resizable,
}: {
  collapsible: "offcanvas" | "icon" | "none";
  isMobile: boolean;
  resizable: boolean | SidebarResizableOptions;
}): SidebarResolvedResizableOptions | null {
  if (isMobile || collapsible === "none" || !resizable) {
    return null;
  }

  const options = typeof resizable === "boolean" ? {} : resizable;
  return {
    maxWidth: options.maxWidth ?? Number.POSITIVE_INFINITY,
    minWidth: options.minWidth ?? SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH,
    storageKey: options.storageKey ?? null,
    ...(options.onResize ? { onResize: options.onResize } : {}),
    ...(options.shouldAcceptWidth ? { shouldAcceptWidth: options.shouldAcceptWidth } : {}),
  };
}

function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  resizable = false,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
  resizable?: boolean | SidebarResizableOptions;
}) {
  const { isMobile, state, openMobile, setOpenMobile, setMobileSheetElement } = useSidebar();
  const offcanvasCollapsed = !isMobile && collapsible === "offcanvas" && state === "collapsed";

  const resolvedResizable = resolveSidebarResizable({ collapsible, isMobile, resizable });
  const instanceContextValue: SidebarInstanceContextProps = { side, resizable: resolvedResizable };

  if (collapsible === "none") {
    return (
      <SidebarInstanceContext value={instanceContextValue}>
        <div
          className={cn(
            "flex h-full w-(--sidebar-width) flex-col bg-sidebar surface-grain text-sidebar-foreground",
            className,
          )}
          data-slot="sidebar"
          {...props}
        >
          {children}
        </div>
      </SidebarInstanceContext>
    );
  }

  if (isMobile) {
    return (
      <SidebarInstanceContext value={instanceContextValue}>
        <Sheet onOpenChange={setOpenMobile} open={openMobile}>
          <SheetPopup
            ref={setMobileSheetElement}
            // The sheet paints the popover surface. In light, black chrome it is
            // chrome like the desktop sidebar, so it takes the black, grain and keycaps.
            className={cn(
              "w-(--sidebar-width) max-w-none p-0 text-sidebar-foreground [.black-chrome_&]:bg-(--app-chrome-background) [.black-chrome_&]:surface-grain [.black-chrome_&]:[--kbd-background:initial]",
              className,
            )}
            data-mobile="true"
            data-sidebar="sidebar"
            data-slot="sidebar"
            showCloseButton={false}
            side={side}
            style={
              {
                "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
              } as React.CSSProperties
            }
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{props["aria-label"] ?? "Sidebar"}</SheetTitle>
              <SheetDescription>Displays the mobile sidebar.</SheetDescription>
            </SheetHeader>
            <div
              className={cn(
                "flex h-full w-full flex-col pb-safe pt-safe",
                SIDEBAR_TITLEBAR_CONTROL_SIZE,
                side === "left" ? "pl-safe" : "pr-safe",
              )}
              {...props}
            >
              {children}
            </div>
          </SheetPopup>
        </Sheet>
      </SidebarInstanceContext>
    );
  }

  return (
    <SidebarInstanceContext value={instanceContextValue}>
      <div
        className="group peer hidden text-sidebar-foreground md:block"
        data-collapsible={state === "collapsed" ? collapsible : ""}
        data-collapsible-mode={collapsible}
        inert={offcanvasCollapsed}
        data-side={side}
        data-slot="sidebar"
        data-state={state}
        data-variant={variant}
      >
        <div
          className={cn(
            "relative w-(--sidebar-width) bg-transparent",
            "group-data-[collapsible=offcanvas]:w-0",
            "group-data-[side=right]:rotate-180",
            variant === "floating"
              ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
              : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
          )}
          data-slot="sidebar-gap"
        />
        <div
          className={cn(
            "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) md:flex",
            side === "left"
              ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
              : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
            // Floating pads its card; inset sits flush on the window chrome
            // beside the inset content pane, so it has no edge border.
            variant === "floating"
              ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
              : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
            variant === "sidebar" &&
              "group-data-[side=left]:border-r group-data-[side=right]:border-l",
            className,
          )}
          data-slot="sidebar-container"
          {...props}
        >
          <div
            className="flex h-full w-full flex-col bg-sidebar surface-grain group-data-[variant=inset]:ps-(--workspace-sidebar-edge-inset) group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm/5"
            data-sidebar="sidebar"
            data-slot="sidebar-inner"
          >
            {children}
          </div>
        </div>
      </div>
    </SidebarInstanceContext>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();
  const isOpen = useSidebarVisibility();

  return (
    <Button
      className={cn(
        "size-[var(--workspace-titlebar-control-size)]! [-webkit-app-region:no-drag]",
        className,
      )}
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      aria-pressed={isOpen}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      size="icon"
      variant="ghost"
      {...props}
    >
      <MorphIcon
        className={cn(
          "size-4",
          props.variant === "media-navigation" ? "text-current" : "text-sidebar-toggle",
        )}
        icon={isOpen ? PanelLeftClose : PanelLeft}
        strokeWidth={2.25}
      />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
}

function clampSidebarWidth(width: number, options: SidebarResolvedResizableOptions): number {
  return Math.max(options.minWidth, Math.min(width, options.maxWidth));
}

function SidebarRail({
  className,
  onClick,
  onPointerCancel,
  onLostPointerCapture,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  ...props
}: React.ComponentProps<"button">) {
  const { open, toggleSidebar, onCollapse } = useSidebar();
  const sidebarInstance = React.use(SidebarInstanceContext);
  const suppressClickRef = React.useRef(false);
  const resolvedResizable = sidebarInstance?.resizable ?? null;
  const canResize = resolvedResizable !== null && open;
  const railLabel = canResize ? "Resize Sidebar" : "Toggle Sidebar";
  const railTitle = canResize ? "Drag to resize sidebar" : "Toggle Sidebar";
  const resize = useResizeDrag<HTMLButtonElement>((event) => {
    const options = resolvedResizable;
    if (!options || !open) return null;
    const rail = event.currentTarget;
    const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    const sidebarRoot = rail.closest<HTMLElement>("[data-slot='sidebar']");
    const sidebarContainer = sidebarRoot?.querySelector<HTMLElement>(
      "[data-slot='sidebar-container']",
    );
    if (!wrapper || !sidebarRoot || !sidebarContainer) return null;

    const side = sidebarInstance?.side ?? "left";
    let width = clampSidebarWidth(sidebarContainer.getBoundingClientRect().width, options);
    // Write width only to gap/container during drag; inherited --sidebar-width restyles the whole app, so
    // update it at commit.
    const widthTargets = [
      sidebarRoot.querySelector<HTMLElement>("[data-slot='sidebar-gap']"),
      sidebarContainer,
    ].filter((element): element is HTMLElement => element !== null);
    const setTargetWidth = (value: number) => {
      widthTargets.forEach((element) => {
        element.style.setProperty("width", `${value}px`);
      });
    };
    widthTargets.forEach((element) => {
      element.style.setProperty("transition-duration", "0ms");
    });
    setTargetWidth(width);

    return {
      width,
      edge: side === "left" ? "right" : "left",
      bounds: { min: options.minWidth, max: options.maxWidth },
      resize(nextWidth) {
        const accepted =
          options.shouldAcceptWidth?.({
            currentWidth: width,
            nextWidth,
            rail,
            side,
            sidebarRoot,
            wrapper,
          }) ?? true;
        if (accepted) {
          setTargetWidth(nextWidth);
          width = nextWidth;
        }
        return width;
      },
      finish(finalWidth, moved) {
        wrapper.style.setProperty("--sidebar-width", `${finalWidth}px`);
        suppressClickRef.current = moved;
        if (options.storageKey) {
          try {
            setLocalStorageItem(options.storageKey, finalWidth, Schema.Finite);
          } catch (error) {
            console.error("Could not persist sidebar width.", error);
          }
        }
        options.onResize?.(finalWidth);
      },
      cleanup() {
        widthTargets.forEach((element) => {
          element.style.removeProperty("width");
          element.style.removeProperty("transition-duration");
        });
      },
    };
  });
  // Collapsing mid-drag abandons the drag instead of committing a width to a hidden sidebar.
  // Created once: a new ref callback would run the old one's cleanup, which ends a live drag.
  const [railRef] = React.useState(() => {
    const { ref: dragRef, cancel } = resize;
    return (node: HTMLButtonElement | null) => {
      const releaseDrag = dragRef(node);
      if (!releaseDrag) return undefined;
      const stopCancelOnCollapse = onCollapse(cancel);
      return () => {
        stopCancelOnCollapse();
        releaseDrag();
      };
    };
  });

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.preventDefault();
      return;
    }
    if (resolvedResizable && open) {
      event.preventDefault();
      return;
    }
    toggleSidebar();
  };

  // The rail spans the sidebar's full height, so the tip follows the pointer
  // instead of floating at the rail's vertical middle.
  return (
    <Tooltip trackCursorAxis="y">
      <TooltipTrigger
        render={
          <button
            aria-label={railLabel}
            className={cn(
              /* A collapsed offcanvas rail overlaps the native scrollbar on Windows and Linux. */
              "-translate-x-1/2 group-data-[side=left]:-right-4 absolute inset-y-0 z-20 hidden w-4 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border group-data-[side=right]:left-0 sm:flex [[data-collapsible=offcanvas][data-state=collapsed]_&]:pointer-events-none",
              "[[data-panel-animations=true]_&]:transition-all [[data-panel-animations=true]_&]:[transition-duration:var(--panel-animation-duration)] [[data-panel-animations=true]_&]:ease-out",
              "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
              "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
              "group-data-[collapsible=offcanvas]:translate-x-0 hover:group-data-[collapsible=offcanvas]:bg-sidebar group-data-[collapsible=offcanvas]:after:left-full",
              "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
              "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
              className,
            )}
            data-sidebar="rail"
            data-slot="sidebar-rail"
            onClick={handleClick}
            onLostPointerCapture={(event) => {
              onLostPointerCapture?.(event);
              if (!event.defaultPrevented) resize.onLostPointerCapture(event);
            }}
            onPointerCancel={(event) => {
              onPointerCancel?.(event);
              if (!event.defaultPrevented) resize.onPointerCancel(event);
            }}
            onPointerDown={(event) => {
              onPointerDown?.(event);
              if (!event.defaultPrevented) resize.onPointerDown(event);
            }}
            onPointerMove={(event) => {
              onPointerMove?.(event);
              if (!event.defaultPrevented) resize.onPointerMove(event);
            }}
            onPointerUp={(event) => {
              onPointerUp?.(event);
              if (!event.defaultPrevented) resize.onPointerUp(event);
            }}
            ref={railRef}
            tabIndex={-1}
            type="button"
            {...props}
          />
        }
      />
      <TooltipPopup side="right">{railTitle}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * `pane` draws the single inset pane. `split` keeps the same insets but draws
 * nothing, for a layout whose panes each draw their own pane with gaps.
 */
function SidebarInset({
  className,
  variant = "pane",
  ...props
}: React.ComponentProps<"main"> & { variant?: "pane" | "split" }) {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-y-0 hidden opacity-0 md:peer-data-[variant=inset]:block"
        data-slot="sidebar-slide-surface"
      />
      <main
        className={cn(
          "relative flex min-w-0 w-full flex-1 flex-col",
          variant === "pane" && "bg-background surface-grain",
          // The inset pane (pen mSaSF) on the window chrome: 12px from the window
          // and from the sidebar's content, centered on the chrome row at the top.
          // It stretches in the flex wrapper, so the route's own height yields.
          "md:peer-data-[variant=inset]:h-auto md:peer-data-[variant=inset]:overflow-hidden md:peer-data-[variant=inset]:mt-(--workspace-pane-inset-top) md:peer-data-[variant=inset]:me-(--workspace-pane-inset) md:peer-data-[variant=inset]:mb-(--workspace-pane-inset) md:peer-data-[variant=inset]:ms-(--workspace-sidebar-edge-inset) md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-(--workspace-pane-inset)",
          variant === "pane" && "md:peer-data-[variant=inset]:rounded-pane",
          className,
        )}
        data-slot="sidebar-inset"
        {...props}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-y-0 hidden bg-(--app-chrome-background) opacity-0 surface-grain md:peer-data-[variant=inset]:block"
        data-slot="sidebar-slide-frame"
      />
    </>
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-2", className)}
      data-sidebar="header"
      data-slot="sidebar-header"
      {...props}
    />
  );
}

/**
 * Mirrors the window chrome row: the footer's controls end on the inset pane's
 * bottom edge, and the shelf docked above centers as far from the bottom as
 * the sidebar's first row does from the top.
 */
function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 px-[var(--sidebar-content-inset)] pt-2 pb-(--workspace-pane-inset)",
        className,
      )}
      data-sidebar="footer"
      data-slot="sidebar-footer"
      {...props}
    />
  );
}

function SidebarContent({
  className,
  fixedHeader,
  ...props
}: React.ComponentProps<"div"> & {
  fixedHeader?: React.ReactNode;
}) {
  return (
    <>
      {fixedHeader ? <div className="w-full shrink-0">{fixedHeader}</div> : null}
      <ScrollArea
        hideScrollbars
        scrollFade
        scrollFadePadding={false}
        // Rows provide keyboard access; exclude the viewport from tab order to flatten VoiceOver's WebKit
        // interaction boundary.
        viewportTabIndex={-1}
        className="h-auto min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:[--fade-size:0.75rem]"
      >
        <div
          className={cn(
            "flex w-full min-w-0 flex-col [overflow-anchor:none] group-data-[collapsible=icon]:overflow-hidden [&>[data-sidebar=group]+[data-sidebar=group]]:pt-0",
            fixedHeader && "[&>[data-sidebar=group]:first-child]:pt-0",
            className,
          )}
          data-sidebar="content"
          data-slot="sidebar-content"
          {...props}
        />
      </ScrollArea>
    </>
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex w-full min-w-0 flex-col p-[var(--sidebar-content-inset)]",
        className,
      )}
      data-sidebar="group"
      data-slot="sidebar-group"
      {...props}
    />
  );
}

function SidebarMenu({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"ul"> & { size?: "default" | "compact" }) {
  return (
    <ul
      className={cn(
        "flex w-full min-w-0 flex-col",
        size === "compact" ? "gap-0.5" : "gap-1",
        className,
      )}
      data-sidebar="menu"
      data-slot="sidebar-menu"
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      className={cn("group/menu-item relative", className)}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
      {...props}
    />
  );
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full cursor-pointer items-center gap-[var(--sidebar-control-gap)] overflow-hidden text-left outline-hidden ring-ring transition-[width,height,padding] hover:surface-sidebar-row-hover hover:text-sidebar-foreground focus-visible:[box-shadow:inset_0_0_0_1.5px_var(--ring)]! active:surface-sidebar-row-active active:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64 data-[active=true]:surface-sidebar-row-selected data-[active=true]:font-medium data-[active=true]:text-(--sidebar-active-label) data-[state=open]:hover:surface-sidebar-row-hover data-[state=open]:hover:text-sidebar-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-[var(--sidebar-content-inset)]! [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] hover:[&>svg]:text-sidebar-foreground active:[&>svg]:text-sidebar-foreground data-[active=true]:[&>svg]:text-(--sidebar-active-icon)",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        // A leading 14px glyph centers on the sidebar's icon column (a 16px slot on
        // the text line) and its label still starts after a 16px slot and 6px.
        default:
          "h-8 rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-1.5 text-label has-[>svg:first-child]:ps-[calc(var(--sidebar-row-content-inset)+1px)] has-[>svg:first-child]:gap-[calc(var(--sidebar-control-gap)-1px)]",
        // The default row on the 28px control pitch, for a row that stands in for
        // the footer's icon controls: its glyph stays on their center line.
        control:
          "h-(--workspace-titlebar-control-size) rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] text-label has-[>svg:first-child]:ps-[calc(var(--sidebar-row-content-inset)+1px)] has-[>svg:first-child]:gap-[calc(var(--sidebar-control-gap)-1px)]",
        project:
          "h-8 gap-2.5 rounded-[var(--control-radius)] px-(--sidebar-row-content-inset) text-label",
        compact: "h-7.5 gap-2 rounded-lg px-2 text-label",
        icon: "size-8 justify-center rounded-[var(--control-radius)] p-0",
        sm: "h-7 rounded-control p-2 text-meta",
      },
      variant: {
        default: "text-sidebar-muted-foreground",
      },
    },
  },
);

function SidebarMenuButton({
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> & {
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipPopup>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const { isMobile, state } = useSidebar();

  const defaultProps = {
    className: cn(sidebarMenuButtonVariants({ size, variant }), className),
    "data-active": isActive,
    "data-sidebar": "menu-button",
    "data-size": size,
    "data-slot": "sidebar-menu-button",
  };

  const buttonProps = mergeProps<"button">(defaultProps, props);

  const buttonElement = useRender({
    defaultTagName: "button",
    props: buttonProps,
    render,
  });

  if (!tooltip) {
    return buttonElement;
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    };
  }

  return (
    <Tooltip>
      <TooltipTrigger render={buttonElement as React.ReactElement<Record<string, unknown>>} />
      <TooltipPopup
        align="center"
        hidden={state !== "collapsed" || isMobile}
        side="right"
        {...tooltip}
      />
    </Tooltip>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      className={cn(
        "mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-sidebar-border border-l px-2.5 py-0.5",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      data-sidebar="menu-sub"
      data-slot="sidebar-menu-sub"
      {...props}
    />
  );
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      className={cn("group/menu-sub-item relative", className)}
      data-sidebar="menu-sub-item"
      data-slot="sidebar-menu-sub-item"
      {...props}
    />
  );
}

function SidebarMenuSubButton({
  size = "md",
  isActive = false,
  className,
  render,
  ...props
}: useRender.ComponentProps<"a"> & {
  size?: "sm" | "md";
  isActive?: boolean;
}) {
  const defaultProps = {
    className: cn(
      "-translate-x-px flex h-7 min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 text-sidebar-foreground outline-hidden ring-ring hover:surface-sidebar-row-hover hover:text-sidebar-foreground focus-visible:[box-shadow:inset_0_0_0_1.5px_var(--ring)]! active:surface-sidebar-row-active active:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64 [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-sidebar-muted-foreground",
      "data-[active=true]:surface-sidebar-row-selected data-[active=true]:text-strong-foreground",
      size === "sm" && "text-meta",
      size === "md" && "text-label",
      "group-data-[collapsible=icon]:hidden",
      className,
    ),
    "data-active": isActive,
    "data-sidebar": "menu-sub-button",
    "data-size": size,
    "data-slot": "sidebar-menu-sub-button",
  };

  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(defaultProps, props),
    render,
  });
}

export {
  createSidebarOpenStore,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
};
