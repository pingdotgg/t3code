import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
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
// bounds and the surface adapts its own content to the frame it is given. The
// frame also grows past the user's height when the surface's chrome would
// otherwise leave its body no room (see extensionSurfaceMinHeight).
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

function clampExtensionDockHeight(height: number | undefined, floor = 0): number {
  const safeHeight =
    height !== undefined && Number.isFinite(height) ? height : DEFAULT_EXTENSION_DOCK_HEIGHT;
  return Math.min(
    Math.max(Math.round(safeHeight), MIN_EXTENSION_DOCK_HEIGHT, floor),
    maxExtensionDockHeight(),
  );
}

// Height the host guarantees a surface's flexible body. Surface chrome can grow
// with content (the terminal view lists one row per session), so no fixed dock
// minimum keeps the body visible; the frame instead auto-grows to fit.
export const MIN_EXTENSION_SURFACE_BODY_HEIGHT = 120;

type SurfaceStyle = Pick<
  CSSStyleDeclaration,
  | "display"
  | "flexDirection"
  | "flexGrow"
  | "position"
  | "rowGap"
  | "paddingTop"
  | "paddingBottom"
  | "borderTopWidth"
  | "borderBottomWidth"
>;

const px = (value: string) => Number.parseFloat(value) || 0;
const isColumnFlex = (style: SurfaceStyle) =>
  (style.display === "flex" || style.display === "inline-flex") && style.flexDirection === "column";

type GetSurfaceStyle = (element: Element) => SurfaceStyle;
const computedStyle: GetSurfaceStyle = (element) => getComputedStyle(element);

/** The surface's layout root: the first column-flex element below single-child wrappers. */
function extensionSurfaceRoot(panel: Element, getStyle: GetSurfaceStyle): Element | null {
  let element = panel.firstElementChild;
  for (let depth = 0; element && depth < 8; depth++) {
    const style = getStyle(element);
    if (style.display !== "contents" && isColumnFlex(style) && element.children.length > 1)
      return element;
    element =
      style.display === "contents" || element.children.length === 1
        ? element.firstElementChild
        : null;
  }
  return null;
}

/**
 * The frame height a surface needs so its flexible body keeps
 * `MIN_EXTENSION_SURFACE_BODY_HEIGHT`: the non-growing children of its
 * column-flex root plus that floor, or 0 when the surface has no such root.
 * Child heights are intrinsic, so growing the frame never changes the answer.
 */
export function extensionSurfaceMinHeight(
  panel: Element,
  getStyle: GetSurfaceStyle = computedStyle,
): number {
  const root = extensionSurfaceRoot(panel, getStyle);
  if (!root) return 0;
  const rootStyle = getStyle(root);
  let fixed = 0;
  let flowCount = 0;
  let flexible = false;
  for (const child of root.children) {
    const style = getStyle(child);
    if (style.display === "none" || style.position === "absolute" || style.position === "fixed")
      continue;
    flowCount++;
    if (px(style.flexGrow) > 0) flexible = true;
    else fixed += child.getBoundingClientRect().height;
  }
  if (!flexible) return 0;
  return Math.ceil(
    fixed +
      px(rootStyle.rowGap) * Math.max(flowCount - 1, 0) +
      px(rootStyle.paddingTop) +
      px(rootStyle.paddingBottom) +
      px(rootStyle.borderTopWidth) +
      px(rootStyle.borderBottomWidth) +
      MIN_EXTENSION_SURFACE_BODY_HEIGHT,
  );
}

/**
 * Track the dock height the mounted surface needs: its own minimum plus the
 * dock's tab strip. Re-measures when the surface's children resize or change;
 * equal answers bail out of React, so a frame that grows to fit settles.
 */
function useExtensionDockContentFloor(active: boolean) {
  const frameRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [floor, setFloor] = useState(0);
  useEffect(() => {
    const frame = frameRef.current;
    const panel = panelRef.current;
    if (
      !active ||
      !frame ||
      !panel ||
      typeof ResizeObserver === "undefined" ||
      typeof MutationObserver === "undefined"
    ) {
      setFloor(0);
      return;
    }
    const measure = () => {
      const surface = extensionSurfaceMinHeight(panel);
      const dockChrome =
        frame.getBoundingClientRect().height - panel.getBoundingClientRect().height;
      setFloor(surface > 0 ? Math.ceil(surface + dockChrome) : 0);
    };
    const resizes = new ResizeObserver(measure);
    let root: Element | null = null;
    // Chrome growth inside a root child (a new session row) resizes that child.
    // Only child-list changes at or above the root can change which elements
    // count, so deeper surface churn (terminal output) never reaches layout reads.
    const observeSurface = () => {
      resizes.disconnect();
      resizes.observe(panel);
      root = extensionSurfaceRoot(panel, computedStyle);
      if (root) for (const child of root.children) resizes.observe(child);
      measure();
    };
    const mutations = new MutationObserver((records) => {
      const current = root;
      if (
        !current?.isConnected ||
        records.some((record) => record.target === current || record.target.contains(current))
      )
        observeSurface();
    });
    mutations.observe(panel, { childList: true, subtree: true });
    observeSurface();
    return () => {
      resizes.disconnect();
      mutations.disconnect();
    };
  }, [active]);
  return { floor, frameRef, panelRef };
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
  const { floor: contentFloor, frameRef, panelRef } = useExtensionDockContentFloor(dock.isOpen);
  // The content floor raises the frame without rewriting the user's height, so
  // the dock returns to it once the surface's chrome shrinks again.
  const committedHeight = clampExtensionDockHeight(dock.height, contentFloor);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const dockHeight = dragHeight === null ? committedHeight : Math.max(dragHeight, contentFloor);
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
      ref={frameRef}
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
        ref={panelRef}
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
