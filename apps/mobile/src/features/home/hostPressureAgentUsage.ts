import type { HostPressureAgent } from "@t3tools/contracts";
import type { useGT } from "gt-react-native";

import { formatBytes } from "../../lib/formatBytes";

/** Memory or cores, whichever the server ranked agents by. */
export function hostPressureAgentUsage(
  gt: ReturnType<typeof useGT>,
  agent: HostPressureAgent,
  rankedBy: "memory" | "cpu",
): string {
  return rankedBy === "memory" || agent.cpuCores === null
    ? formatBytes(agent.memoryBytes)
    : gt("{count, plural, one {{count} core} other {{count} cores}}", { count: agent.cpuCores });
}
