import type { PreviewSessionSnapshot } from "@t3tools/contracts";

interface PreviewAutomationSessionIndex {
  readonly snapshot: PreviewSessionSnapshot | null;
  readonly sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
}

export function needsPreviewAutomationSessionSync(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | undefined,
): boolean {
  return (
    Object.keys(state.sessions).length === 0 ||
    requestedTabId === undefined ||
    state.sessions[requestedTabId] === undefined
  );
}

export function resolvePreviewAutomationTarget(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | null,
): { readonly tabId: string | null; readonly snapshot: PreviewSessionSnapshot | null } {
  const snapshot = requestedTabId ? (state.sessions[requestedTabId] ?? null) : state.snapshot;
  return { tabId: snapshot?.tabId ?? null, snapshot };
}

export function resolvePreviewAutomationOpenTab(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | undefined,
  reuseExistingTab: boolean,
): string | null {
  if (!reuseExistingTab) return null;
  if (requestedTabId !== undefined) {
    return state.sessions[requestedTabId]?.tabId ?? null;
  }
  return state.snapshot?.tabId ?? null;
}
