import type { ThreadId } from "@t3tools/contracts";
import { FolderIcon, GitBranchPlusIcon } from "lucide-react";
import { useCallback } from "react";

import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import {
  EnvMode,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

interface BranchToolbarProps {
  threadId: ThreadId;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

const ENV_MODE_TOGGLE_GROUP_CLASS_NAME =
  "rounded-2xl border border-border/70 bg-background/80 p-1 shadow-xs/5 backdrop-blur-sm dark:bg-card/75";

const ENV_MODE_TOGGLE_CLASS_NAME =
  "gap-2 rounded-xl border border-transparent px-3 text-xs font-medium text-muted-foreground/75 shadow-none transition-all duration-150 hover:bg-background/70 hover:text-foreground/85 data-[pressed]:border-border/80 data-[pressed]:bg-primary/10 data-[pressed]:text-foreground data-[pressed]:ring-1 data-[pressed]:ring-primary/10 data-[pressed]:shadow-sm data-disabled:opacity-100 data-disabled:text-muted-foreground/60 [&_[data-slot=icon-chip]]:bg-background/70 [&_[data-slot=icon-chip]]:ring-1 [&_[data-slot=icon-chip]]:ring-border/40 data-[pressed]:[&_[data-slot=icon-chip]]:bg-primary/12 data-[pressed]:[&_[data-slot=icon-chip]]:ring-primary/20 [&_svg]:size-3.5 [&_svg]:text-muted-foreground/55 [&_svg]:transition-colors data-[pressed]:[&_svg]:text-primary data-disabled:[&_svg]:text-muted-foreground/35";

const ENV_MODE_ICON_CHIP_CLASS_NAME =
  "flex size-4 shrink-0 items-center justify-center rounded-full transition-colors";

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
  const envToggleValue = activeWorktreePath ? "worktree" : effectiveEnvMode;
  const envToggleDisabled = envLocked || activeWorktreePath !== null;
  const worktreeToggleLabel = activeWorktreePath ? "Worktree" : "New worktree";

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

  if (!activeThreadId || !activeProject) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-5 pb-3 pt-1">
      <div className="flex shrink-0 items-center gap-2">
        <ToggleGroup
          aria-label="Thread workspace mode"
          className={ENV_MODE_TOGGLE_GROUP_CLASS_NAME}
          size="xs"
          multiple={false}
          value={[envToggleValue]}
          onValueChange={(value) => {
            if (envToggleDisabled) return;
            const nextMode = value[0];
            if ((nextMode === "local" || nextMode === "worktree") && nextMode !== envToggleValue) {
              onEnvModeChange(nextMode);
            }
          }}
        >
          <Toggle
            className={ENV_MODE_TOGGLE_CLASS_NAME}
            disabled={envToggleDisabled}
            title="Use the local repository"
            value="local"
          >
            <span
              aria-hidden="true"
              data-slot="icon-chip"
              className={ENV_MODE_ICON_CHIP_CLASS_NAME}
            >
              <FolderIcon aria-hidden="true" />
            </span>
            Local
          </Toggle>
          <Toggle
            className={ENV_MODE_TOGGLE_CLASS_NAME}
            disabled={envToggleDisabled}
            title="Use a separate worktree"
            value="worktree"
          >
            <span
              aria-hidden="true"
              data-slot="icon-chip"
              className={ENV_MODE_ICON_CHIP_CLASS_NAME}
            >
              <GitBranchPlusIcon aria-hidden="true" />
            </span>
            {worktreeToggleLabel}
          </Toggle>
        </ToggleGroup>
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
