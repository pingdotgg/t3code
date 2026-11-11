import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";

/** A server-persisted thread tag, so every client and device finds the same coordinator. */
export const COORDINATOR_THREAD_TAG = "coordinator";

/** Instructions agents read at session start; Claude reaches them through a CLAUDE.md import. */
export const PROJECT_INSTRUCTIONS_PATH = "AGENTS.md";
export const CLAUDE_INSTRUCTIONS_PATH = "CLAUDE.md";
export const CLAUDE_INSTRUCTIONS_IMPORT = `@${PROJECT_INSTRUCTIONS_PATH}
`;

export const COORDINATOR_THREAD_TITLE = "Coordinator";

export function isCoordinatorThread(shell: Pick<EnvironmentThreadShell, "source">): boolean {
  return shell.source.tags?.includes(COORDINATOR_THREAD_TAG) === true;
}

function inProject(
  shell: EnvironmentThreadShell,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): boolean {
  return (
    shell.environmentId === environmentId &&
    shell.projectId === projectId &&
    shell.deletedAt === null &&
    shell.archivedAt === null
  );
}

/** The newest live tagged thread wins, so a second tag from another device never splits the view. */
export function findProjectCoordinator(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): EnvironmentThreadShell | null {
  let coordinator: EnvironmentThreadShell | null = null;
  for (const shell of shells) {
    if (!inProject(shell, environmentId, projectId) || !isCoordinatorThread(shell)) continue;
    if (coordinator === null || shell.createdAt > coordinator.createdAt) coordinator = shell;
  }
  return coordinator;
}

/** The project's other threads, newest activity first. Side chats stay with their parent. */
export function projectAgentThreads(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): ReadonlyArray<EnvironmentThreadShell> {
  return shells
    .filter(
      (shell) =>
        inProject(shell, environmentId, projectId) &&
        !isCoordinatorThread(shell) &&
        shell.lineage.sideChat !== true,
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** Coordinator model, else the project's new-thread model, else its first usable provider. */
export function resolveCoordinatorModelSelection(input: {
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId: ProjectId;
  readonly now: number;
}): ModelSelection | null {
  const resolved = resolveProjectSettings(input.settings, input.projectId).settings;
  const selection =
    resolved.coordinatorModelSelection ??
    resolved.defaultModelSelection ??
    resolveProjectDefaultProviderModelSelection(input.providers, input.settings, input.projectId);
  return resolveNewThreadModelSelection({
    defaultSelection: selection,
    fallbackSelection: resolved.fallbackModelSelection,
    providers: input.providers,
    settings: input.settings,
    projectId: input.projectId,
    now: input.now,
  }).selection;
}

/** What a thread row says it is waiting on, or null when it is idle. */
export function projectThreadActivity(
  shell: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "runtime"
  >,
): "Needs approval" | "Needs input" | "Running" | null {
  if (shell.hasPendingApprovals || shell.pendingSubagentRequest === "approval") {
    return "Needs approval";
  }
  if (shell.hasPendingUserInput || shell.pendingSubagentRequest === "user_input") {
    return "Needs input";
  }
  return threadRuntimeIsActive(shell.runtime) ? "Running" : null;
}
