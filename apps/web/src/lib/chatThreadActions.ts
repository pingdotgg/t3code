import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import type { ComposerThreadDraftState, DraftThreadEnvMode } from "../composerDraftStore";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "../logicalProject";

type ComposerModelSelectionState = Pick<
  ComposerThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
    // The opened draft's identity, which most callers have no use for.
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveNewThreadModelSelectionOverride(input: {
  readonly projectDefaultSelection: ModelSelection | null;
  readonly carrySelection: ModelSelection | null;
  readonly carrySourceDraftId: string | null;
  readonly destinationDraftId: string;
}): ModelSelection | null {
  return (
    input.projectDefaultSelection ??
    (input.carrySourceDraftId === input.destinationDraftId ? null : input.carrySelection)
  );
}

export function hasExplicitComposerModelSelection(
  draft: ComposerModelSelectionState | null | undefined,
): boolean {
  const activeProvider = draft?.activeProvider;
  return (
    draft?.modelSelectionExplicit === true &&
    activeProvider !== null &&
    activeProvider !== undefined &&
    draft.modelSelectionByProvider[activeProvider] !== undefined
  );
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

/**
 * Picks a reachable New Chat target: keep the requested checkout when that host
 * can serve, otherwise a sibling from the same logical group. The logical key
 * comes from the physical-to-logical map so a stale or unidentified row still
 * finds its identified duplicate.
 */
export function resolveAvailableNewThreadProjectRef(input: {
  requested: ScopedProjectRef;
  projects: ReadonlyArray<EnvironmentProject>;
  settings: ProjectGroupingSettings;
  logicalKeyByPhysicalKey: ReadonlyMap<string, string>;
  isEnvironmentReachable: (environmentId: EnvironmentId) => boolean;
  primaryEnvironmentId: EnvironmentId | null;
}): ScopedProjectRef | null {
  if (input.isEnvironmentReachable(input.requested.environmentId)) {
    return input.requested;
  }

  const requestedProject = input.projects.find(
    (project) =>
      project.id === input.requested.projectId &&
      project.environmentId === input.requested.environmentId,
  );
  const logicalKey =
    requestedProject === undefined
      ? undefined
      : input.logicalKeyByPhysicalKey.get(derivePhysicalProjectKey(requestedProject));
  if (logicalKey === undefined) return null;

  const members =
    buildProjectGroups({
      projects: input.projects,
      settings: input.settings,
      preferredEnvironmentId: input.primaryEnvironmentId,
    }).find((group) => group.key === logicalKey)?.members ?? [];

  let selected: (typeof members)[number] | undefined;
  for (const member of members) {
    if (input.logicalKeyByPhysicalKey.get(member.physicalProjectKey) !== logicalKey) continue;
    if (!input.isEnvironmentReachable(member.project.environmentId)) continue;
    const selectedIsPrimary =
      input.primaryEnvironmentId !== null &&
      selected?.project.environmentId === input.primaryEnvironmentId;
    const memberIsPrimary =
      input.primaryEnvironmentId !== null &&
      member.project.environmentId === input.primaryEnvironmentId;
    if (selected === undefined || (memberIsPrimary && !selectedIsPrimary)) {
      selected = member;
    }
  }

  return selected === undefined
    ? null
    : scopeProjectRef(selected.project.environmentId, selected.project.id);
}

/** Drops branch and worktree path when New Chat retargets to a different environment. */
export function resolveWorkspaceOptionsAfterEnvironmentRetarget<
  TOptions extends {
    branch?: string | null;
    worktreePath?: string | null;
  },
>(input: {
  requestedEnvironmentId: EnvironmentId;
  targetEnvironmentId: EnvironmentId;
  options: TOptions | undefined;
}): TOptions | undefined {
  if (input.options === undefined || input.requestedEnvironmentId === input.targetEnvironmentId) {
    return input.options;
  }
  return {
    ...input.options,
    ...(input.options.branch !== undefined ? { branch: null } : {}),
    ...(input.options.worktreePath !== undefined ? { worktreePath: null } : {}),
  };
}

// New threads inherit only the *project* from the current context. Branch,
// worktree, and env mode always come from the user's configured defaults —
// carrying them over from the viewed thread meant "new thread" silently
// reused checkouts and branches. Explicit affordances (branch toolbar's
// "new thread in this worktree") pass those options to handleNewThread
// directly instead.
export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  return true;
}
