import { LegendList } from "@legendapp/list/react";
import type { ReactNode } from "react";

export interface WorkItemListItem {
  readonly key: string;
  /** Items of one type are sized alike; LegendList estimates unseen ones from their type. */
  readonly type: string;
  readonly node: ReactNode;
}

const itemKey = (item: WorkItemListItem) => item.key;
const itemType = (item: WorkItemListItem) => item.type;
const renderItem = ({ item }: { item: WorkItemListItem }) => item.node;

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
  );
}
