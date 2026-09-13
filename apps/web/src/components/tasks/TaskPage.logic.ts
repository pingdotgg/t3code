import type { OrchestrationTaskShell } from "@t3tools/contracts";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import { taskWorkbenchRef } from "@t3tools/client-runtime/state/task-workbench";
import type { Thread } from "../../types";
import { NO_PROVIDER_MODEL_SELECTION } from "../../providerInstances";

/** Only an authoritative shell plus the archive inventory can prove a task is missing. */
export function taskPageAvailability(input: {
  shellStatus: EnvironmentShellStatus;
  disconnected?: boolean;
  supportsTasks: boolean | undefined;
  task: OrchestrationTaskShell | null;
  archivedTask: OrchestrationTaskShell | null;
  archiveLoading: boolean;
  archiveError: string | null;
  hasPrimaryProject: boolean;
}) {
  if (input.supportsTasks === false) return "unsupported";
  if (input.task?.archivedAt || input.archivedTask) return "archived";
  if (input.task) {
    if (input.hasPrimaryProject) return input.shellStatus === "live" ? "ready" : "cached";
    return input.shellStatus === "live" ? "project-missing" : "loading";
  }
  if (input.shellStatus === "cached" || input.disconnected) return "disconnected";
  if (input.shellStatus !== "live" || input.archiveLoading) return "loading";
  return input.archiveError ? "archive-error" : "missing";
}

/** Adapt task context to the shared workbench layout without creating a draft or conversation. */
export function buildTaskWorkbenchContext(task: EnvironmentTask): Thread {
  return {
    id: taskWorkbenchRef({ environmentId: task.environmentId, taskId: task.id }).threadId,
    environmentId: task.environmentId,
    projectId: task.primaryProjectId,
    taskId: task.id,
    title: task.name,
    modelSelection: NO_PROVIDER_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    checkpoints: [],
    pullRequests: [],
    activities: [],
    proposedPlans: [],
  };
}
