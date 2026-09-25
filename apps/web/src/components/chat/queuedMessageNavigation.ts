import type { RunId } from "@t3tools/contracts";

/** Follow the current queue order, including reorders and entries removed by another client. */
export function queuedMessageNavigationTarget(
  runIds: ReadonlyArray<RunId>,
  editingRunId: RunId | null,
  direction: "previous" | "next",
): RunId | "draft" | null {
  if (editingRunId === null) return direction === "previous" ? (runIds.at(-1) ?? null) : null;
  const index = runIds.indexOf(editingRunId);
  // The existing edit recovery owns a message that has left the queue.
  if (index === -1) return null;
  if (direction === "next") return runIds[index + 1] ?? "draft";
  return runIds[Math.max(0, index - 1)] ?? null;
}
