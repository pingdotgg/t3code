import {
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";

/** Summarize observed states without treating idle or missing agents as completed. */
export function deriveAgentSpawnSummary({
  agents,
  agentCount,
  coordinatorStatus,
}: {
  agents: ReadonlyArray<Pick<RuntimeSubagent, "kind" | "status">>;
  agentCount: number;
  coordinatorStatus?: RuntimeSubagent["status"] | undefined;
}) {
  const working = agents.filter((agent) => isActiveSubagentStatus(agent.status)).length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const idle = agents.filter((agent) => agent.status === "idle").length;
  const stopped = agents.filter(
    (agent) => agent.status === "cancelled" || agent.status === "interrupted",
  ).length;
  const batches = agents.filter((agent) => agent.kind === "subagent_batch").length;
  const individuals = agentCount - batches;
  // Workflow coordinators can keep running between dynamic member launches.
  const live =
    coordinatorStatus !== undefined ? !isTerminalSubagentStatus(coordinatorStatus) : working > 0;
  const subjects = [
    individuals > 0 ? `${individuals} subagent${individuals === 1 ? "" : "s"}` : null,
    batches > 0
      ? `${batches} ${individuals > 0 ? "" : "subagent "}batch${batches === 1 ? "" : "es"}`
      : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const lead = `${batches > 0 ? "Launched" : live ? "Kicked off" : "Ran"} ${subjects || "subagents"}`;

  const status = live
    ? working > 0
      ? `${working} working`
      : "working"
    : coordinatorStatus === "failed"
      ? "Workflow failed"
      : coordinatorStatus === "cancelled" || coordinatorStatus === "interrupted"
        ? "Workflow stopped"
        : failed > 0
          ? `${failed} failed`
          : stopped > 0
            ? `${stopped} stopped`
            : idle > 0
              ? `${idle} idle`
              : coordinatorStatus !== "completed" &&
                  (agents.length === 0 || agents.length < agentCount)
                ? "Status unavailable"
                : "✓ completed";
  const tone = live
    ? "working"
    : failed > 0 || coordinatorStatus === "failed"
      ? "failed"
      : status === "✓ completed"
        ? "completed"
        : "inactive";
  return { live, lead, status, tone };
}
