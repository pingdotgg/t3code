import * as DateTime from "effect/DateTime";
import type { OrchestrationV2Subagent, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";

import { isActiveSubagentStatus, isTerminalSubagentStatus } from "./subagentRuntime.ts";
import { resolveActiveThreadRun } from "./threadWorkflows.ts";

type Projection = OrchestrationV2ThreadProjection;
type Subagent = OrchestrationV2Subagent;
type RunId = Projection["runs"][number]["id"];

export interface ThreadTurnSubagents {
  readonly runId: RunId | null;
  readonly turnActive: boolean;
  /** No later turn has run since these agents' turn. */
  readonly latestTurn: boolean;
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

export function deriveThreadTurnSubagents(
  projection: Pick<Projection, "runs" | "subagents">,
): ThreadTurnSubagents | null {
  const rolledBackRunIds = new Set(
    projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  const eligible = projection.subagents.filter(
    (subagent) => subagent.runId === null || !rolledBackRunIds.has(subagent.runId),
  );
  const [first] = eligible;
  if (first === undefined) return null;
  const activeRun = resolveActiveThreadRun(projection);
  const latestUpdated = eligible.reduce(
    (latest, subagent) =>
      DateTime.toEpochMillis(subagent.updatedAt) > DateTime.toEpochMillis(latest.updatedAt)
        ? subagent
        : latest,
    first,
  );
  // Ordinal, not array position: a reordered queue can leave the projection's runs out of order.
  // Queued and never-started runs have not replaced anything yet.
  const latestStartedRun = projection.runs.reduce<Projection["runs"][number] | null>(
    (latest, run) =>
      run.startedAt !== null &&
      !rolledBackRunIds.has(run.id) &&
      (latest === null || run.ordinal > latest.ordinal)
        ? run
        : latest,
    null,
  );
  const latestStartedRunHasAgents =
    latestStartedRun !== null &&
    eligible.some((subagent) => subagent.runId === latestStartedRun.id);
  const runId =
    activeRun?.id ?? (latestStartedRunHasAgents ? latestStartedRun.id : latestUpdated.runId);
  const subagents = copySorted(
    eligible.filter(
      (subagent) =>
        subagent.runId === runId ||
        isActiveSubagentStatus(subagent.status) ||
        subagent.workflow !== undefined,
    ),
    (left, right) => orderKey(left) - orderKey(right) || left.id.localeCompare(right.id),
  );
  if (subagents.length === 0) return null;

  let liveCount = 0;
  let settledCount = 0;
  for (const subagent of subagents) {
    if (isActiveSubagentStatus(subagent.status)) liveCount += 1;
    else if (isTerminalSubagentStatus(subagent.status)) settledCount += 1;
  }
  return {
    runId,
    turnActive: activeRun !== null,
    latestTurn: runId === null || latestStartedRun === null || runId === latestStartedRun.id,
    subagents,
    liveCount,
    settledCount,
  };
}

export function resolveSubagentPillSegment(
  turn: ThreadTurnSubagents | null,
): SubagentPillSegment | null {
  if (turn === null) return null;
  // Finished agents stay reachable until a later turn replaces them; workflows always stay reachable.
  if (
    !turn.turnActive &&
    !turn.latestTurn &&
    turn.liveCount === 0 &&
    !turn.subagents.some((subagent) => subagent.workflow !== undefined)
  ) {
    return null;
  }
  const total = turn.subagents.length;
  if (turn.liveCount > 0) {
    return {
      label: `${turn.liveCount}/${total}`,
      accessibilityLabel: `${turn.liveCount} of ${total} agents working`,
    };
  }
  return {
    label: `${turn.settledCount} done`,
    accessibilityLabel: `${turn.settledCount} ${turn.settledCount === 1 ? "agent" : "agents"} done`,
  };
}
