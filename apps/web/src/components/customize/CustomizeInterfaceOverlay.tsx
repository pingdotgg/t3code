import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { hasOpenCustomizePopup, preservesNativeCustomizeEscape } from "./customizeEdit.logic";
import { CustomizeEditLayer } from "./CustomizeEditLayer";
import { CustomizeHotspots } from "./CustomizeHotspots";
import { type EditSurface, useCustomizeInterfaceStore } from "./customizeInterfaceStore";
import { CustomizePopover } from "./CustomizePopover";
import {
  readSelectorRect,
  remeasureCustomizeTargets,
  SURFACE_SELECTORS,
  useLiveMeasure,
} from "./customizeTargets";
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
function useCustomizeKeys(active: boolean, onEscape: () => void, onUndo: () => void) {
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (hasOpenCustomizePopup()) return;
      if (event.key === "Escape") {
        if (preservesNativeCustomizeEscape(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        // The edit layer cancels an active drag before stepping back.
        const layer = document.querySelector<HTMLElement>("[data-customize-edit][data-dragging]");
        if (layer) layer.dispatchEvent(new Event("customize-cancel-drag"));
        else onEscape();
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input:not([type=range]), textarea, select, [contenteditable=true]"))
        return;
      if (event.key.toLowerCase() === "z" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        onUndo();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active, onEscape, onUndo]);
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
  const composerPreview = useCustomizeInterfaceStore((store) => store.composerPreview);
  const setEditing = useCustomizeInterfaceStore((store) => store.setEditing);
  const navigate = useNavigate();
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const anchors = useLiveMeasure(measureAnchors, active && !editing ? "anchors" : null);
  const { undo } = useCustomizeActions();

  useEffect(() => {
    remeasureCustomizeTargets();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Preview and editing changes reflow the composer without a settings write.
  }, [active, editing, composerPreview]);

  // Enter on the frame after mount so the transition has a start state;
  // leave by fading out, then unmount.
  const [entered, setEntered] = useState<EditSurface | null>();
  useLayoutEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => setEntered(editing));
    return () => window.cancelAnimationFrame(frame);
  }, [active, editing]);
  const visible = active && entered === editing;
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

  const [highlighted, setHighlighted] = useState<EditSurface | null>(null);
  // The hovered row unmounts when editing starts, so its leave never fires.
  if (editing && highlighted) setHighlighted(null);
  const back = useCallback(() => setEditing(null), [setEditing]);
  const handleEscape = useCallback(
    () => (useCustomizeInterfaceStore.getState().editing ? back() : close()),
    [back, close],
  );
  useCustomizeKeys(active, handleEscape, undo);

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
      {/* The sheet covers most of a narrow screen, so its rows lead into editing instead. */}
      {sheet ? null : (
        <CustomizeHotspots
          visible={visible}
          highlighted={highlighted}
          onEdit={(surface) => {
            setHighlighted(null);
            setEditing(surface);
          }}
        />
      )}
      <CustomizePopover
        returnFocusTo={lastEdited}
        onDone={close}
        onOpenSettings={openSettings}
        onFineTuneHover={setHighlighted}
        className={cn(
          "transition-[opacity,scale,translate] duration-200 ease-out motion-reduce:transition-none [-webkit-app-region:no-drag]",
          sheet
            ? "inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] origin-bottom"
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
