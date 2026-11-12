import { createContext, use } from "react";

/**
 * iOS mounts the app once per window (iPad, iPhone Duo): each window scene gets a React root of
 * its own on the one JS runtime. Module state is therefore shared by every window, and whatever
 * belongs to one window (its navigation container, its layout metrics, a sheet it presents) is
 * keyed by the id its root allocates here. Android and a one-window iPhone only ever have one.
 */
export type AppWindowId = number;

let nextWindowId = 1;
// Open windows, the one used last at the end.
let windows: ReadonlyArray<AppWindowId> = [];
const listeners = new Set<() => void>();

function setWindows(next: ReadonlyArray<AppWindowId>) {
  windows = next;
  for (const listener of listeners) listener();
}

export function allocateAppWindowId(): AppWindowId {
  return nextWindowId++;
}

/** The window was opened, or the person came back to it: app-wide work now targets it. */
export function activateAppWindow(id: AppWindowId): void {
  if (windows.at(-1) === id) return;
  setWindows([...windows.filter((open) => open !== id), id]);
}

/** The window closed, or its root unmounted. */
export function closeAppWindow(id: AppWindowId): void {
  if (windows.includes(id)) setWindows(windows.filter((open) => open !== id));
}

export function activeAppWindowId(): AppWindowId | null {
  return windows.at(-1) ?? null;
}

/** Notified when a window opens, closes or becomes the active one. */
export function subscribeAppWindows(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const AppWindowContext = createContext<AppWindowId>(0);

export function useAppWindowId(): AppWindowId {
  return use(AppWindowContext);
}
