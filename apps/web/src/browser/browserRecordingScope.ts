export interface BrowserRecordingStopTarget {
  readonly runtimeTabId: string;
  readonly serverTabId: string;
}

export function resolveBrowserRecordingStopTarget(
  activeTargets: ReadonlyArray<BrowserRecordingStopTarget>,
  implicitServerTabId: string | null,
  explicitRuntimeTabId?: string,
): BrowserRecordingStopTarget | null {
  if (explicitRuntimeTabId !== undefined) {
    return activeTargets.find((target) => target.runtimeTabId === explicitRuntimeTabId) ?? null;
  }
  if (implicitServerTabId !== null) {
    const implicit = activeTargets.find((target) => target.serverTabId === implicitServerTabId);
    if (implicit) return implicit;
  }
  return activeTargets.length === 1 ? activeTargets[0]! : null;
}

export function rewriteBrowserRecordingArtifactTabId<T extends { readonly tabId: string }>(
  artifact: T,
  target: BrowserRecordingStopTarget,
): Omit<T, "tabId"> & { readonly tabId: string } {
  return { ...artifact, tabId: target.serverTabId };
}
