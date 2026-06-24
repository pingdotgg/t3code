import { useAtomValue } from "@effect/atom-react";
import { useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { isElectron } from "../env";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { isMacPlatform } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
// Base floor sized for the thread list / buttons — the real width-limited content.
// useWordmarkMinWidth only ever raises the floor above this, never below it.
const THREAD_SIDEBAR_MIN_WIDTH = 15 * 16;
// Breathing room kept past the "logflash" wordmark badge, as a fraction of its
// own width.
const WORDMARK_BADGE_TRAILING_RATIO = 0.5;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;
const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "90px";

/**
 * Resize floor for the sidebar: the larger of a fixed content floor
 * ({@link THREAD_SIDEBAR_MIN_WIDTH}) and the width the wordmark itself needs —
 * "T3 Code" + the "logflash" badge + a trailing gap ({@link WORDMARK_BADGE_TRAILING_RATIO}).
 *
 * That second term is NOT constant across zoom. On macOS the brand is offset by
 * `--workspace-titlebar-content-left` (derived from the traffic-light inset,
 * which the desktop scales by `--app-zoom`), so zooming reflows the geometry. We
 * measure the live DOM and re-measure on resize (zoom surfaces as a resize) or
 * when the web font loads. `scrollWidth - clientWidth` adds back any width the
 * "Code" label is losing to truncation, so we recover the badge's untruncated
 * right edge even while the sidebar is momentarily too narrow.
 */
function useWordmarkMinWidth(): number {
  const [minWidth, setMinWidth] = useState(THREAD_SIDEBAR_MIN_WIDTH);
  useLayoutEffect(() => {
    const measure = () => {
      const name = document.querySelector<HTMLElement>("[data-slot='sidebar-wordmark-name']");
      const badge = document.querySelector<HTMLElement>("[data-slot='sidebar-wordmark-badge']");
      const container = document.querySelector<HTMLElement>("[data-slot='sidebar-container']");
      if (!name || !badge || !container) {
        return;
      }
      const badgeRect = badge.getBoundingClientRect();
      if (badgeRect.width <= 0) {
        return; // not laid out yet (or a zero-size test env) — keep the base floor
      }
      const nameTruncatedBy = Math.max(0, name.scrollWidth - name.clientWidth);
      const containerLeft = container.getBoundingClientRect().left;
      const badgeRightUntruncated = badgeRect.right - containerLeft + nameTruncatedBy;
      const needed = Math.ceil(
        badgeRightUntruncated + WORDMARK_BADGE_TRAILING_RATIO * badgeRect.width,
      );
      const next = Math.max(THREAD_SIDEBAR_MIN_WIDTH, needed);
      setMinWidth((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));

      // The resize floor governs dragging and re-clamps a *stored* width, but a
      // never-resized sidebar uses the CSS default (16rem), which ignores it. If
      // that leaves the live width below the floor, nudge it up so the wordmark
      // fits right away. Only ever grows — never shrinks the user.
      const wrapper = container.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
      if (wrapper && container.getBoundingClientRect().width + 0.5 < next) {
        wrapper.style.setProperty("--sidebar-width", `${next}px`);
      }
    };

    measure();
    const badge = document.querySelector<HTMLElement>("[data-slot='sidebar-wordmark-badge']");
    let observer: ResizeObserver | null = null;
    if (badge && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(badge);
    }
    // Page zoom (Cmd +/-) reflows the layout viewport, surfacing as a resize.
    window.addEventListener("resize", measure);
    if (typeof document.fonts !== "undefined") {
      void document.fonts.ready.then(measure);
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return minWidth;
}

function SidebarControl() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar } = useSidebar();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (resolveShortcutCommand(event, keybindings) !== "sidebar.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, toggleSidebar]);

  return (
    <div
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 flex h-[var(--workspace-topbar-height)] items-center"
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger className="pointer-events-auto" aria-label="Toggle main sidebar" />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const sidebarMinWidth = useWordmarkMinWidth();
  const macosWindowControlsStyle =
    isElectron && isMacPlatform(navigator.platform)
      ? // The native traffic lights sit at a fixed *screen* position that does not
        // scale with page zoom (Cmd +/-), so divide the inset by --app-zoom (published
        // by syncDocumentZoomFactorProperty) to hold a constant screen gap. At 100%
        // zoom, or with no zoom source, --app-zoom is 1 and this is just the inset.
        ({
          "--workspace-controls-left": `calc(${MACOS_TRAFFIC_LIGHTS_LEFT_INSET} / var(--app-zoom, 1))`,
        } as CSSProperties)
      : undefined;

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        void navigate({ to: "/settings" });
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen style={macosWindowControlsStyle}>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          minWidth: sidebarMinWidth,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      {children}
      <SidebarControl />
    </SidebarProvider>
  );
}
