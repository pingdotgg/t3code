import { LegendList } from "@legendapp/list/react";
import { useRef, type ReactNode } from "react";

export interface WorkItemListItem {
  readonly key: string;
  /** Items of one type are sized alike; LegendList estimates unseen ones from their type. */
  readonly type: string;
  readonly node: ReactNode;
}

const itemKey = (item: WorkItemListItem) => item.key;
const itemType = (item: WorkItemListItem) => item.type;
const renderItem = ({ item }: { item: WorkItemListItem }) => item.node;

// Chrome stops re-checking content-visibility on rows moved with moveBefore, so a row
// LegendList reorders can stay blank on screen; without it the list falls back to insertBefore.
const withoutMoveBefore = (host: HTMLDivElement | null) => {
  const slots = host?.querySelector(".legend-list-content-container > div");
  if (slots) Object.defineProperty(slots, "moveBefore", { value: undefined });
};

/**
 * A list page's rows, mounted only near the view. It scrolls the page's own scroller, so the
 * pinned controls, notices and footer around it stay where they are.
 */
export function WorkItemWindowedList({
  items,
  scrollElement,
  estimatedItemSize,
}: {
  items: ReadonlyArray<WorkItemListItem>;
  /** The page's scroller; null until it mounts. */
  scrollElement: HTMLElement | null;
  estimatedItemSize: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  return (
    <div ref={host} className="contents">
      <LegendList<WorkItemListItem>
        data={items}
        keyExtractor={itemKey}
        getItemType={itemType}
        renderItem={renderItem}
        extraData={items}
        recycleItems={false}
        scrollElement={scrollElement}
        estimatedItemSize={estimatedItemSize}
        drawDistance={720}
        // The rows' container exists once the list has laid out its first rows.
        onLoad={() => withoutMoveBefore(host.current)}
      />
    </div>
  );
}
