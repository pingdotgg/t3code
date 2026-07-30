import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

export function canDeregisterCloudEnvironment(phase: EnvironmentConnectionPhase): boolean {
  return phase !== "connected" && phase !== "connecting";
}
