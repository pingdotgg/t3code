export function resolveBrowserRecordingStopTarget(
  activeTabIds: ReadonlySet<string>,
  implicitTabId: string | null,
  explicitTabId?: string,
): string | null {
  if (explicitTabId !== undefined) {
    return activeTabIds.has(explicitTabId) ? explicitTabId : null;
  }
  if (implicitTabId !== null && activeTabIds.has(implicitTabId)) {
    return implicitTabId;
  }
  if (activeTabIds.size !== 1) return null;
  return activeTabIds.values().next().value ?? null;
}
