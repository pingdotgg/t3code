import type { OrchestrationLatestTurnState, OrchestrationSession } from "@t3tools/contracts";

export function resolveThreadComposerPrimaryAction(input: {
  readonly hasContent: boolean;
  readonly latestTurnState: OrchestrationLatestTurnState | null;
  readonly sessionStatus: OrchestrationSession["status"] | null;
}): "continue" | "send" | "stop" {
  if (
    !input.hasContent &&
    (input.sessionStatus === "running" || input.sessionStatus === "starting")
  ) {
    return "stop";
  }
  if (!input.hasContent && input.latestTurnState === "interrupted") {
    return "continue";
  }
  return "send";
}
