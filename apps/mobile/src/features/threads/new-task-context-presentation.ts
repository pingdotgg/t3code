import { sanitizeNewRefName } from "@t3tools/shared/git";
import type { VcsDriverKind } from "@t3tools/contracts";
import { searchItems } from "@t3tools/shared/searchRanking";
import {
  DEFAULT_VCS_TERMINOLOGY,
  JJ_WORKING_COPY_LABEL,
  JJ_WORKING_COPY_REVISION,
  resolveWorktreeBaseRef,
  type VcsTerminology,
} from "@t3tools/shared/vcs";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import { resolveSendEnvMode } from "@t3tools/shared/projectSettings";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import type { ComposerDraftWorkspaceSelection } from "../../state/use-composer-drafts";

type WorkspaceMode = "local" | "worktree";

export function resolveNewTaskWorkspaceSelection(input: {
  readonly selection: ComposerDraftWorkspaceSelection | undefined;
  readonly fallback: ComposerDraftWorkspaceSelection;
  readonly isGitRepo: boolean;
}): ComposerDraftWorkspaceSelection {
  const selection = input.selection ?? input.fallback;
  const mode = resolveSendEnvMode({ requestedEnvMode: selection.mode, isGitRepo: input.isGitRepo });
  return input.isGitRepo ? selection : { mode, branch: null, worktreePath: null };
}

export function resolveNewTaskWorkspaceLabel(
  input: {
    readonly workspaceMode: WorkspaceMode;
    readonly worktreePath: string | null;
    readonly terminology?: VcsTerminology;
  },
  resolve: MessageResolver = m,
): string {
  const terminology = input.terminology ?? DEFAULT_VCS_TERMINOLOGY;
  if (input.workspaceMode === "worktree") {
    return terminology.systemName === "Git"
      ? resolve(msg("New worktree"))
      : resolve(msg("New {workspaceNoun}", { workspaceNoun: terminology.workspaceNoun }));
  }
  if (terminology.systemName === "Git") {
    return input.worktreePath ? resolve(msg("Current worktree")) : resolve(msg("Current checkout"));
  }
  return input.worktreePath
    ? resolve(msg("Current {workspaceNoun}", { workspaceNoun: terminology.workspaceNoun }))
    : resolve(
        msg("Current {currentRefFallback}", { currentRefFallback: terminology.currentRefFallback }),
      );
}

export function resolveNewTaskBranchWorktreePath(input: {
  readonly workspaceMode: WorkspaceMode;
  readonly projectCwd: string;
  readonly branchWorktreePath: string | null | undefined;
}): string | null {
  if (
    input.workspaceMode === "worktree" ||
    !input.branchWorktreePath ||
    input.branchWorktreePath === input.projectCwd
  ) {
    return null;
  }
  return input.branchWorktreePath;
}

export function resolveNewTaskLocalWorkspaceSelection(input: {
  readonly branches: ReadonlyArray<{
    readonly name: string;
    readonly current: boolean;
    readonly worktreePath?: string | null;
  }>;
  readonly projectCwd: string;
}): {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly awaitsCurrentBranch: boolean;
} {
  const currentBranch = input.branches.find((branch) => branch.current) ?? null;
  if (!currentBranch) {
    return {
      branch: null,
      worktreePath: null,
      awaitsCurrentBranch: true,
    };
  }

  return {
    branch: currentBranch.name,
    worktreePath: resolveNewTaskBranchWorktreePath({
      workspaceMode: "local",
      projectCwd: input.projectCwd,
      branchWorktreePath: currentBranch.worktreePath,
    }),
    awaitsCurrentBranch: false,
  };
}

export function resolveNewTaskBranchLabel(
  input: {
    readonly branchName: string | null;
    readonly startFromOrigin: boolean;
    readonly workspaceMode: WorkspaceMode;
    readonly pullRequestReference?: string;
    readonly terminology?: VcsTerminology;
  },
  resolve: MessageResolver = m,
): string {
  if (input.workspaceMode === "worktree" && input.pullRequestReference) {
    const parsed = sourceControlClients.parseChangeRequestUrl(input.pullRequestReference);
    if (parsed)
      return resolve(
        msg(
          "{term, select, mr {From MR #{number}} cr {From change request #{number}} other {From PR #{number}}}",
          {
            term: changeRequestTermKind(parsed.definition.changeRequest),
            number: parsed.link.number,
          },
        ),
      );
  }
  if (!input.branchName) {
    return input.terminology?.systemName === "Jujutsu"
      ? resolve(msg("Choose {refNoun}", { refNoun: input.terminology.refNoun }))
      : resolve(msg("Choose branch"));
  }

  if (input.workspaceMode === "local") {
    return input.branchName;
  }

  if (input.branchName === JJ_WORKING_COPY_REVISION) {
    return resolve(msg("From {revision}", { revision: JJ_WORKING_COPY_LABEL.toLowerCase() }));
  }
  const baseRef = input.startFromOrigin ? `origin/${input.branchName}` : input.branchName;
  return resolve(msg("From {branchName}", { branchName: baseRef }));
}

export function shouldCheckoutNewTaskBranch(input: {
  readonly branchIsCurrent: boolean;
  readonly branchWorktreePath: string | null | undefined;
  readonly workspaceMode: WorkspaceMode;
}): boolean {
  return input.workspaceMode === "local" && !input.branchIsCurrent && !input.branchWorktreePath;
}

export function filterNewTaskBranches<T extends { readonly name: string }>(
  branches: ReadonlyArray<T>,
  rawQuery: string,
): ReadonlyArray<T> {
  return searchItems(branches, sanitizeNewRefName(rawQuery), (branch) => [branch.name]);
}

/**
 * A worktree with no chosen base starts from the default branch, and a local
 * selection the user just switched to follows the current checkout until refs
 * load. Both are derived, never written back, so a late ref list or t3.json
 * default still wins.
 */
export function fillNewTaskWorkspaceBranch(input: {
  readonly selection: ComposerDraftWorkspaceSelection;
  readonly branches: ReadonlyArray<{
    readonly name: string;
    readonly current: boolean;
    readonly isDefault: boolean;
    readonly isRemote?: boolean;
    readonly worktreePath?: string | null;
  }>;
  readonly projectCwd: string | null;
  readonly worktreeDefaultSettled: boolean;
  readonly vcsKind?: VcsDriverKind | undefined;
}): ComposerDraftWorkspaceSelection {
  const { selection } = input;
  if (selection.branch !== null) return selection;
  if (selection.mode === "worktree") {
    // The default may only exist as origin/<default>, so search remote refs too.
    const base = resolveWorktreeBaseRef({
      defaultRef: input.branches.find((branch) => branch.isDefault)?.name ?? null,
      currentRef: input.branches.find((branch) => !branch.isRemote && branch.current)?.name ?? null,
      vcsKind: input.vcsKind,
    });
    return input.worktreeDefaultSettled && base
      ? { ...selection, branch: base, worktreePath: null }
      : selection;
  }
  if (!selection.followsCurrentCheckout || input.projectCwd === null) return selection;
  const local = resolveNewTaskLocalWorkspaceSelection({
    branches: input.branches.filter((branch) => !branch.isRemote),
    projectCwd: input.projectCwd,
  });
  return local.awaitsCurrentBranch
    ? selection
    : { ...selection, branch: local.branch, worktreePath: local.worktreePath };
}

/**
 * The workspace a new-task draft starts in: its own selection, else the
 * project's default mode, with the branch filled in as above. The new-task
 * flow, its send path and the home pending-drafts list all resolve through
 * this, so what each shows is what is sent.
 */
export function resolveNewTaskDraftWorkspace(input: {
  readonly selection: ComposerDraftWorkspaceSelection | undefined;
  readonly canChooseWorkspace: boolean;
  readonly defaultMode: WorkspaceMode;
  readonly defaultModeSettled: boolean;
  readonly isGitRepo: boolean;
  readonly branches: Parameters<typeof fillNewTaskWorkspaceBranch>[0]["branches"];
  readonly projectCwd: string | null;
  readonly vcsKind?: VcsDriverKind | undefined;
}): ComposerDraftWorkspaceSelection {
  const selection = input.canChooseWorkspace ? input.selection : undefined;
  return fillNewTaskWorkspaceBranch({
    selection: resolveNewTaskWorkspaceSelection({
      selection,
      fallback: { mode: input.defaultMode, branch: null, worktreePath: null },
      isGitRepo: input.isGitRepo,
    }),
    branches: input.branches,
    projectCwd: input.projectCwd,
    worktreeDefaultSettled: selection?.mode !== undefined || input.defaultModeSettled,
    vcsKind: input.vcsKind,
  });
}
