import {
  isTerminalSubagentStatus,
  type RuntimeSubagent,
  type SubagentWorkflowGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";

export type WorkflowRunPhase = SubagentWorkflowGroup["phases"][number];

/**
 * Phases the run view lists, in plan order. Members without a phase get a
 * trailing "Other" group so every agent stays reachable.
 */
export function workflowRunPhases(group: SubagentWorkflowGroup): ReadonlyArray<WorkflowRunPhase> {
  const members = group.unphasedMembers;
  if (members.length === 0) return group.phases;
  const settled = members.filter((member) => isTerminalSubagentStatus(member.status)).length;
  return [
    ...group.phases,
    {
      index: -1,
      title: "Other",
      members,
      state: settled === members.length ? "done" : "running",
      settledCount: settled,
    },
  ];
}

/** Agent counts for the run's status line. */
export function workflowRunCounts(phases: ReadonlyArray<WorkflowRunPhase>) {
  const members = phases.flatMap((phase) => phase.members);
  return {
    total: members.length,
    settled: members.filter((member) => isTerminalSubagentStatus(member.status)).length,
  };
}

/**
 * The status line under a phase, such as "2 running · 4 done · 1 failed".
 * Stopped members are named, so a stopped phase never reads as done.
 */
export function workflowPhaseSummary(members: ReadonlyArray<RuntimeSubagent>) {
  const count = (...statuses: ReadonlyArray<RuntimeSubagent["status"]>) =>
    members.filter((member) => statuses.includes(member.status)).length;
  const running = count("running", "waiting");
  const queued = count("pending");
  const failed = count("failed");
  const parts: Array<[number, string]> = [
    [running, "running"],
    [queued, "queued"],
    [count("completed", "idle"), "done"],
    [failed, "failed"],
    [count("cancelled", "interrupted"), "stopped"],
  ];
  return {
    text: parts
      .filter(([n]) => n > 0)
      .map(([n, label]) => `${n} ${label}`)
      .join(" · "),
    active: running + queued > 0,
    failed: failed > 0,
  };
}

/**
 * One line from a member's capped answer. Structured answers arrive as JSON,
 * so their first string field stands in for the whole object.
 */
export function workflowAnswerPreview(text: string | null): string | null {
  if (!text) return null;
  const firstField = /^\s*\{\s*"[^"]+"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text)?.[1];
  const line = (firstField === undefined ? text : decodeJsonString(firstField))
    .split("\n")
    .find((part) => part.trim().length > 0);
  return line?.trim() ?? null;
}

/** Decodes a JSON string body; a body cut mid-escape stays as written. */
function decodeJsonString(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body;
  }
}
