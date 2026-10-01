import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

const WORKSPACE_MUTATION_ITEM_TYPES = new Set(["command_execution", "file_change"]);

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload !== null && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

/**
 * The latest provider event after which files on disk may have changed.
 * File tools are explicit; completed commands are included because a shell
 * command can mutate the workspace without reporting the paths it touched.
 */
export function latestWorkspaceMutationId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): string | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) continue;
    const payload = activityPayload(activity);
    const terminalUpdate =
      activity.kind === "tool.updated" &&
      typeof payload?.status === "string" &&
      payload.status !== "inProgress" &&
      payload.status !== "in_progress";
    if (activity.kind !== "tool.completed" && !terminalUpdate) continue;
    const itemType = payload?.itemType;
    if (typeof itemType === "string" && WORKSPACE_MUTATION_ITEM_TYPES.has(itemType)) {
      return activity.id;
    }
  }
  return null;
}

export function workspaceMutationRefreshToken(
  resourceKey: string,
  mutationId: string | null,
): string | null {
  return mutationId === null ? null : `${resourceKey}\u0000${mutationId}`;
}

/**
 * Refreshes once per mutation and resource. Disabled mutations stay pending,
 * which lets an editable file catch up after its local save finishes.
 */
export function useWorkspaceMutationRefresh(input: {
  readonly enabled?: boolean;
  readonly mutationId: string | null;
  readonly refresh: () => void;
  readonly resourceKey: string;
}): void {
  const { enabled = true, mutationId, refresh, resourceKey } = input;
  const handledTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const token = workspaceMutationRefreshToken(resourceKey, mutationId);
    if (token === null || token === handledTokenRef.current) return;
    handledTokenRef.current = token;
    refresh();
  }, [enabled, mutationId, refresh, resourceKey]);
}
