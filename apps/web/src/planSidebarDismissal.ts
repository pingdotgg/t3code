/**
 * Tracks which turn's plan sidebar the user explicitly dismissed, per thread.
 *
 * Kept outside React state so a dismissal survives leaving and re-entering a
 * thread (ChatView resets its per-thread refs on navigation). Dismissals are
 * keyed by turn, so when a new turn produces fresh plan steps the sidebar
 * still auto-opens.
 */
const dismissedTurnByThreadKey = new Map<string, string>();

export function dismissPlanSidebarForTurn(threadKey: string, turnKey: string): void {
  dismissedTurnByThreadKey.set(threadKey, turnKey);
}

export function clearPlanSidebarDismissal(threadKey: string): void {
  dismissedTurnByThreadKey.delete(threadKey);
}

export function isPlanSidebarDismissedForTurn(threadKey: string, turnKey: string): boolean {
  return dismissedTurnByThreadKey.get(threadKey) === turnKey;
}
