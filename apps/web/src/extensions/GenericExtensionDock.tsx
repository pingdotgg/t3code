import { useCallback, useId, useRef, useState, type KeyboardEvent } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { PanelBottomCloseIcon, XIcon } from "lucide-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Button } from "../components/ui/button";
import { usePanelAnimationSettings, usePanelPresence } from "../panelAnimations";
import {
  selectThreadExtensionDock,
  useRightPanelStore,
  type ExtensionDockState,
} from "../rightPanelStore";
import { WorkspaceExtensionSurface, useWorkspaceSurfaceTitles } from "./workspaceRegistry";

// The dock frame stays host-owned: the user drags its height within these
// bounds and the surface adapts its own content to the frame it is given.
const DEFAULT_EXTENSION_DOCK_HEIGHT = 256;
const MIN_EXTENSION_DOCK_HEIGHT = 160;
const MAX_EXTENSION_DOCK_HEIGHT_RATIO = 0.75;

function maxExtensionDockHeight(): number {
  if (typeof window === "undefined") return DEFAULT_EXTENSION_DOCK_HEIGHT;
  return Math.max(
    MIN_EXTENSION_DOCK_HEIGHT,
    Math.floor(window.innerHeight * MAX_EXTENSION_DOCK_HEIGHT_RATIO),
  );
}

export function clampExtensionDockHeight(height: number | undefined): number {
  const safeHeight =
    height !== undefined && Number.isFinite(height) ? height : DEFAULT_EXTENSION_DOCK_HEIGHT;
  return Math.min(
    Math.max(Math.round(safeHeight), MIN_EXTENSION_DOCK_HEIGHT),
    maxExtensionDockHeight(),
  );
}

export function GenericExtensionDock({ threadRef }: { threadRef: ScopedThreadRef }) {
  const dock = useRightPanelStore((state) =>
    selectThreadExtensionDock(state.extensionDockByThreadKey, threadRef),
  );
  return dock.surfaces.length ? (
    <ThreadExtensionDock key={scopedThreadKey(threadRef)} threadRef={threadRef} dock={dock} />
  ) : null;
}

function ThreadExtensionDock({
  threadRef,
  dock,
}: {
  threadRef: ScopedThreadRef;
  dock: ExtensionDockState;
}) {
  const scope = scopedThreadKey(threadRef);
  const titles = useWorkspaceSurfaceTitles(threadRef.environmentId);
  const panelId = useId();
  const selected = dock.surfaces.find((surface) => surface.id === dock.activeSurfaceId);
  const [retained, setRetained] = useState(dock.isOpen ? selected : undefined);
  // A hidden selection cannot activate a cold factory. Only retain a still-open viewer.
  if (dock.isOpen && retained !== selected) setRetained(selected);
  const rendered = dock.isOpen
    ? selected
    : dock.surfaces.find(
        (surface) =>
          surface.id === retained?.id && surface.viewerGeneration === retained.viewerGeneration,
      );
  const animations = usePanelAnimationSettings();
  const presence = usePanelPresence(
    dock.isOpen,
    true,
    animations.active,
    scope,
    animations.durationMs,
  );
  const selectedIndex = dock.surfaces.findIndex((surface) => surface.id === dock.activeSurfaceId);
  const committedHeight = clampExtensionDockHeight(dock.height);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const dockHeight = dragHeight ?? committedHeight;
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    height: number;
    moved: boolean;
  } | null>(null);
  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeStateRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: dockHeight,
        height: dockHeight,
        moved: false,
      };
    },
    [dockHeight],
  );
  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const next = clampExtensionDockHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
    );
    if (next === resizeState.height) return;
    resizeState.height = next;
    resizeState.moved = true;
    setDragHeight(next);
  }, []);
  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDragHeight(null);
      if (resizeState.moved) {
        useRightPanelStore.getState().setExtensionDockHeight(threadRef, resizeState.height);
      }
    },
    [threadRef],
  );
  const activate = (index: number) => {
    const surface = dock.surfaces[index];
    if (surface) useRightPanelStore.getState().activateDockExtension(threadRef, surface.id);
  };
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % dock.surfaces.length;
    else if (event.key === "ArrowLeft")
      next = (index + dock.surfaces.length - 1) % dock.surfaces.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = dock.surfaces.length - 1;
    else return;
    event.preventDefault();
    activate(next);
    const tabs = event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[next]?.focus();
  };
  return (
    <aside
      aria-label="Extension dock"
      aria-hidden={!dock.isOpen}
      inert={!dock.isOpen}
      hidden={!presence.present}
      className="relative flex min-h-0 min-w-0 shrink flex-col overflow-hidden border-t border-border/80 bg-background"
      style={{
        display: presence.present ? undefined : "none",
        height: dock.isOpen ? `${dockHeight}px` : 0,
        // The persisted height stays a pixel value; the chat column still caps
        // the frame when the window shrinks below the stored size.
        maxHeight: "75%",
        transition:
          animations.active && dragHeight === null
            ? `height ${animations.durationMs}ms ease-out`
            : "none",
      }}
    >
      {dock.isOpen ? (
        <div
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
        />
      ) : null}
      <div className="flex min-w-0 shrink-0 items-center gap-1 border-b border-border/60 px-1">
        <div
          role="tablist"
          aria-label="Extension dock views"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {dock.surfaces.map((surface, index) => {
            const title = titles.get(surface.record.surfaceId) ?? surface.record.fallback;
            const active = surface.id === selected?.id;
            return (
              <div key={surface.id} className="flex shrink-0 items-center">
                <Button
                  id={`${panelId}-tab-${index}`}
                  role="tab"
                  aria-selected={active}
                  aria-controls={panelId}
                  tabIndex={active ? 0 : -1}
                  variant={active ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => activate(index)}
                  onKeyDown={(event) => moveFocus(event, index)}
                >
                  {title}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Close ${title}`}
                  onClick={() =>
                    useRightPanelStore.getState().closeDockExtension(threadRef, surface.id)
                  }
                >
                  <XIcon className="size-3" />
                </Button>
              </div>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Hide extension dock"
          onClick={() => useRightPanelStore.getState().hideExtensionDock(threadRef)}
        >
          <PanelBottomCloseIcon className="size-4" />
        </Button>
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${panelId}-tab-${selectedIndex}`}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        {rendered ? (
          <WorkspaceExtensionSurface
            key={JSON.stringify([scope, "bottom-dock", rendered.id, rendered.viewerGeneration])}
            record={rendered.record}
            visible={dock.isOpen}
            onRecordChange={(record) =>
              useRightPanelStore
                .getState()
                .updateExtensionRecord(threadRef, record, rendered.viewerGeneration)
            }
          />
        ) : null}
      </div>
    </aside>
  );
}
