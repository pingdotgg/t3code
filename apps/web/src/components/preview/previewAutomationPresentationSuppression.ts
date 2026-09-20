export type PreviewAutomationPresentationSuppressions = Map<string, Set<string>>;

export function isPreviewAutomationPresentationSuppressed(
  suppressions: PreviewAutomationPresentationSuppressions,
  threadKey: string,
  runtimeTabId: string,
): boolean {
  return suppressions.get(threadKey)?.has(runtimeTabId) ?? false;
}

export function setPreviewAutomationPresentationSuppressed(
  suppressions: PreviewAutomationPresentationSuppressions,
  threadKey: string,
  runtimeTabId: string,
  suppressed: boolean,
): void {
  const suppressedTabs = suppressions.get(threadKey);
  if (suppressed) {
    if (suppressedTabs) {
      suppressedTabs.add(runtimeTabId);
    } else {
      suppressions.set(threadKey, new Set([runtimeTabId]));
    }
    return;
  }

  suppressedTabs?.delete(runtimeTabId);
  if (suppressedTabs?.size === 0) suppressions.delete(threadKey);
}

export function prunePreviewAutomationPresentationSuppressions(
  suppressions: PreviewAutomationPresentationSuppressions,
  threadKey: string,
  activeRuntimeTabIds: ReadonlySet<string>,
): void {
  const suppressedTabs = suppressions.get(threadKey);
  if (!suppressedTabs) return;
  for (const runtimeTabId of suppressedTabs) {
    if (!activeRuntimeTabIds.has(runtimeTabId)) suppressedTabs.delete(runtimeTabId);
  }
  if (suppressedTabs.size === 0) suppressions.delete(threadKey);
}
