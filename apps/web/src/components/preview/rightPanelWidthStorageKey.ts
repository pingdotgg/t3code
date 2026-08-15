/**
 * Scopes the remembered right-panel width to one thread. Without a thread in the
 * key every thread reads and writes the same width, so resizing the panel in one
 * thread resizes it in all of them.
 */
export function rightPanelWidthStorageKey(threadKey: string): string {
  return `t3code:preview-panel-width:${threadKey}`;
}
