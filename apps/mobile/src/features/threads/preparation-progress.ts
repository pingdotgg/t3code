import type { WorktreeSetupStageStatus } from "@t3tools/contracts";

export interface PreparationStep {
  readonly id: "send" | "workspace" | "agent";
  readonly label: string;
  readonly status: WorktreeSetupStageStatus;
  readonly detail: string | null;
}

export interface PreparationProgressInput {
  /** The server has the task: the outbox delivered it or the thread has a run. */
  readonly sent: boolean;
  readonly preparingWorktree: boolean;
  readonly connected: boolean;
  readonly environmentLabel: string | null;
}

/**
 * What the preparing pill and its sheet report before the server's live setup
 * stages arrive. On a slow link the task can sit in the outbox, or the stage
 * stream can lag the thread, for a long time; both look like "setting up"
 * unless the client says which side it is waiting on.
 */
export function preparationPillLabel(input: PreparationProgressInput): string {
  if (!input.sent) return "Sending task…";
  return input.preparingWorktree ? "Setting up worktree…" : "Starting…";
}

export function preparationSteps(input: PreparationProgressInput): ReadonlyArray<PreparationStep> {
  const environment = input.environmentLabel ?? "environment";
  return [
    {
      id: "send",
      label: `Send task to ${environment}`,
      status: input.sent ? "done" : "running",
      detail: input.sent ? null : input.connected ? "Waiting for reply" : "Waiting for connection",
    },
    {
      id: "workspace",
      label: input.preparingWorktree ? "Set up worktree" : "Prepare workspace",
      status: input.sent ? "running" : "pending",
      detail: input.sent
        ? !input.connected
          ? "Waiting for connection"
          : input.preparingWorktree
            ? "Waiting for progress"
            : null
        : null,
    },
    { id: "agent", label: "Start agent", status: "pending", detail: null },
  ];
}
