import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CloudIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  MonitorIcon,
} from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useProject, useThread } from "../state/entities";
import { useBranches } from "../state/queries";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useIsMobile } from "../hooks/useMediaQuery";
import {
  deriveExistingWorktreeOptions,
  type EnvMode,
  type EnvironmentOption,
  EXISTING_WORKTREE_VALUE_PREFIX,
  type ExistingWorktreeOption,
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveEffectiveEnvMode,
  resolveLockedWorkspaceLabel,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Separator } from "./ui/separator";

interface BranchToolbarProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  onEnvModeChange: (mode: EnvMode) => void;
  effectiveEnvModeOverride?: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  activeThreadWorktreePathOverride?: string | null;
  onActiveThreadWorktreePathOverrideChange?: (worktreePath: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}

interface MobileRunContextSelectorProps {
  envLocked: boolean;
  envModeLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  showEnvironmentPicker: boolean;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  existingWorktrees: readonly ExistingWorktreeOption[];
  onSelectExistingWorktree: (option: ExistingWorktreeOption) => void;
}

const MobileRunContextSelector = memo(function MobileRunContextSelector({
  envLocked,
  envModeLocked,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  onEnvironmentChange,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  existingWorktrees,
  onSelectExistingWorktree,
}: MobileRunContextSelectorProps) {
  const activeEnvironment = useMemo(
    () => availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null,
    [availableEnvironments, environmentId],
  );
  const WorkspaceIcon =
    effectiveEnvMode === "worktree"
      ? FolderGit2Icon
      : activeWorktreePath
        ? FolderGitIcon
        : FolderIcon;
  const workspaceLabel = envModeLocked
    ? resolveLockedWorkspaceLabel(activeWorktreePath)
    : effectiveEnvMode === "worktree"
      ? resolveEnvModeLabel("worktree")
      : resolveCurrentWorkspaceLabel(activeWorktreePath);
  const isLocked = envLocked || envModeLocked;
  const EnvironmentIcon = activeEnvironment?.isPrimary ? MonitorIcon : CloudIcon;
  const icon = showEnvironmentPicker ? (
    // Button's base styles apply `-mx-0.5` to descendant SVGs, which eats 4px
    // out of whatever gap we set. mx-0! cancels that so gap-0.5 reads as 2px.
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <EnvironmentIcon className="size-3 shrink-0 mx-0!" />
      <WorkspaceIcon className="size-3 shrink-0 mx-0!" />
    </span>
  ) : (
    <WorkspaceIcon className="size-3 shrink-0" />
  );
  const triggerContent = (
    <>
      {icon}
      <span className="min-w-0 truncate">
        {showEnvironmentPicker ? (activeEnvironment?.label ?? "Run on") : workspaceLabel}
      </span>
    </>
  );

  if (isLocked) {
    return (
      <span className="inline-flex min-w-0 max-w-[48%] flex-1 items-center justify-start gap-1 rounded-md border border-transparent px-[calc(--spacing(2)-1px)] text-sm font-medium text-muted-foreground/70 md:hidden">
        {triggerContent}
      </span>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" />}
        className="min-w-0 max-w-[48%] flex-1 justify-start text-muted-foreground/70 hover:text-foreground/80 md:hidden"
      >
        {triggerContent}
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-64">
        {showEnvironmentPicker && availableEnvironments && onEnvironmentChange ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Run on</MenuGroupLabel>
              <MenuRadioGroup
                value={environmentId}
                onValueChange={(value) => onEnvironmentChange(value as EnvironmentId)}
              >
                {availableEnvironments.map((env) => {
                  const Icon = env.isPrimary ? MonitorIcon : CloudIcon;
                  return (
                    <MenuRadioItem
                      key={env.environmentId}
                      disabled={envLocked}
                      value={env.environmentId}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Icon className="size-3" />
                        <span className="min-w-0 truncate">{env.label}</span>
                      </span>
                    </MenuRadioItem>
                  );
                })}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup
            value={effectiveEnvMode}
            onValueChange={(value) => {
              if (value.startsWith(EXISTING_WORKTREE_VALUE_PREFIX)) {
                const worktreePath = value.slice(EXISTING_WORKTREE_VALUE_PREFIX.length);
                const option = existingWorktrees.find(
                  (entry) => entry.worktreePath === worktreePath,
                );
                if (option) onSelectExistingWorktree(option);
                return;
              }
              onEnvModeChange(value as EnvMode);
            }}
          >
            <MenuRadioItem disabled={envModeLocked} value="local">
              <span className="flex min-w-0 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                <span className="min-w-0 truncate">
                  {resolveCurrentWorkspaceLabel(activeWorktreePath)}
                </span>
              </span>
            </MenuRadioItem>
            <MenuRadioItem disabled={envModeLocked} value="worktree">
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
              </span>
            </MenuRadioItem>
            {existingWorktrees.map((option) => (
              <MenuRadioItem
                key={option.worktreePath}
                disabled={envModeLocked}
                value={`${EXISTING_WORKTREE_VALUE_PREFIX}${option.worktreePath}`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <FolderGitIcon className="size-3 shrink-0" />
                  <span className="min-w-0 truncate">{option.branch}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/45">
                    {option.folderName}
                  </span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

export const BranchToolbar = memo(function BranchToolbar({
  environmentId,
  threadId,
  draftId,
  onEnvModeChange,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  activeThreadWorktreePathOverride,
  onActiveThreadWorktreePathOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
}: BranchToolbarProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const serverThread = useThread(threadRef);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProject = useProject(activeProjectRef);
  const hasActiveThread = serverThread !== null || draftThread !== null;
  // Reflect an optimistic "existing worktree" pick immediately so the env-mode
  // lock, labels and the branch picker's cwd don't lag the metadata round-trip.
  const activeWorktreePath =
    activeThreadWorktreePathOverride !== undefined
      ? activeThreadWorktreePathOverride
      : (serverThread?.worktreePath ?? draftThread?.worktreePath ?? null);
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread: serverThread !== null,
      draftThreadEnvMode: draftThread?.envMode,
    });
  const envModeLocked = envLocked || (serverThread !== null && activeWorktreePath !== null);

  // Existing worktrees a fresh thread can be started in. Sourced from the
  // branch refs (each ref carries its `worktreePath` from `git worktree list`,
  // so t3code- and externally-created worktrees both appear). Only fetched
  // while the workspace selector is interactive.
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const worktreeRefsQuery = useBranches({
    environmentId,
    cwd: envModeLocked ? null : activeProjectCwd,
  });
  const existingWorktrees = useMemo(
    () =>
      deriveExistingWorktreeOptions({
        refs: worktreeRefsQuery.data?.refs ?? [],
        activeProjectCwd,
        activeWorktreePath,
      }),
    [worktreeRefsQuery.data?.refs, activeProjectCwd, activeWorktreePath],
  );

  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread metadata update",
  );
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, "thread session stop");

  // Bind the thread (draft or server) to an existing worktree. Mirrors the
  // branch selector's `setThreadBranch` reuse path: no git op runs — the
  // server just adopts the provided worktree path as the thread's cwd.
  const onSelectExistingWorktree = useCallback(
    (option: ExistingWorktreeOption) => {
      if (!activeProject) return;
      const mutationThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
      if (!mutationThreadId) return;
      if (serverThread?.session && option.worktreePath !== activeWorktreePath) {
        void stopThreadSession({ environmentId, input: { threadId: mutationThreadId } });
      }
      if (serverThread !== null) {
        // Set the env-mode, branch and worktree-path overrides optimistically
        // so a send that races the async metadata round-trip already runs in
        // the chosen worktree instead of the thread's prior (local) mode. The
        // worktree-path override is what stops that raced send from spawning a
        // brand-new worktree and keeps the branch picker pointed at the chosen
        // worktree until the metadata update lands.
        onEnvModeChange("worktree");
        onActiveThreadWorktreePathOverrideChange?.(option.worktreePath);
        void updateThreadMetadata({
          environmentId,
          input: {
            threadId: mutationThreadId,
            branch: option.branch,
            worktreePath: option.worktreePath,
          },
        });
        onActiveThreadBranchOverrideChange?.(option.branch);
      } else {
        setDraftThreadContext(draftId ?? threadRef, {
          branch: option.branch,
          worktreePath: option.worktreePath,
          envMode: "worktree",
          projectRef: scopeProjectRef(environmentId, activeProject.id),
        });
      }
      onComposerFocusRequest?.();
    },
    [
      activeProject,
      serverThread,
      draftThread,
      threadId,
      activeWorktreePath,
      environmentId,
      stopThreadSession,
      updateThreadMetadata,
      onActiveThreadBranchOverrideChange,
      onActiveThreadWorktreePathOverrideChange,
      onEnvModeChange,
      setDraftThreadContext,
      draftId,
      threadRef,
      onComposerFocusRequest,
    ],
  );

  const showEnvironmentPicker = Boolean(
    availableEnvironments && availableEnvironments.length > 1 && onEnvironmentChange,
  );
  const isMobile = useIsMobile();

  if (!hasActiveThread || !activeProject) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-2.5 pb-3 pt-1 sm:px-3">
      {isMobile ? (
        <MobileRunContextSelector
          envLocked={envLocked}
          envModeLocked={envModeLocked}
          environmentId={environmentId}
          availableEnvironments={availableEnvironments}
          showEnvironmentPicker={showEnvironmentPicker}
          onEnvironmentChange={onEnvironmentChange}
          effectiveEnvMode={effectiveEnvMode}
          activeWorktreePath={activeWorktreePath}
          onEnvModeChange={onEnvModeChange}
          existingWorktrees={existingWorktrees}
          onSelectExistingWorktree={onSelectExistingWorktree}
        />
      ) : (
        <div className="flex min-w-0 shrink-0 items-center gap-1">
          {showEnvironmentPicker && availableEnvironments && onEnvironmentChange && (
            <>
              <BranchToolbarEnvironmentSelector
                envLocked={envLocked}
                environmentId={environmentId}
                availableEnvironments={availableEnvironments}
                onEnvironmentChange={onEnvironmentChange}
              />
              <Separator orientation="vertical" className="mx-0.5 h-3.5!" />
            </>
          )}
          <BranchToolbarEnvModeSelector
            envLocked={envModeLocked}
            effectiveEnvMode={effectiveEnvMode}
            activeWorktreePath={activeWorktreePath}
            onEnvModeChange={onEnvModeChange}
            existingWorktrees={existingWorktrees}
            onSelectExistingWorktree={onSelectExistingWorktree}
          />
        </div>
      )}

      <BranchToolbarBranchSelector
        className="min-w-0 flex-1 justify-end md:ml-auto md:flex-none"
        environmentId={environmentId}
        threadId={threadId}
        {...(draftId ? { draftId } : {})}
        envLocked={envLocked}
        {...(effectiveEnvModeOverride ? { effectiveEnvModeOverride } : {})}
        {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
        {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
        {...(activeThreadWorktreePathOverride !== undefined
          ? { activeWorktreePathOverride: activeThreadWorktreePathOverride }
          : {})}
        {...(onActiveThreadWorktreePathOverrideChange
          ? { onActiveWorktreePathOverrideChange: onActiveThreadWorktreePathOverrideChange }
          : {})}
        startFromOrigin={startFromOrigin}
        onStartFromOriginChange={onStartFromOriginChange}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
    </div>
  );
});
