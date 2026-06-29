export function resolveBrowserRecordingStopTarget(
  activeTabId: string | null,
  requestedTabId?: string,
): string | null {
  if (activeTabId === null) return null;
  return requestedTabId === undefined || requestedTabId === activeTabId ? activeTabId : null;
}
