import type { ContextMenuOpenContext } from "@pierre/trees";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import type { ContextMenuSource } from "@t3tools/contracts";
import { msg } from "gt-react";
import { useRef } from "react";

import { contextMenuSourceOf } from "~/contextMenuSource";
import { toastManager } from "~/components/ui/toast";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { m } from "~/i18n/messages";

/** Opens the app's menu in place of a Pierre tree's own row menu. */
export function useTreeContextMenuAnchor() {
  // Shadow-DOM row rects are unreliable; keep the composed contextmenu event's viewport position.
  const pointerRef = useRef<{
    x: number;
    y: number;
    at: number;
    source: ContextMenuSource;
  } | null>(null);
  return {
    // Capture runs before the tree's shadow-internal row handler opens the menu.
    onContextMenuCapture: (
      event: Pick<
        MouseEvent,
        "type" | "button" | "detail" | "clientX" | "clientY" | "timeStamp"
      > & {
        readonly nativeEvent?: Event;
      },
    ) => {
      pointerRef.current = {
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
        source: contextMenuSourceOf(event),
      };
    },
    /** Closes the tree's menu and returns where and how the app menu opens. */
    takeOver: (
      context: ContextMenuOpenContext,
    ): { position: { x: number; y: number }; source: ContextMenuSource | undefined } => {
      const pointer = pointerRef.current;
      const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
      const anchorRect = context.anchorElement.getBoundingClientRect();
      // The app menu owns focus; the tree's outside-click handler would dismiss it before click.
      context.close({ restoreFocus: !pointerIsFresh });
      return pointerIsFresh
        ? { position: { x: pointer.x, y: pointer.y }, source: pointer.source }
        : { position: { x: anchorRect.left, y: anchorRect.bottom }, source: undefined };
    },
  };
}

type FileTreeCopyAction = "copy-name" | "copy-path";

export function fileTreeCopyMenuItems() {
  return [
    { id: "copy-name", label: m(msg("Copy name")) },
    { id: "copy-path", label: m(msg("Copy path")) },
  ] as const;
}

export function isFileTreeCopyAction(id: string): id is FileTreeCopyAction {
  return id === "copy-name" || id === "copy-path";
}

export async function copyFileTreeRow(
  action: FileTreeCopyAction,
  row: { readonly name: string; readonly path: string },
  hostRoot: string | undefined,
): Promise<void> {
  try {
    await writeTextToClipboard(
      action === "copy-name" ? row.name : formatFilePathForClipboard(row.path, hostRoot),
    );
  } catch (error) {
    toastManager.add({
      type: "error",
      title: action === "copy-name" ? m(msg("Failed to copy name")) : m(msg("Failed to copy path")),
      description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
    });
  }
}
