import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
// Floor sized for the thread list / buttons — the real width-limited content.
// useWordmarkMinWidth only ever raises the floor above this, never below it.
const THREAD_SIDEBAR_MIN_WIDTH_BASE = 15 * 16;
// Breathing room kept past the wordmark badge, as a fraction of its own width.
const WORDMARK_BADGE_TRAILING_RATIO = 0.25;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

/**
 * Resize floor for the sidebar: the larger of a fixed content floor
 * ({@link THREAD_SIDEBAR_MIN_WIDTH_BASE}) and the width the wordmark itself needs
 * — "T3 Code" + the "logflash" badge + a small trailing gap.
 *
 * That second term is NOT constant across zoom. On macOS the header left-pads the
 * native traffic lights by `90px / zoom` (see SidebarChromeHeader), so zooming
 * *out* widens that padding (in CSS px) and pushes the wordmark right — past some
 * zoom-out a hard-coded floor would clip "logflash". So we measure the live DOM
 * and re-measure whenever zoom (which reflows → window resize) or the web font
 * changes the geometry. `scrollWidth - clientWidth` adds back any width the "Code"
 * label is currently losing to truncation, so we recover the badge's untruncated
 * right edge even while the sidebar is momentarily too narrow — the floor then
 * converges upward instead of latching onto a clipped layout.
 */
function useWordmarkMinWidth(): number {
  const [minWidth, setMinWidth] = useState(THREAD_SIDEBAR_MIN_WIDTH_BASE);
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
      const next = Math.max(THREAD_SIDEBAR_MIN_WIDTH_BASE, needed);
      setMinWidth((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));

      // The resize floor governs dragging and re-clamps a *stored* width, but a
      // never-resized sidebar uses the CSS default (16rem), which ignores it. If
      // that leaves the live width below the floor (e.g. zoomed out), nudge it up
      // so the wordmark fits right away. Only ever grows — never shrinks the user.
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

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const sidebarMinWidth = useWordmarkMinWidth();

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
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
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
    </SidebarProvider>
  );
}
