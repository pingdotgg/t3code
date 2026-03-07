import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { compareActivitiesByOrder } from "./session-logic";
import type { ThreadSession } from "./types";

export interface RunningCommandExecution {
  itemId: string;
  turnId: TurnId;
  command: string;
  detail: string | null;
  startedAt: string;
  updatedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasActiveRunningTurn(session: ThreadSession | null): session is ThreadSession & { activeTurnId: TurnId } {
  return (
    session !== null &&
    session.orchestrationStatus === "running" &&
    session.activeTurnId !== undefined
  );
}

export function deriveRunningCommandExecutions(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  session: ThreadSession | null,
): RunningCommandExecution[] {
  if (!hasActiveRunningTurn(session)) {
    return [];
  }

  const byItemId = new Map<string, RunningCommandExecution>();
  const activeTurnId = session.activeTurnId;

  for (const activity of [...activities].toSorted(compareActivitiesByOrder)) {
    if (activity.turnId !== activeTurnId) continue;
    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      continue;
    }

    const payload = asRecord(activity.payload);
    if (!payload || payload.itemType !== "command_execution") {
      continue;
    }

    const itemId = asTrimmedString(payload.runtimeItemId);
    if (!itemId) {
      continue;
    }

    if (activity.kind === "tool.completed") {
      byItemId.delete(itemId);
      continue;
    }

    const existing = byItemId.get(itemId);
    const detail = asTrimmedString(payload.detail);
    const command = asTrimmedString(payload.command) ?? detail;
    if (!command) {
      continue;
    }

    byItemId.set(itemId, {
      itemId,
      turnId: activeTurnId,
      command,
      detail,
      startedAt: existing?.startedAt ?? activity.createdAt,
      updatedAt: activity.createdAt,
    });
  }

  return [...byItemId.values()].toSorted(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) || left.itemId.localeCompare(right.itemId),
  );
}
