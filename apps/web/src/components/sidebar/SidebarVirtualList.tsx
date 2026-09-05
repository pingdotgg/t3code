import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";

const EMPTY_KEYS: readonly (string | null)[] = [];

/** One viewport for the sidebar. Retain the last focused row and rows that own a rename or drag. */
export function SidebarVirtualList<T extends { key: string }>({
  data,
  renderItem,
  getItemType,
  activeKey,
  revealVersion,
  retainedKeys = EMPTY_KEYS,
  estimatedItemSize = 83,
  role = "list",
  id,
  "aria-label": label,
}: {
  data: T[];
  renderItem: (item: T, index: number) => ReactNode;
  getItemType?: (item: T) => string;
  activeKey: string | null;
  revealVersion?: string;
  retainedKeys?: readonly (string | null)[];
  estimatedItemSize?: number;
  role?: "list" | "listbox";
  id?: string;
  "aria-label": string;
}) {
  const listRef = useRef<LegendListRef>(null);
  const revealed = useRef<{ key: string; version: string | undefined } | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [fade, setFade] = useState({ top: false, bottom: false });
  const keys = [...new Set([activeKey, focusedKey, ...retainedKeys].filter((key) => key !== null))];

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
      extraData={renderItem}
      dataVersion={keys.join("\0")}
      alwaysRender={{ keys }}
      keyExtractor={(item) => item.key}
      {...(getItemType ? { getItemType } : {})}
      renderItem={({ item, index }) => (
        <div data-sidebar-list-key={item.key} className="pb-px">
          {renderItem(item, index)}
        </div>
      )}
      estimatedItemSize={estimatedItemSize}
      drawDistance={400}
      recycleItems={false}
      maintainVisibleContentPosition
      className={cn(
        "h-0 min-h-0 flex-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        // Sortable cards translate past their measured row boxes while dragging.
        "[&_:has(>[data-sidebar-list-key])]:[contain:layout_style]!",
        getVirtualizedScrollFadeClassName(fade),
      )}
      onLoad={() => {
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
