import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";

const EMPTY_KEYS: readonly (string | null)[] = [];

/** One viewport for the sidebar. Retain the last focused row and rows that own a rename or drag. */
export function SidebarVirtualList<T extends { key: string }>({
  data,
  materialize = false,
  draggingKey,
  onViewportRef,
  renderItem,
  getItemType,
  activeKey,
  revealVersion,
  retainedKeys = EMPTY_KEYS,
  estimatedItemSize = 83,
  fillSpaceKey,
  role = "list",
  id,
  "aria-label": label,
}: {
  data: T[];
  materialize?: boolean;
  draggingKey?: string | undefined;
  onViewportRef?: (node: HTMLElement | null) => void;
  renderItem: (item: T, index: number) => ReactNode;
  getItemType?: (item: T) => string;
  activeKey: string | null;
  revealVersion?: string;
  retainedKeys?: readonly (string | null)[];
  estimatedItemSize?: number;
  /** A non-interactive item that keeps the following shelves at the viewport bottom. */
  fillSpaceKey?: string;
  role?: "list" | "listbox";
  id?: string;
  "aria-label": string;
}) {
  const listRef = useRef<LegendListRef>(null);
  const revealed = useRef<{ key: string; version: string | undefined } | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [fillSpace, setFillSpace] = useState(0);
  const extraData = useMemo(() => ({ renderItem, fillSpace }), [renderItem, fillSpace]);
  const [fade, setFade] = useState({ top: false, bottom: false });
  const keys = materialize
    ? data.map((item) => item.key)
    : [
        ...new Set(
          [activeKey, focusedKey, fillSpaceKey, ...retainedKeys].filter((key) => key != null),
        ),
      ];

  useEffect(() => () => onViewportRef?.(null), [onViewportRef]);

  const updateFade = useCallback(() => {
    const viewport = listRef.current?.getScrollableNode();
    if (!viewport) return;
    const top = viewport.scrollTop > 1;
    const bottom = viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1;
    setFade((previous) =>
      previous.top === top && previous.bottom === bottom ? previous : { top, bottom },
    );
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!loaded || !list || !fillSpaceKey) return;
    const viewport: HTMLElement = list.getScrollableNode();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const state = list.getState();
        // Subtract the measured spacer, not the pending React value, so a resize
        // cannot feed its previous height back into the next content estimate.
        const naturalHeight = state.contentLength - (state.sizes.get(fillSpaceKey) ?? 0);
        setFillSpace(Math.max(0, viewport.clientHeight - naturalHeight));
      });
    };
    const unlisten = list.getState().listen("totalSize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      unlisten();
    };
  }, [fillSpaceKey, loaded]);

  useEffect(() => {
    if (!loaded) return;
    if (activeKey === null) {
      revealed.current = null;
      return;
    }
    const index = data.findIndex((item) => item.key === activeKey);
    if (index < 0) {
      revealed.current = null;
      return;
    }
    if (revealed.current?.key === activeKey && revealed.current.version === revealVersion) return;
    const list = listRef.current;
    if (!list) return;
    // Wait for the new data's layout and scroll anchoring before revealing its target.
    const frame = requestAnimationFrame(() => {
      revealed.current = { key: activeKey, version: revealVersion };
      const viewport = list.getScrollableNode();
      const row = Array.from(
        viewport.querySelectorAll<HTMLElement>("[data-sidebar-list-key]"),
      ).find((element) => element.dataset.sidebarListKey === activeKey);
      if (row) {
        const rect = row.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        if (rect.top >= bounds.top && rect.bottom <= bounds.bottom) return;
      }
      void list.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeKey, data, loaded, revealVersion]);

  return (
    <LegendList
      ref={listRef}
      data-slot="scroll-area-viewport"
      id={id}
      role={role}
      aria-label={label}
      data={data}
      extraData={extraData}
      dataVersion={keys.join("\0")}
      alwaysRender={{ keys }}
      keyExtractor={(item) => item.key}
      {...(getItemType ? { getItemType } : {})}
      renderItem={({ item, index }) => (
        <div
          data-sidebar-list-key={item.key}
          data-sidebar-dragging={item.key === draggingKey || undefined}
          aria-hidden={item.key === fillSpaceKey || undefined}
          className={item.key === fillSpaceKey ? undefined : "pb-px"}
          style={item.key === fillSpaceKey ? { height: fillSpace } : undefined}
        >
          {renderItem(item, index)}
        </div>
      )}
      estimatedItemSize={estimatedItemSize}
      drawDistance={400}
      recycleItems={false}
      maintainVisibleContentPosition
      className={cn(
        "relative h-0 min-h-0 flex-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        // Sortable cards translate past their measured row boxes while dragging.
        "[&_:has(>[data-sidebar-list-key])]:[contain:layout_style]!",
        "[&_:has(>[data-sidebar-list-key][data-sidebar-dragging])]:z-20",
        getVirtualizedScrollFadeClassName(fade),
      )}
      onLoad={() => {
        onViewportRef?.(listRef.current?.getScrollableNode() ?? null);
        setLoaded(true);
        updateFade();
      }}
      onScroll={updateFade}
      onItemSizeChanged={updateFade}
      onFocusCapture={(event) => {
        const row = event.target.closest<HTMLElement>("[data-sidebar-list-key]");
        // Portal focus still bubbles through this list. Keep its owning row mounted.
        if (row?.dataset.sidebarListKey) setFocusedKey(row.dataset.sidebarListKey);
      }}
    />
  );
}
