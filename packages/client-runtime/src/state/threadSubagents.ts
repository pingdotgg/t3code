/**
 * The subagent roster for one turn, and the compact label the mobile composer
 * pill renders for it.
 *
 * Scoped to a run rather than the whole thread: a thread accumulates every
 * subagent it ever spawned, while the pill and its sheet answer "what is this
 * turn doing right now". Live follow-ups to completed delegated tasks also
 * appear, using their child thread shells without changing the original result.
 */
import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";

import {
  activeSubagentThreadStatus,
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  withSubagentThreadActivity,
} from "./subagentRuntime.ts";
import { resolveActiveThreadRun } from "./threadWorkflows.ts";

type Projection = OrchestrationV2ThreadProjection;
type Subagent = OrchestrationV2Subagent;
type RunId = Projection["runs"][number]["id"];

export interface ThreadTurnSubagents {
  /** The run the roster belongs to: the active one, else the most recent one that spawned agents. */
  readonly runId: RunId | null;
  readonly turnActive: boolean;
  /** Spawn order: startedAt, falling back to updatedAt for agents that never started. */
  readonly subagents: ReadonlyArray<Subagent>;
  readonly liveCount: number;
  readonly settledCount: number;
}

export interface SubagentPillSegment {
  readonly label: string;
  readonly accessibilityLabel: string;
}

function orderKey(subagent: Subagent): number {
  return DateTime.toEpochMillis(subagent.startedAt ?? subagent.updatedAt);
}

/** null when the thread has never spawned a subagent. */
export function deriveThreadTurnSubagents(
  projection: Pick<Projection, "runs" | "subagents">,
  children?: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>,
): ThreadTurnSubagents | null {
  if (projection.subagents.length === 0) return null;
  const activeRun = resolveActiveThreadRun(projection);
  // With no live run the newest roster is still worth showing: a turn that
  // just finished leaves results the user has not read yet.
  const latestUpdated = projection.subagents.reduce((latest, subagent) =>
    DateTime.toEpochMillis(subagent.updatedAt) > DateTime.toEpochMillis(latest.updatedAt)
      ? subagent
      : latest,
  );
  const runId = activeRun?.id ?? latestUpdated.runId;
  const subagents = copySorted(
    projection.subagents.flatMap((subagent) => {
      const live = withSubagentThreadActivity(
        subagent,
        subagent.childThreadId === null ? undefined : children?.get(subagent.childThreadId),
      );
      return subagent.runId === runId ||
        (subagent.childThreadId !== null &&
          activeSubagentThreadStatus(children?.get(subagent.childThreadId)) !== null)
        ? [live]
        : [];
    }),
    (left, right) => orderKey(left) - orderKey(right) || left.id.localeCompare(right.id),
  );
  if (subagents.length === 0) return null;

  let liveCount = 0;
  let settledCount = 0;
  for (const subagent of subagents) {
    if (isActiveSubagentStatus(subagent.status)) liveCount += 1;
    else if (isTerminalSubagentStatus(subagent.status)) settledCount += 1;
  }
  return { runId, turnActive: activeRun !== null, subagents, liveCount, settledCount };
}

/**
 * What the pill's agents segment says, or null while it should stay hidden.
 * The segment is for work in flight: once the turn settles it goes away
 * rather than leaving a stale count above the composer.
 */
export function resolveSubagentPillSegment(
  turn: ThreadTurnSubagents | null,
): SubagentPillSegment | null {
  if (turn === null) return null;
  if (!turn.turnActive && turn.liveCount === 0) return null;
  const total = turn.subagents.length;
  if (turn.liveCount > 0) {
    return {
      label: `${turn.liveCount}/${total}`,
      accessibilityLabel: `${turn.liveCount} of ${total} agents working`,
    };
  }
  return {
    label: `${total} done`,
    accessibilityLabel: `${total} ${total === 1 ? "agent" : "agents"} done`,
  };
}
