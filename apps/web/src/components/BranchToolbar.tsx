import type { ThreadId } from "@t3tools/contracts";
import { FolderIcon, GitForkIcon } from "lucide-react";
import { useCallback } from "react";

import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import {
  DEFAULT_DRAFT_WORKTREE_BRANCH_NAMING_STATE,
  updateDraftWorktreeBranchNamingMode,
  type DraftWorktreeBranchNamingMode,
} from "../worktreeBranchNaming";
import {
  EnvMode,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

const envModeItems = [
  { value: "local", label: "Local" },
  { value: "worktree", label: "New worktree" },
] as const;
const worktreeBranchNamingModeItems = [
  { value: "auto", label: "Auto Branch Name" },
  { value: "prefix", label: "Prefix" },
  { value: "full", label: "Custom Branch Name" },
] as const;

interface BranchToolbarProps {
  threadId: ThreadId;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

export default function BranchToolbar({
  threadId,
  onEnvModeChange,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarProps) {
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const serverThread = threads.find((thread) => thread.id === threadId);
  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch = serverThread?.branch ?? draftThread?.branch ?? null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: draftThread?.envMode,
  });
  const worktreeBranchNaming =
    draftThread?.worktreeBranchNaming ?? DEFAULT_DRAFT_WORKTREE_BRANCH_NAMING_STATE;
  const shouldShowWorktreeBranchNaming =
    !envLocked && !hasServerThread && effectiveEnvMode === "worktree" && !activeWorktreePath;

  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId) return;
      const api = readNativeApi();
      // If the effective cwd is about to change, stop the running session so the
      // next message creates a new one with the correct cwd.
      if (serverThread?.session && worktreePath !== activeWorktreePath && api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      if (api && hasServerThread) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          branch,
          worktreePath,
        });
      }
      if (hasServerThread) {
        setThreadBranchAction(activeThreadId, branch, worktreePath);
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(threadId, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
      });
    },
    [
      activeThreadId,
      serverThread?.session,
      activeWorktreePath,
      hasServerThread,
      setThreadBranchAction,
      setDraftThreadContext,
      threadId,
      effectiveEnvMode,
    ],
  );

  const updateWorktreeBranchNaming = useCallback(
    (nextValue: typeof worktreeBranchNaming) => {
      setDraftThreadContext(threadId, {
        worktreeBranchNaming: nextValue,
      });
    },
    [setDraftThreadContext, threadId],
  );

  if (!activeThreadId || !activeProject) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-5 pb-3 pt-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {envLocked || activeWorktreePath ? (
          <span className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
            {activeWorktreePath ? (
              <>
                <GitForkIcon className="size-3" />
                Worktree
              </>
            ) : (
              <>
                <FolderIcon className="size-3" />
                Local
              </>
            )}
          </span>
        ) : (
          <Select
            value={effectiveEnvMode}
            onValueChange={(value) => onEnvModeChange(value as EnvMode)}
            items={envModeItems}
          >
            <SelectTrigger variant="ghost" size="xs" className="font-medium">
              {effectiveEnvMode === "worktree" ? (
                <GitForkIcon className="size-3" />
              ) : (
                <FolderIcon className="size-3" />
              )}
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="local">
                <span className="inline-flex items-center gap-1.5">
                  <FolderIcon className="size-3" />
                  Local
                </span>
              </SelectItem>
              <SelectItem value="worktree">
                <span className="inline-flex items-center gap-1.5">
                  <GitForkIcon className="size-3" />
                  New worktree
                </span>
              </SelectItem>
            </SelectPopup>
          </Select>
        )}

        {shouldShowWorktreeBranchNaming ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Select
              value={worktreeBranchNaming.mode}
              onValueChange={(value) =>
                updateWorktreeBranchNaming(
                  updateDraftWorktreeBranchNamingMode(
                    worktreeBranchNaming,
                    value as DraftWorktreeBranchNamingMode,
                  ),
                )
              }
              items={worktreeBranchNamingModeItems}
            >
              <SelectTrigger size="xs" variant="ghost" className="font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="auto">Auto Branch Name</SelectItem>
                <SelectItem value="prefix">Prefix</SelectItem>
                <SelectItem value="full">Custom Branch Name</SelectItem>
              </SelectPopup>
            </Select>

            {worktreeBranchNaming.mode !== "auto" ? (
              <Input
                size="sm"
                className="w-44 sm:w-48"
                value={
                  worktreeBranchNaming.mode === "prefix"
                    ? worktreeBranchNaming.prefix
                    : worktreeBranchNaming.branchName
                }
                placeholder={
                  worktreeBranchNaming.mode === "prefix" ? "Prefix" : "feature/my-branch"
                }
                aria-label={
                  worktreeBranchNaming.mode === "prefix"
                    ? "Worktree branch prefix"
                    : "Full worktree branch name"
                }
                onChange={(event) =>
                  updateWorktreeBranchNaming({
                    ...worktreeBranchNaming,
                    ...(worktreeBranchNaming.mode === "prefix"
                      ? { prefix: event.target.value }
                      : { branchName: event.target.value }),
                  })
                }
              />
            ) : null}
          </div>
        ) : null}
      </div>

      <BranchToolbarBranchSelector
        activeProjectCwd={activeProject.cwd}
        activeThreadBranch={activeThreadBranch}
        activeWorktreePath={activeWorktreePath}
        branchCwd={branchCwd}
        effectiveEnvMode={effectiveEnvMode}
        envLocked={envLocked}
        onSetThreadBranch={setThreadBranch}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
    </div>
  );
}
