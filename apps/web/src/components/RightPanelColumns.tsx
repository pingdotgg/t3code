import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { RightPanelSurface } from "../rightPanelStore";
import { SortableTabList } from "./RightPanelTabs";

export interface RightPanelColumnView {
  /** The selected surface; it owns focus and keyboard shortcuts. */
  active: boolean;
  /** Whether any part of the column is inside the strip. */
  visible: boolean;
  /**
   * Whether the whole column is inside the strip. Native browser views draw
   * above the DOM and ignore its clipping, so they only show when this is true.
   */
  unclipped: boolean;
}

// A column counts as shown once this much of it is inside the strip, and as
// fully shown past the second ratio. The first is above zero because a column
// that only touches the strip's edge still reports as intersecting.
const VISIBLE_RATIO = 0.01;
const FULLY_VISIBLE_RATIO = 0.99;
// Visibility key for the chat column; surface ids never contain a newline.
const CHAT_COLUMN_KEY = "\nchat";

export interface ChatColumnView {
  visible: boolean;
  unclipped: boolean;
}

/** Pointer selection preserves focus in edited controls; terminal focus must not reselect columns.
 * Disabled wrappers use display:contents to retain the chat subtree across layout changes.
 */
export function RightPanelColumns(props: {
  enabled: boolean;
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  /** Changes whenever a surface is selected, even the current one, to scroll it into view. */
  revealRequestId: number;
  onActivate: (surface: RightPanelSurface) => void;
  onMoveSurface: (surfaceId: string, toIndex: number) => void;
  renderSurface: (surface: RightPanelSurface, view: RightPanelColumnView) => ReactNode;
  /** Shown as the only panel column when the panel is open without surfaces. */
  emptyColumn?: ReactNode;
  /** Reports when the chat column scrolls in or out of view, so it can pause offscreen work. */
  onChatViewChange?: (view: ChatColumnView) => void;
  /** Reports the ids of the surface columns that are wholly in view. */
  onUnclippedSurfacesChange?: (surfaceIds: readonly string[]) => void;
  /** Changes when something in the chat column, such as its terminal drawer, needs to be seen. */
  chatRevealRequestId?: number;
  children: ReactNode;
}) {
  const { enabled, surfaces, activeSurfaceId, revealRequestId, onActivate, renderSurface } = props;
  const stripRef = useRef<HTMLDivElement>(null);
  const chatColumnRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef(new Map<string, HTMLDivElement>());
  // The chat starts at the strip's left edge, so it starts fully shown.
  const [visibility, setVisibility] = useState<ReadonlyMap<string, "partial" | "full">>(
    () => new Map([[CHAT_COLUMN_KEY, "full"]]),
  );
  const surfaceIdsKey = surfaces.map((surface) => surface.id).join("\n");
  const emptyColumn = surfaces.length === 0 ? (props.emptyColumn ?? null) : null;
  const hasPanelColumns = enabled && (surfaces.length > 0 || emptyColumn !== null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observe DOM clipping to pause offscreen terminals and native views
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !enabled) return;
    // Forget removed columns, so one reopened under the same id starts hidden
    // until the observer measures it.
    const ids = new Set([CHAT_COLUMN_KEY, ...surfaceIdsKey.split("\n")]);
    setVisibility((current) =>
      [...current.keys()].every((id) => ids.has(id))
        ? current
        : new Map([...current].filter(([id]) => ids.has(id))),
    );
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibility((current) => {
          const next = new Map(current);
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.rightPanelColumn;
            if (!id) continue;
            if (entry.intersectionRatio >= FULLY_VISIBLE_RATIO) next.set(id, "full");
            else if (entry.intersectionRatio >= VISIBLE_RATIO) next.set(id, "partial");
            else next.delete(id);
          }
          if (
            next.size === current.size &&
            [...next].every(([id, value]) => current.get(id) === value)
          ) {
            return current;
          }
          return next;
        });
      },
      { root: strip, threshold: [0, VISIBLE_RATIO, FULLY_VISIBLE_RATIO] },
    );
    if (chatColumnRef.current) observer.observe(chatColumnRef.current);
    for (const id of ids) {
      const column = columnRefs.current.get(id);
      if (column) observer.observe(column);
    }
    return () => observer.disconnect();
  }, [enabled, surfaceIdsKey]);

  const chatVisible = visibility.has(CHAT_COLUMN_KEY);
  const chatUnclipped = visibility.get(CHAT_COLUMN_KEY) === "full";
  const onChatViewChange = props.onChatViewChange;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publish chat DOM intersection measurements to terminal and preview presentation owners
  useEffect(() => {
    onChatViewChange?.({ visible: chatVisible, unclipped: chatUnclipped });
  }, [chatVisible, chatUnclipped, onChatViewChange]);

  // Joined so the effect below only fires when the set of wholly shown columns changes.
  const unclippedSurfaceIdsKey = enabled
    ? surfaces
        .filter((surface) => visibility.get(surface.id) === "full")
        .map((surface) => surface.id)
        .join("\n")
    : "";
  const onUnclippedSurfacesChange = props.onUnclippedSurfacesChange;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publish measured column clipping to native preview presentation
  useEffect(() => {
    onUnclippedSurfacesChange?.(
      unclippedSurfaceIdsKey === "" ? [] : unclippedSurfaceIdsKey.split("\n"),
    );
  }, [unclippedSurfaceIdsKey, onUnclippedSurfacesChange]);

  const chatRevealRequestId = props.chatRevealRequestId ?? 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveal the chat DOM column for an imperative terminal focus request
  useEffect(() => {
    if (!enabled || chatRevealRequestId === 0) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    chatColumnRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [enabled, chatRevealRequestId]);

  const activeSurface = surfaces.find((surface) => surface.id === activeSurfaceId);
  const fileRevealRequestId = activeSurface?.kind === "file" ? activeSurface.revealRequestId : 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scroll the selected surface DOM column into view, including repeated selections
  useEffect(() => {
    if (!enabled || !activeSurfaceId) return;
    const column = columnRefs.current.get(activeSurfaceId);
    if (!column) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    column.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: reduceMotion ? "auto" : "smooth",
    });
    // A repeated selection must reveal the column again even when its id is unchanged.
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [enabled, activeSurfaceId, revealRequestId, fileRevealRequestId]);

  // Every column, the chat included, takes half the strip when it shares it,
  // never narrower than a usable column, and later ones scroll past the edge.
  const columnClassName =
    "relative flex min-h-0 w-[max(50%,min(100%,26rem))] shrink-0 snap-start flex-col border-l border-border";

  return (
    <SortableTabList surfaces={surfaces} onMove={props.onMoveSurface} columns>
      <div
        ref={stripRef}
        className={
          enabled
            ? cn(
                "flex min-h-0 min-w-0 flex-1 snap-x snap-proximity overflow-x-auto overflow-y-hidden",
                // Scroll areas contain overscroll on both axes, which would keep
                // a sideways swipe over a file tree or tab bar from reaching the
                // strip. Ones with nothing to scroll sideways pass it on.
                "[&_[data-slot=scroll-area-viewport]:not([data-has-overflow-x])]:overscroll-x-auto",
              )
            : "contents"
        }
        data-right-panel-columns={enabled ? "" : undefined}
      >
        <div
          ref={chatColumnRef}
          data-right-panel-column={CHAT_COLUMN_KEY}
          className={
            enabled
              ? cn(
                  "flex min-h-0 shrink-0 snap-start",
                  hasPanelColumns ? "w-[max(50%,min(100%,32rem))]" : "w-full",
                )
              : "contents"
          }
        >
          {props.children}
        </div>
        {enabled
          ? surfaces.map((surface) => {
              const active = surface.id === activeSurfaceId;
              return (
                <div
                  key={surface.id}
                  ref={(element) => {
                    if (element) columnRefs.current.set(surface.id, element);
                    else columnRefs.current.delete(surface.id);
                  }}
                  data-right-panel-column={surface.id}
                  data-active-column={active}
                  className={columnClassName}
                  onPointerDownCapture={() => {
                    if (!active) onActivate(surface);
                  }}
                  onFocusCapture={() => {
                    if (!active) onActivate(surface);
                  }}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5",
                      active ? "bg-primary" : "bg-transparent",
                    )}
                  />
                  {renderSurface(surface, {
                    active,
                    visible: visibility.has(surface.id),
                    unclipped: visibility.get(surface.id) === "full",
                  })}
                </div>
              );
            })
          : null}
        {enabled && emptyColumn !== null ? (
          <div className={columnClassName}>{emptyColumn}</div>
        ) : null}
      </div>
    </SortableTabList>
  );
}
