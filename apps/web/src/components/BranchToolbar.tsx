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
import { memo, useMemo } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useProject, useThread } from "../state/entities";
import { useIsMobile } from "../hooks/useMediaQuery";
import {
  type EnvMode,
  type EnvironmentOption,
  type ExistingWorktreeOption,
  deriveWorkspaceOptions,
  resolveEnvModeLabel,
  resolveEffectiveEnvMode,
  resolveWorkspaceSelection,
  withActiveWorkspaceFallback,
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
import { useAllBranches } from "../state/queries";

interface BranchToolbarProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  onEnvModeChange: (mode: EnvMode) => void;
  onExistingWorktreeChange: (worktree: ExistingWorktreeOption) => void;
  effectiveEnvModeOverride?: EnvMode;
  activeWorktreePathOverride?: string | null;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
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
  mainCheckout: ExistingWorktreeOption | null;
  onExistingWorktreeChange: (worktree: ExistingWorktreeOption) => void;
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
  mainCheckout,
  onExistingWorktreeChange,
}: MobileRunContextSelectorProps) {
  const activeEnvironment = useMemo(
    () => availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null,
    [availableEnvironments, environmentId],
  );
  const {
    isMainCheckout,
    selectedExistingWorktree,
    value: workspaceValue,
    label: workspaceLabel,
  } = resolveWorkspaceSelection({
    effectiveEnvMode,
    activeWorktreePath,
    mainCheckout,
    existingWorktrees,
  });
  const WorkspaceIcon = isMainCheckout
    ? FolderIcon
    : selectedExistingWorktree
      ? FolderGitIcon
      : FolderGit2Icon;
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
            value={workspaceValue}
            onValueChange={(value) => {
              if (mainCheckout && value === `main:${mainCheckout.path}`) {
                onExistingWorktreeChange(mainCheckout);
                return;
              }
              const existingWorktree = existingWorktrees.find(
                (item) => `existing:${item.path}` === value,
              );
              if (existingWorktree) {
                onExistingWorktreeChange(existingWorktree);
                return;
              }
              onEnvModeChange(value as EnvMode);
            }}
          >
            <MenuRadioItem
              disabled={envModeLocked}
              value={mainCheckout ? `main:${mainCheckout.path}` : "local"}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                <span className="min-w-0 truncate">Main checkout</span>
              </span>
            </MenuRadioItem>
            <MenuRadioItem disabled={envModeLocked} value="worktree">
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
              </span>
            </MenuRadioItem>
            {existingWorktrees.map((worktree) => (
              <MenuRadioItem
                key={worktree.path}
                disabled={envModeLocked}
                value={`existing:${worktree.path}`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <FolderGitIcon className="size-3" />
                  <span className="min-w-0 truncate">{worktree.label}</span>
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
  onExistingWorktreeChange,
  effectiveEnvModeOverride,
  activeWorktreePathOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
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
  const persistedWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeWorktreePath =
    activeWorktreePathOverride !== undefined ? activeWorktreePathOverride : persistedWorktreePath;
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread: serverThread !== null,
      draftThreadEnvMode: draftThread?.envMode,
    });
  const envModeLocked = envLocked || (serverThread !== null && persistedWorktreePath !== null);
  const branchState = useAllBranches({
    environmentId,
    cwd: activeProject?.workspaceRoot ?? null,
  });
  const activeBranch =
    activeThreadBranchOverride ?? serverThread?.branch ?? draftThread?.branch ?? null;
  const workspaceOptions = useMemo(() => {
    if (!activeProject) return { mainCheckout: null, existingWorktrees: [] };
    const options = deriveWorkspaceOptions(
      branchState.data?.refs ?? [],
      activeProject.workspaceRoot,
      branchState.data?.mainCheckoutPath,
    );
    // Always apply the fallback so a partial first page of refs that omits the
    // active worktree still keeps that checkout selectable in the picker.
    return withActiveWorkspaceFallback(options, {
      activeWorktreePath,
      activeBranch,
      projectWorkspaceRoot: activeProject.workspaceRoot,
    });
  }, [activeBranch, activeProject, activeWorktreePath, branchState.data]);

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
          existingWorktrees={workspaceOptions.existingWorktrees}
          mainCheckout={workspaceOptions.mainCheckout}
          onExistingWorktreeChange={onExistingWorktreeChange}
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
            existingWorktrees={workspaceOptions.existingWorktrees}
            mainCheckout={workspaceOptions.mainCheckout}
            onExistingWorktreeChange={onExistingWorktreeChange}
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
        {...(activeWorktreePathOverride !== undefined ? { activeWorktreePathOverride } : {})}
        {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
        {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
        startFromOrigin={startFromOrigin}
        onStartFromOriginChange={onStartFromOriginChange}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
    </div>
  );
});
