import type { ToolActivityIcon } from "@t3tools/contracts";

import type { WorkLogEntry } from "~/session-logic";

/** The latest thing the agent looked at while driving the host computer. */
export interface ComputerUsePreview {
  readonly entryId: string;
  readonly imagePath: string;
  readonly windowTitle: string | null;
  readonly appIcon: Extract<ToolActivityIcon, { readonly _tag: "native-app" }> | null;
  readonly appName: string | null;
}

/**
 * Walks the work log backwards for the newest completed computer-use capture.
 * The app identity comes from the same row; ingestion resolves it from the
 * tool's pid before the screenshot is attached.
 */
export function selectLatestComputerUsePreview(
  entries: ReadonlyArray<WorkLogEntry>,
): ComputerUsePreview | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.toolSurface !== "computer" || !entry.viewedImagePath) continue;
    return {
      entryId: entry.id,
      imagePath: entry.viewedImagePath,
      windowTitle: entry.computerUseWindowTitle ?? null,
      appIcon: entry.toolIcon?._tag === "native-app" ? entry.toolIcon : null,
      appName: entry.toolSource?.name ?? null,
    };
  }
  return null;
}

/** True while the newest computer-use row is still running, so the card can say so. */
export function selectComputerUseInProgress(entries: ReadonlyArray<WorkLogEntry>): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.toolSurface !== "computer") continue;
    return entry.toolLifecycleStatus === "inProgress";
  }
  return false;
}
