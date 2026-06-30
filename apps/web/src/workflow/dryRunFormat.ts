import type { WorkflowDryRunHop, WorkflowDryRunResult } from "@t3tools/contracts";

/** One simulated hop as a sentence fragment for the dry-run result list. */
export const describeDryRunHop = (
  hop: WorkflowDryRunHop,
  laneName: (key: string) => string,
): string => {
  const route = `${laneName(hop.fromLane as string)} → ${laneName(hop.toLane as string)}`;
  if (hop.source === "step_on") {
    return `${route} — step "${hop.viaStepKey ?? "?"}" ${hop.result} route`;
  }
  if (hop.source === "lane_transition") {
    return `${route} — transition #${(hop.matchedTransitionIndex ?? 0) + 1} matched`;
  }
  return `${route} — lane ${hop.result} fallback`;
};

export const describeDryRunEnd = (
  run: WorkflowDryRunResult,
  laneName: (key: string) => string,
): string => {
  const lane = laneName(run.endLane as string);
  switch (run.end) {
    case "terminal":
      return `Reached terminal lane "${lane}".`;
    case "manual":
      return `Waiting in "${lane}" for a human (manual lane).`;
    case "no_route":
      return `Stuck in "${lane}" — no route matched. Add a transition or fallback.`;
    case "cycle_cap":
      return `Still looping after ${run.hops.length} hops (ended in "${lane}") — likely an unbounded cycle.`;
  }
};
