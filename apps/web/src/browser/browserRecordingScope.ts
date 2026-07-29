export interface BrowserRecordingStopTarget {
  readonly runtimeTabId: string;
  readonly serverTabId: string;
}

export function resolveBrowserRecordingStopTarget(
  activeTarget: BrowserRecordingStopTarget | null,
  requestedRuntimeTabId?: string,
): BrowserRecordingStopTarget | null {
  if (activeTarget === null) return null;
  return requestedRuntimeTabId === undefined || requestedRuntimeTabId === activeTarget.runtimeTabId
    ? activeTarget
    : null;
}

export function rewriteBrowserRecordingArtifactTabId<T extends { readonly tabId: string }>(
  artifact: T,
  target: BrowserRecordingStopTarget,
): Omit<T, "tabId"> & { readonly tabId: string } {
  return { ...artifact, tabId: target.serverTabId };
}
