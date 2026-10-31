import type { LinearLaunchWorkspace } from "@t3tools/client-runtime/linear/launch-plan";

/** What the issue screen can start. `useLinearLaunch` (./useLinearLaunch) implements it. */
export interface LinearLaunchActions {
  /** Opens the new-task draft prefilled from the issue; `workspace` defaults to a new worktree. */
  startChat(issueId: string, options?: { readonly workspace?: LinearLaunchWorkspace }): void;
  /** Opens the "Run pipeline from issue" sheet, optionally with a pipeline preselected. */
  openPipelineSheet(issueId: string, pipelineId?: string): void;
  /** False when the environment has no pipelines capability; the screen disables "Run pipeline". */
  readonly canRunPipeline: boolean;
}
