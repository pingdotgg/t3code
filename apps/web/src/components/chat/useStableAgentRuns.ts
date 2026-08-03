/**
 * React binding for {@link stabilizeAgentRuns}, following the timeline's own
 * `useStableRows` pattern: a memo over the previous result held in a ref.
 */

import { useMemo, useRef } from "react";

import { stabilizeAgentRuns, type AgentRunsResult } from "../../agentRuns.ts";

export function useStableAgentRuns(derived: AgentRunsResult): AgentRunsResult {
  const previous = useRef<AgentRunsResult | null>(null);
  return useMemo(() => {
    const stabilized = stabilizeAgentRuns(previous.current, derived);
    previous.current = stabilized;
    return stabilized;
  }, [derived]);
}
