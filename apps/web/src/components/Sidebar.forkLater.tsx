import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { splitLaterSnoozes } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import type { SidebarListItem } from "./Sidebar.logic";
import { SidebarSectionHeader } from "./sidebar/SidebarListMarkers";

const LATER_SHELF_EXPANDED_KEY = "t3code:sidebar:later-expanded";

type ShelfThread = {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly snoozedUntil?: string | null;
};

// Later rows keep the "snoozed" section, so drags and menus treat them as snoozed.
export function useLaterShelf<T extends ShelfThread>(
  snoozed: readonly T[],
  routeThreadKey: string | null,
) {
  const [expanded, setExpanded] = useLocalStorage(LATER_SHELF_EXPANDED_KEY, false, Schema.Boolean);
  const { timed, later } = splitLaterSnoozes(snoozed);
  const visible = expanded
    ? later
    : later.filter(
        (thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
      );
  return { timed, later, visible, expanded, toggle: () => setExpanded((value) => !value) };
}

export function LaterShelfHeader(props: {
  readonly shelf: ReturnType<typeof useLaterShelf>;
  readonly className: string;
}) {
  const { shelf } = props;
  const gt = useGT();
  return (
    <SidebarSectionHeader
      marker="later-header"
      className={props.className}
      label={gt("Later", { $context: "sidebar section" })}
      count={shelf.later.length}
      toggle={{ expanded: shelf.expanded, onToggle: shelf.toggle }}
    />
  );
}

const isMarker = (item: SidebarListItem, marker: "snoozed-header" | "later-header") =>
  item.kind === "marker" && item.marker === marker;

// Snoozed shelves never take drops, so a drag only removes the dragged row from them.
export function projectSnoozeShelves(
  projected: SidebarListItem[],
  items: readonly SidebarListItem[],
  activeKey: string,
  counts: { readonly timed: number; readonly later: number } | undefined,
) {
  if (counts === undefined) return;
  const laterAt = items.findIndex((item) => isMarker(item, "later-header"));
  const laterKeys = new Set(
    laterAt === -1
      ? []
      : items
          .slice(laterAt)
          .flatMap((item) =>
            item.kind === "thread" && item.section === "snoozed" ? [item.key] : [],
          ),
  );
  const activeSnoozed = items.some(
    (item) => item.kind === "thread" && item.key === activeKey && item.section === "snoozed",
  );
  const rows = projected.filter((item) => item.kind === "thread" && item.section === "snoozed");
  const block: SidebarListItem[] = [];
  if (counts.timed - (activeSnoozed && !laterKeys.has(activeKey) ? 1 : 0) > 0) {
    block.push({ kind: "marker", marker: "snoozed-header" });
  }
  block.push(...rows.filter((item) => item.kind === "thread" && !laterKeys.has(item.key)));
  if (counts.later - (laterKeys.has(activeKey) ? 1 : 0) > 0) {
    block.push({ kind: "marker", marker: "later-header" });
  }
  block.push(...rows.filter((item) => item.kind === "thread" && laterKeys.has(item.key)));
  const kept = projected.filter(
    (item) => !isMarker(item, "snoozed-header") && !rows.includes(item),
  );
  const settledAt = kept.findIndex(
    (item) => item.kind === "marker" && item.marker === "settled-header",
  );
  kept.splice(settledAt === -1 ? kept.length : settledAt, 0, ...block);
  projected.splice(0, projected.length, ...kept);
}
