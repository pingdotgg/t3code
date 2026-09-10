import type { ContextMenuItem } from "@t3tools/contracts";

import type { AdjacentPanes, PaneSplitDirection } from "~/splitPaneTree";
import type { RightPanelSurface } from "~/rightPanelStore";

export type WorkspaceTabContextTarget =
  | { readonly _tag: "Thread" }
  | { readonly _tag: "Surface"; readonly surface: RightPanelSurface };

export type TabContextMenuAction =
  | "copy-path"
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all"
  | "move-group-up"
  | "move-group-down"
  | "move-group-left"
  | "move-group-right"
  | "split-right"
  | "split-down"
  | "split-and-move"
  | "move-up"
  | "move-down"
  | "move-left"
  | "move-right";

/** A move into an existing pane selected from a tab context menu. */
export type WorkspaceTabLayoutAction = {
  readonly _tag: "MoveToGroup";
  readonly direction: PaneSplitDirection;
};

export function buildWorkspaceTabContextMenuItems(input: {
  readonly target: WorkspaceTabContextTarget;
  readonly surfaceCount: number;
  readonly surfaceIndex: number;
  readonly adjacentGroups: AdjacentPanes;
  readonly moveToGroupAvailable: boolean;
  readonly copyToSplitAvailable: boolean;
  readonly moveToSplitAvailable: boolean;
}): readonly ContextMenuItem<TabContextMenuAction>[] {
  const items: ContextMenuItem<TabContextMenuAction>[] = [];
  if (input.target._tag === "Surface") {
    if (input.target.surface.kind === "file") {
      items.push({ id: "copy-path", label: "Copy path" });
    }
    items.push(
      { id: "close", label: "Close" },
      {
        id: "close-others",
        label: "Close others",
        disabled: input.surfaceCount <= 1,
      },
      {
        id: "close-to-right",
        label: "Close to the right",
        disabled: input.surfaceIndex >= input.surfaceCount - 1,
      },
      {
        id: "close-all",
        label: "Close all",
        disabled: input.surfaceCount === 0,
      },
    );
  }
  const moveGroupItems = input.moveToGroupAvailable
    ? directionalGroupItems(input.adjacentGroups)
    : [];
  if (input.copyToSplitAvailable || input.moveToSplitAvailable || moveGroupItems.length > 0) {
    items.push(
      { id: "split-right", label: "Split Right", disabled: !input.copyToSplitAvailable },
      { id: "split-down", label: "Split Down", disabled: !input.copyToSplitAvailable },
      {
        id: "split-and-move",
        label: "Split & Move",
        disabled: !input.moveToSplitAvailable && moveGroupItems.length === 0,
        children: [
          { id: "move-up", label: "Split Up", disabled: !input.moveToSplitAvailable },
          { id: "move-down", label: "Split Down", disabled: !input.moveToSplitAvailable },
          { id: "move-left", label: "Split Left", disabled: !input.moveToSplitAvailable },
          { id: "move-right", label: "Split Right", disabled: !input.moveToSplitAvailable },
          ...moveGroupItems,
        ],
      },
    );
  }
  return items;
}

function directionalGroupItems(
  groups: AdjacentPanes,
): readonly ContextMenuItem<TabContextMenuAction>[] {
  return (["up", "down", "left", "right"] as const).flatMap((direction) => {
    if (!groups[direction]) return [];
    const label =
      direction === "up"
        ? "Move Above"
        : direction === "down"
          ? "Move Below"
          : direction === "left"
            ? "Move Left"
            : "Move Right";
    return [{ id: directionalGroupActionId(direction), label }];
  });
}

function directionalGroupActionId(direction: PaneSplitDirection): TabContextMenuAction {
  switch (direction) {
    case "up":
      return "move-group-up";
    case "down":
      return "move-group-down";
    case "left":
      return "move-group-left";
    case "right":
      return "move-group-right";
  }
}

export function resolveWorkspaceTabSplitAction(
  action: TabContextMenuAction | null,
): { readonly mode: "copy" | "move"; readonly direction: PaneSplitDirection } | null {
  switch (action) {
    case "split-right":
      return { mode: "copy", direction: "right" };
    case "split-down":
      return { mode: "copy", direction: "down" };
    case "move-up":
      return { mode: "move", direction: "up" };
    case "move-down":
      return { mode: "move", direction: "down" };
    case "move-left":
      return { mode: "move", direction: "left" };
    case "move-right":
      return { mode: "move", direction: "right" };
    default:
      return null;
  }
}

/** Resolves non-splitting context-menu ids into workspace layout operations. */
export function resolveWorkspaceTabLayoutAction(
  action: TabContextMenuAction | null,
): WorkspaceTabLayoutAction | null {
  switch (action) {
    case "move-group-up":
      return { _tag: "MoveToGroup", direction: "up" };
    case "move-group-down":
      return { _tag: "MoveToGroup", direction: "down" };
    case "move-group-left":
      return { _tag: "MoveToGroup", direction: "left" };
    case "move-group-right":
      return { _tag: "MoveToGroup", direction: "right" };
    default:
      return null;
  }
}
