import { scopedThreadKey } from "../../lib/scopedEntities";
import { isThreadListV2ListItem, type ThreadListV2ListItem } from "./threadListV2";
import type { ThreadDragRow } from "./threadDragGap";
import type { ThreadDragSection } from "./threadOrder";

type ListItem = { readonly type: string; readonly key: string };
type DragListState = {
  readonly positionAtIndex: (index: number) => number;
  readonly sizes: ReadonlyMap<string, number>;
};

export function dragSection(item: ThreadListV2ListItem): ThreadDragSection | null {
  if (item.type === "v2-settled-shelf") return "settled";
  if (item.type !== "v2-thread") return null;
  if (item.item.snoozed) return "snoozed";
  if (item.item.variant === "slim") return "settled";
  return item.item.pinned ? "pinned" : "active";
}

/** The list's untransformed layout. The gap is a transform, so hit testing
 * never sees it. LegendList only reports sizes for measured rows. */
export function snapshotRows(
  state: DragListState,
  items: readonly ListItem[],
  estimatedRowHeight: number,
) {
  const rows: ThreadDragRow[] = [];
  const offsets: Record<string, number> = {};
  let cursor = 0;
  let liveBlock = true;
  items.forEach((item, index) => {
    const position = state.positionAtIndex(index);
    const offset = Number.isFinite(position) ? position : cursor;
    const next = state.positionAtIndex(index + 1);
    const height =
      state.sizes.get(item.key) ??
      (Number.isFinite(next) && next > offset ? next - offset : estimatedRowHeight);
    cursor = offset + height;
    offsets[item.key] = offset;
    if (item.type !== "v2-thread" && item.type !== "v2-pending") liveBlock = false;
    if (!isThreadListV2ListItem(item)) return;
    rows.push({
      key: item.key,
      threadKey:
        item.type === "v2-thread"
          ? scopedThreadKey(item.item.thread.environmentId, item.item.thread.id)
          : null,
      section: item.type === "v2-thread" && !liveBlock ? null : dragSection(item),
      offset,
      height,
    });
  });
  return { rows, offsets };
}

export function draggableThreadKeys(items: readonly ListItem[]) {
  const keys = new Set<string>();
  for (const item of items) {
    if (item.type === "v2-pending") continue;
    if (!isThreadListV2ListItem(item) || item.type !== "v2-thread") break;
    const section = dragSection(item);
    if (section !== "pinned" && section !== "active") break;
    keys.add(item.key);
  }
  return keys;
}
