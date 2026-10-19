import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";

export function threadRouteIsHydrating(input: {
  readonly isLoadingConnections: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly shellStatus: EnvironmentShellStatus;
  readonly shellHasError: boolean;
  readonly detailStatus: EnvironmentThreadStatus;
  readonly detailHasError: boolean;
}): boolean {
  if (input.detailStatus === "deleted" || input.shellHasError || input.detailHasError) {
    return false;
  }
  if (input.isLoadingConnections) {
    return true;
  }
  if (
    input.connectionState === "available" ||
    input.connectionState === "offline" ||
    input.connectionState === "error"
  ) {
    return false;
  }
  return (
    input.connectionState === "connecting" ||
    input.connectionState === "reconnecting" ||
    input.shellStatus === "synchronizing" ||
    (input.connectionState === "connected" && input.shellStatus === "empty") ||
    input.detailStatus === "synchronizing" ||
    (input.connectionState === "connected" && input.detailStatus === "empty")
  );
}
