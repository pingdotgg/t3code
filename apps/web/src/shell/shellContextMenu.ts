import type { ContextMenuItem } from "@t3tools/contracts";
import type { ShellContextMenuItem } from "@t3tools/contracts/shell";

import { decodeShellAction } from "./useShellActions";

let nextRequestId = 1;
const pending = new Map<string, (id: string | null) => void>();
let listening = false;

function ensureListener(): void {
  if (listening || !window.t3Shell) return;
  listening = true;
  void window.t3Shell.onAction((type, payload) => {
    const action = decodeShellAction(type, payload);
    if (action === null || action.type !== "contextMenu.select") return;
    const resolve = pending.get(action.requestId);
    if (!resolve) return;
    pending.delete(action.requestId);
    resolve(action.id);
  });
}

function toShellItems<T extends string>(
  items: readonly ContextMenuItem<T>[],
): ReadonlyArray<ShellContextMenuItem> {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    ...(item.destructive !== undefined ? { destructive: item.destructive } : {}),
    ...(item.disabled !== undefined ? { disabled: item.disabled } : {}),
    ...(item.header !== undefined ? { header: item.header } : {}),
    ...(item.separatorBefore !== undefined ? { separatorBefore: item.separatorBefore } : {}),
    ...(item.children
      ? {
          children: item.children.map((child) => ({
            id: child.id,
            label: child.label,
            ...(child.destructive !== undefined ? { destructive: child.destructive } : {}),
            ...(child.disabled !== undefined ? { disabled: child.disabled } : {}),
            ...(child.header !== undefined ? { header: child.header } : {}),
            ...(child.separatorBefore !== undefined
              ? { separatorBefore: child.separatorBefore }
              : {}),
          })),
        }
      : {}),
  }));
}

/**
 * The shell-hosted `localApi.contextMenu.show`: publishes the menu for the
 * surface this document lives in (or window coordinates when `surface` is
 * "shell") and resolves with the chosen id, or null when dismissed.
 */
export function showShellContextMenu<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number; surface?: string },
): Promise<T | null> {
  const shell = window.t3Shell;
  if (!shell) return Promise.resolve(null);
  ensureListener();
  closeShellContextMenu();
  const requestId = `${shell.surfaceId}:${nextRequestId++}`;
  return new Promise<T | null>((resolve) => {
    pending.set(requestId, (id) => {
      void shell.publish("contextMenu", null);
      resolve(id as T | null);
    });
    void shell.publish("contextMenu", {
      requestId,
      surfaceId: position?.surface ?? shell.surfaceId,
      x: position?.x ?? 0,
      y: position?.y ?? 0,
      items: toShellItems(items),
    });
  });
}

export function closeShellContextMenu(): void {
  for (const [requestId, resolve] of pending) {
    pending.delete(requestId);
    resolve(null);
  }
}
