/**
 * Chat overlays (dialogs, media previews) are opened for one thread and must not
 * outlive its route. Overlay modules register here when they load, so the route
 * listener can drop them without importing the overlays themselves.
 */
const retainers: Array<(threadKey: string | null) => void> = [];

export function registerThreadOverlay(retain: (threadKey: string | null) => void): void {
  retainers.push(retain);
}

/** Drops every overlay opened for a thread other than `threadKey`. */
export function retainThreadOverlaysForThread(threadKey: string | null): void {
  for (const retain of retainers) retain(threadKey);
}
