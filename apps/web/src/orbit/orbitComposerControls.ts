/**
 * Conn: the draft composer's model controls at the moment of send, by start id, so the pending
 * thread's disabled prompt box shows the same model as the box it replaces. Kept in memory only:
 * after a reload the box shows without them.
 */
const controlsByStart = new Map<string, string>();
const MAX_KEPT = 20;

export function rememberOrbitComposerControls(startId: string): void {
  if (typeof document === "undefined") return;
  const controls = document.querySelector("[data-chat-provider-model-picker]");
  if (!(controls instanceof HTMLElement)) return;
  controlsByStart.set(startId, controls.outerHTML);
  while (controlsByStart.size > MAX_KEPT) {
    const oldest = controlsByStart.keys().next().value;
    if (oldest === undefined) break;
    controlsByStart.delete(oldest);
  }
}

export function orbitComposerControls(startId: string): string | null {
  return controlsByStart.get(startId) ?? null;
}
