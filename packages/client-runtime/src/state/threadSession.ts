import type { OrchestrationSessionStatus } from "@t3tools/contracts";

export type ThreadSessionReloadAvailability = "available" | "disabled" | "hidden";

export function threadSessionReloadAvailability(
  status: OrchestrationSessionStatus | null,
): ThreadSessionReloadAvailability {
  if (status === null || status === "stopped") return "hidden";
  if (status === "starting" || status === "running") return "disabled";
  return "available";
}
