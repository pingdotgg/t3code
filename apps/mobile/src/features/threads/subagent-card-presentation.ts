import { isActiveSubagentStatus } from "@lathe/client-runtime/state/subagentRuntime";
import type { OrchestrationV2Subagent } from "@lathe/contracts";
import { formatDuration } from "@lathe/shared/orchestrationTimingCopy";
import * as DateTime from "effect/DateTime";

import { m, type MessageResolver } from "../../i18n/messages";

export function subagentCardElapsed(
  agents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">>,
  nowMs: number,
  resolve: MessageResolver = m,
): string | null {
  const starts = agents.flatMap((agent) =>
    agent.startedAt ? [DateTime.toEpochMillis(agent.startedAt)] : [],
  );
  if (starts.length === 0) return null;
  const live = agents.some((agent) => isActiveSubagentStatus(agent.status));
  if (!live && agents.some((agent) => agent.completedAt === null)) return null;
  const ends = agents.flatMap((agent) =>
    agent.completedAt ? [DateTime.toEpochMillis(agent.completedAt)] : [],
  );
  const duration = (live ? nowMs : Math.max(...ends)) - Math.min(...starts);
  return duration > 0 ? formatDuration(duration, resolve) : null;
}
