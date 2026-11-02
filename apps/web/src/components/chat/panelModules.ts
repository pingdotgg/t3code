export const loadTerminalPanel = () => import("../PersistentThreadTerminals");
export const loadPullRequestPanel = () => import("../pullRequest/PullRequestDetailPanel");
export const loadLinkedPullRequestsPanel = () => import("../pullRequest/ThreadPullRequestsPanel");

export function preloadPanelShortcut(shortcut: string): void {
  const module =
    shortcut === "T"
      ? loadTerminalPanel()
      : shortcut === "P"
        ? loadPullRequestPanel()
        : shortcut === "L"
          ? loadLinkedPullRequestsPanel()
          : null;
  void module?.catch(() => {});
}
