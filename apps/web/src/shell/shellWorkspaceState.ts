import {
  EDITORS,
  type EditorId,
  type ProjectScript,
  type VcsRef,
  type VcsStatusResult,
} from "@t3tools/contracts";
import type { ShellWorkspaceState } from "@t3tools/contracts/shell";

import {
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "../components/BranchToolbar.logic";

export interface ShellWorkspaceStateInput {
  readonly threadKey: string;
  readonly projectTitle: string | null;
  readonly projectRoot: string | null;
  readonly threadTitle: string;
  readonly isDraft: boolean;
  readonly envMode: EnvMode;
  readonly envModeChangeable: boolean;
  readonly startFromOrigin: boolean;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly gitStatus: VcsStatusResult | null;
  readonly canOpenPullRequest: boolean;
  readonly terminalAvailable: boolean;
  readonly terminalOpen: boolean;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly preferredEditorId: EditorId | null;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly preferredScriptId: string | null;
  readonly environments: ReadonlyArray<{ environmentId: string; label: string }>;
  readonly activeEnvironmentId: string;
  readonly environmentChangeable: boolean;
  readonly renameRequestId: number;
  readonly branchQuery: string;
  readonly branches: ReadonlyArray<VcsRef>;
  readonly branchesTotal: number;
  readonly branchesLoading: boolean;
  readonly branchSwitchPending: boolean;
  readonly branchChangeable: boolean;
}

export function buildShellWorkspaceState(input: ShellWorkspaceStateInput): ShellWorkspaceState {
  const editorLabelById = new Map(EDITORS.map((editor) => [editor.id, editor.label] as const));
  const git = input.gitStatus;
  return {
    threadKey: input.threadKey,
    projectTitle: input.projectTitle,
    projectRoot: input.projectRoot,
    threadTitle: input.threadTitle,
    isDraft: input.isDraft,
    envMode: input.envMode,
    envModeLabel: input.envModeChangeable
      ? resolveEnvModeLabel(input.envMode)
      : resolveLockedWorkspaceLabel(input.worktreePath),
    envModeChangeable: input.envModeChangeable,
    startFromOrigin: input.startFromOrigin,
    branch: input.branch,
    worktreePath: input.worktreePath,
    git:
      git === null
        ? null
        : {
            isRepo: git.isRepo,
            hasWorkingTreeChanges: git.hasWorkingTreeChanges,
            aheadCount: git.aheadCount,
            behindCount: git.behindCount,
            hasUpstream: git.hasUpstream,
            pullRequest:
              git.pr === null
                ? null
                : {
                    number: git.pr.number,
                    title: git.pr.title,
                    url: git.pr.url,
                    state: git.pr.state,
                  },
          },
    canOpenPullRequest: input.canOpenPullRequest && git?.pr != null,
    terminalAvailable: input.terminalAvailable,
    terminalOpen: input.terminalOpen,
    editors: input.availableEditors.map((id) => ({ id, label: editorLabelById.get(id) ?? id })),
    preferredEditorId: input.preferredEditorId,
    scripts: input.scripts.map((script) => ({
      id: script.id,
      name: script.name,
      command: script.command,
    })),
    preferredScriptId: input.preferredScriptId,
    environments: input.environments,
    activeEnvironmentId: input.activeEnvironmentId,
    environmentChangeable: input.environmentChangeable,
    renameRequestId: input.renameRequestId,
    branchQuery: input.branchQuery,
    branches: input.branches.map((ref) => ({
      name: ref.name,
      isRemote: ref.isRemote === true,
      isDefault: ref.isDefault === true,
      current: ref.current === true,
    })),
    branchesTotal: input.branchesTotal,
    branchesLoading: input.branchesLoading,
    branchSwitchPending: input.branchSwitchPending,
    branchChangeable: input.branchChangeable,
  };
}
