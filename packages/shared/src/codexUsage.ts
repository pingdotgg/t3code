import type { CodexUsageWindow } from "@t3tools/contracts";

const CODEX_USAGE_WINDOW_DISPLAY_ORDER = {
  "five-hour": 0,
  weekly: 1,
} satisfies Record<CodexUsageWindow["kind"], number>;

function compareCodexUsageWindowDisplayOrder(
  left: Pick<CodexUsageWindow, "kind">,
  right: Pick<CodexUsageWindow, "kind">,
): number {
  return CODEX_USAGE_WINDOW_DISPLAY_ORDER[left.kind] - CODEX_USAGE_WINDOW_DISPLAY_ORDER[right.kind];
}

export function sortCodexUsageWindowsForDisplay(
  windows: ReadonlyArray<CodexUsageWindow>,
): CodexUsageWindow[] {
  return windows.toSorted(compareCodexUsageWindowDisplayOrder);
}
