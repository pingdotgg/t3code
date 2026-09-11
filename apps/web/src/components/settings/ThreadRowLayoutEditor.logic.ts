import type {
  SidebarThreadRowComponent,
  SidebarThreadRowPlacement,
} from "@t3tools/contracts/settings";

export type ThreadDetailDropTarget =
  | { kind: "hide" }
  | {
      kind: "place";
      row: SidebarThreadRowPlacement["row"];
      alignment: SidebarThreadRowPlacement["alignment"];
      relativeTo?: SidebarThreadRowComponent;
      edge?: "before" | "after";
    };

/** Apply a drop once, preserving other details and preventing an empty saved layout. */
export function dropThreadDetail(
  layout: ReadonlyArray<SidebarThreadRowPlacement>,
  component: SidebarThreadRowComponent,
  target: ThreadDetailDropTarget | null,
) {
  if (!target) return layout;
  const remaining = layout.filter((item) => item.component !== component);
  if (target.kind === "hide")
    return remaining.length && remaining.length !== layout.length ? remaining : layout;
  if (target.relativeTo === component) return layout;
  const placement = { component, row: target.row, alignment: target.alignment };
  const relativeIndex = remaining.findIndex(
    (item) =>
      item.component === target.relativeTo &&
      item.row === target.row &&
      item.alignment === target.alignment,
  );
  const next = [...remaining];
  next.splice(
    relativeIndex < 0 ? remaining.length : relativeIndex + (target.edge === "after" ? 1 : 0),
    0,
    placement,
  );
  return next.length === layout.length &&
    next.every(
      (item, i) =>
        item.component === layout[i]?.component &&
        item.row === layout[i]?.row &&
        item.alignment === layout[i]?.alignment,
    )
    ? layout
    : next;
}

/** The visible space between the two groups, including unused width inside a flexed title. */
export function threadRowBlankSpace(
  row: { left: number; right: number },
  leftDetails: ReadonlyArray<{ right: number }>,
  rightDetails: ReadonlyArray<{ left: number }>,
) {
  const start = Math.max(row.left, ...leftDetails.map((detail) => detail.right));
  const end = Math.min(row.right, ...rightDetails.map((detail) => detail.left));
  return { left: start - row.left, width: Math.max(0, end - start) };
}
