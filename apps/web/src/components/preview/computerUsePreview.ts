import type {
  OrchestrationV2TurnItem,
  RunId,
  ToolActivityNativeAppReference,
} from "@t3tools/contracts";

/** What the floating computer card shows until the live capture's first frame arrives. */
export interface ComputerUsePreview {
  readonly itemId: string;
  readonly app: ToolActivityNativeAppReference | null;
  readonly appName: string | null;
  /** The newest computer use call is still running. */
  readonly inProgress: boolean;
}

/**
 * The newest computer use call in the thread, in any provider: Cua Driver
 * calls carry the `computer` surface and the app they drive.
 */
export function selectLatestComputerUse(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): ComputerUsePreview | null {
  for (let index = turnItems.length - 1; index >= 0; index -= 1) {
    const item = turnItems[index]!;
    if (item.type !== "dynamic_tool" || item.toolSurface !== "computer") continue;
    const icon = item.toolIcon ?? item.toolSource?.icon;
    return {
      itemId: item.id,
      app: icon?._tag === "native-app" ? icon.app : null,
      appName: item.toolSource?.kind === "computer" ? item.toolSource.name : null,
      inProgress: item.status === "running" || item.status === "pending",
    };
  }
  return null;
}

/** Whether the running run has used the computer, so the composer can say so beside Stop. */
export function isRunUsingComputer(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  runningRunId: RunId | null,
): boolean {
  if (runningRunId === null) return false;
  return turnItems.some(
    (item) =>
      item.runId === runningRunId &&
      item.type === "dynamic_tool" &&
      item.toolSurface === "computer",
  );
}
