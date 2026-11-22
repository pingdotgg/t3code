import type { ThreadId } from "@t3tools/contracts";

export type ChatSplitDirection = "left" | "right" | "bottom";
type PaneId = ThreadId | null;
type Axis = "horizontal" | "vertical";

export type ChatSplitLayout =
  | { readonly kind: "pane"; readonly id: PaneId }
  | { readonly kind: "group"; readonly axis: Axis; readonly children: readonly ChatSplitLayout[] };

export const MAIN_CHAT_PANE: ChatSplitLayout = { kind: "pane", id: null };

export function splitChatPane(
  layout: ChatSplitLayout,
  target: PaneId,
  id: ThreadId,
  direction: ChatSplitDirection,
): ChatSplitLayout {
  const axis = direction === "bottom" ? "vertical" : "horizontal";
  const newPane = { kind: "pane", id } as const;
  const before = direction === "left";
  if (layout.kind === "pane") {
    if (layout.id !== target) return layout;
    return { kind: "group", axis, children: before ? [newPane, layout] : [layout, newPane] };
  }

  if (layout.axis === axis) {
    const index = layout.children.findIndex(
      (child) => child.kind === "pane" && child.id === target,
    );
    if (index !== -1) {
      const children = layout.children.slice();
      children.splice(index + (before ? 0 : 1), 0, newPane);
      return { ...layout, children };
    }
  }

  const children = layout.children.map((child) => splitChatPane(child, target, id, direction));
  return children.some((child, index) => child !== layout.children[index])
    ? { ...layout, children }
    : layout;
}

/** A split at the parent's axis would give its panes half the room they asked for. */
function flattenAxis(axis: Axis, children: readonly ChatSplitLayout[]): readonly ChatSplitLayout[] {
  return children.flatMap((child) =>
    child.kind === "group" && child.axis === axis ? flattenAxis(axis, child.children) : [child],
  );
}

export function closeChatPane(layout: ChatSplitLayout, id: ThreadId): ChatSplitLayout | null {
  if (layout.kind === "pane") return layout.id === id ? null : layout;
  const children = layout.children.flatMap((child) => {
    const next = closeChatPane(child, id);
    return next === null ? [] : [next];
  });
  if (children.length <= 1) return children[0] ?? null;
  const flattened = flattenAxis(layout.axis, children);
  if (flattened.length <= 1) return flattened[0] ?? null;
  return { ...layout, children: flattened };
}

interface PaneBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function chatPaneBounds(
  layout: ChatSplitLayout,
  bounds: PaneBounds = { left: 0, top: 0, width: 100, height: 100 },
): readonly (PaneBounds & { readonly id: PaneId })[] {
  if (layout.kind === "pane") return [{ ...bounds, id: layout.id }];

  const horizontal = layout.axis === "horizontal";
  const width = horizontal ? bounds.width / layout.children.length : bounds.width;
  const height = horizontal ? bounds.height : bounds.height / layout.children.length;
  return layout.children.flatMap((child, index) =>
    chatPaneBounds(child, {
      left: bounds.left + (horizontal ? width * index : 0),
      top: bounds.top + (horizontal ? 0 : height * index),
      width,
      height,
    }),
  );
}
