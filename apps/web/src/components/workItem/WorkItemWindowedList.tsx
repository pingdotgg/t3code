import { LegendList } from "@legendapp/list/react";
import type { ReactNode } from "react";

export interface WorkItemListItem {
  readonly key: string;
  /** Items of one type are sized alike; LegendList estimates unseen ones from their type. */
  readonly type: string;
  readonly node: ReactNode;
}

// Chrome stops re-checking content-visibility on nodes moved with moveBefore, so a row LegendList
// reorders can stay blank on screen. The element whose children it reorders is the nearest one
// holding two of our items; without moveBefore there, the list falls back to insertBefore.
const withoutMoveBefore = (item: HTMLElement | null) => {
  let slots = item?.parentElement ?? null;
  while (slots && !slots.hasAttribute("data-work-item-list")) {
    if (slots.querySelectorAll("[data-work-item]").length > 1) {
      if (!Object.hasOwn(slots, "moveBefore")) {
        Object.defineProperty(slots, "moveBefore", { value: undefined });
      }
      return;
    }
    slots = slots.parentElement;
  }
};

const itemKey = (item: WorkItemListItem) => item.key;
const itemType = (item: WorkItemListItem) => item.type;
const renderItem = ({ item }: { item: WorkItemListItem }) => (
  <div ref={withoutMoveBefore} data-work-item className="contents">
    {item.node}
  </div>
);

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
  return (
    <div data-work-item-list className="contents">
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
      />
    </div>
  );
}
