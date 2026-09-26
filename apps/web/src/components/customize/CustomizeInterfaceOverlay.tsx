import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { CustomizeEditLayer } from "./CustomizeEditLayer";
import { type EditSurface, useCustomizeInterfaceStore } from "./customizeInterfaceStore";
import { CustomizePopover } from "./CustomizePopover";
import { readSelectorRect, SURFACE_SELECTORS, useLiveMeasure } from "./customizeTargets";
import { useCustomizeActions } from "./useCustomizeActions";

const ENTER_DURATION_MS = 200;
const POPOVER_WIDTH = 384;
const MARGIN = 12;
/** Below this width the popover becomes a sheet along the bottom edge. */
const SHEET_MAX_WIDTH = 720;
function measureAnchors() {
  return {
    sidebar: readSelectorRect(SURFACE_SELECTORS.sidebar),
    header: readSelectorRect(SURFACE_SELECTORS.header),
    composer: readSelectorRect(SURFACE_SELECTORS.composer),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

/** Beside the sidebar, under the header, and clear of the composer. */
function popoverPlacement(anchors: ReturnType<typeof measureAnchors>): CSSProperties {
  const { sidebar, header, composer, viewport } = anchors;
  const left = (sidebar ? sidebar.right : 0) + MARGIN;
  const top = (header ? header.bottom : 0) + MARGIN;
  const overlapsComposer =
    composer !== null && composer.left < left + POPOVER_WIDTH && composer.right > left;
  const bottom = overlapsComposer ? composer.top - MARGIN : viewport.height - MARGIN;
  return { left, top, width: POPOVER_WIDTH, maxHeight: Math.max(240, bottom - top) };
}

/** Escape steps back out of editing, then closes; ⌘Z undoes the last change. */
function useCustomizeKeys(onEscape: () => void, onUndo: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input:not([type=range]), textarea, select, [contenteditable=true]"))
        return;
      if (event.key === "Escape") {
        // Some menus stay mounted while closed, so only an open popup counts.
        if (
          document.querySelector(
            '[role="listbox"][data-open], [role="menu"][data-open], [role="dialog"][data-open]',
          )
        ) {
          return;
        }
        onEscape();
        return;
      }
      if (event.key.toLowerCase() === "z" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
        event.preventDefault();
        onUndo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onEscape, onUndo]);
}

/**
 * Customize interface mode. A popover offers layouts to start from and the
 * common appearance settings; each surface can then be edited in place.
 * Everything applies immediately, Undo steps back one change, and Revert
 * returns to how things looked when the mode opened.
 */
export function CustomizeInterfaceOverlay({
  active,
  onExited,
}: {
  active: boolean;
  onExited: () => void;
}) {
  const close = useCustomizeInterfaceStore((store) => store.close);
  const editing = useCustomizeInterfaceStore((store) => store.editing);
  const setEditing = useCustomizeInterfaceStore((store) => store.setEditing);
  const navigate = useNavigate();
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const anchors = useLiveMeasure(measureAnchors, active ? "anchors" : null);
  const { undo } = useCustomizeActions();

  // Enter on the frame after mount so the transition has a start state;
  // leave by fading out, then unmount.
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [active]);
  const visible = active && entered;
  useEffect(() => {
    if (active) return;
    const timer = window.setTimeout(onExited, prefersReducedMotion ? 0 : ENTER_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [active, onExited, prefersReducedMotion]);

  // Focus returns to the fine-tune row of the surface just edited, and to
  // whatever had it before the mode opened once the mode closes.
  const [lastEdited, setLastEdited] = useState<EditSurface | null>(null);
  if (editing && editing !== lastEdited) setLastEdited(editing);
  const [focusOnOpen] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(
    () => () => {
      // A launcher such as the command palette may be gone by now; the
      // composer is where typing continues.
      const target = focusOnOpen?.isConnected
        ? focusOnOpen
        : document.querySelector<HTMLElement>(
            `${SURFACE_SELECTORS.composer} [contenteditable="true"]`,
          );
      target?.focus({ preventScroll: true });
    },
    [focusOnOpen],
  );

  const back = useCallback(() => setEditing(null), [setEditing]);
  const handleEscape = useCallback(
    () => (useCustomizeInterfaceStore.getState().editing ? back() : close()),
    [back, close],
  );
  useCustomizeKeys(handleEscape, undo);

  const openSettings = useCallback(() => {
    close();
    void navigate({ to: "/settings/appearance" });
  }, [close, navigate]);

  if (editing && active) {
    return <CustomizeEditLayer surface={editing} onBack={back} onDone={close} />;
  }

  const sheet = anchors.viewport.width < SHEET_MAX_WIDTH;
  return (
    <div data-customize-interface className="contents">
      <CustomizePopover
        returnFocusTo={lastEdited}
        onDone={close}
        onOpenSettings={openSettings}
        className={cn(
          "transition-[opacity,scale,translate] duration-200 ease-out motion-reduce:transition-opacity",
          sheet
            ? "inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] max-h-[min(40rem,75dvh)] origin-bottom"
            : "origin-top-left",
          visible
            ? "scale-100 opacity-100"
            : "pointer-events-none translate-y-1 scale-97 opacity-0",
        )}
        {...(sheet ? {} : { style: popoverPlacement(anchors) })}
      />
    </div>
  );
}
