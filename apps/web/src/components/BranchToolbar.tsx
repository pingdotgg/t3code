import { scopeThreadRef } from "@t3tools/client-runtime";
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

import type { ContextWindowSnapshot } from "../lib/contextWindow";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useEnvironment } from "../state/environments";
import { useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { cn } from "~/lib/utils";
import {
  type EnvMode,
  type EnvironmentOption,
  resolveActiveProjectRef,
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveEffectiveEnvMode,
  resolveLockedWorkspaceLabel,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { ContextWindowMeter } from "./chat/ContextWindowMeter";
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
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  activeContextWindow: ContextWindowSnapshot | null;
  activeThreadProviderDisplayName: string | null;
  showGitControls?: boolean;
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
  projectCwd: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
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
  projectCwd,
  onEnvModeChange,
}: MobileRunContextSelectorProps) {
  const activeEnvironment = useMemo(
    () => availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null,
    [availableEnvironments, environmentId],
  );
  const environmentLabel = activeEnvironment?.label ?? "Run on";
  const EnvironmentIcon = activeEnvironment?.isPrimary ? MonitorIcon : CloudIcon;
  const WorkspaceIcon =
    effectiveEnvMode === "worktree"
      ? FolderGit2Icon
      : activeWorktreePath
        ? FolderGitIcon
        : FolderIcon;
  const workspaceLabel = envModeLocked
    ? resolveLockedWorkspaceLabel(activeWorktreePath, projectCwd)
    : effectiveEnvMode === "worktree"
      ? resolveEnvModeLabel("worktree")
      : resolveCurrentWorkspaceLabel(activeWorktreePath, projectCwd);

  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" />}
        className="min-w-0 flex-1 justify-start text-[length:var(--app-composer-meta-font-size)]! text-muted-foreground/70 hover:text-foreground/80 md:hidden"
      >
        {showEnvironmentPicker ? (
          <>
            <EnvironmentIcon className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{environmentLabel}</span>
          </>
        ) : (
          <>
            <WorkspaceIcon className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{workspaceLabel}</span>
          </>
        )}
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
            onValueChange={(value) => onEnvModeChange(value as EnvMode)}
          >
            <MenuRadioItem disabled={envModeLocked} value="local">
              <span className="flex min-w-0 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                <span className="min-w-0 truncate">
                  {resolveCurrentWorkspaceLabel(activeWorktreePath, projectCwd)}
                </span>
              </span>
            </MenuRadioItem>
            <MenuRadioItem disabled={envModeLocked} value="worktree">
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
              </span>
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

const BranchToolbarDeviceLabel = memo(function BranchToolbarDeviceLabel({
  environmentId,
  availableEnvironments,
}: {
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
}) {
  const pickerMatch = useMemo(
    () => availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null,
    [availableEnvironments, environmentId],
  );
  const connectedEnvironment = useEnvironment(environmentId);
  const deviceLabel = pickerMatch?.label ?? connectedEnvironment?.label ?? null;
  if (!deviceLabel) return null;
  return (
    <span
      className="inline-flex min-w-0 max-w-24 shrink items-center truncate border border-transparent px-[calc(--spacing(2)-1px)] text-[length:var(--app-composer-meta-font-size)] font-medium text-muted-foreground/70 sm:max-w-40"
      title={`Execution environment: ${deviceLabel}`}
      aria-label={`Execution environment: ${deviceLabel}`}
    >
      <span className="truncate">{deviceLabel}</span>
    </span>
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
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
  activeContextWindow,
  activeThreadProviderDisplayName,
  showGitControls = true,
}: BranchToolbarProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const serverThreadSelector = useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]);
  const serverThread = useStore(serverThreadSelector);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const activeProjectRef = resolveActiveProjectRef(serverThread, draftThread);
  const activeProjectSelector = useMemo(
    () => createProjectSelectorByRef(activeProjectRef),
    [activeProjectRef],
  );
  const activeProject = useStore(activeProjectSelector);
  const hasActiveThread = serverThread !== undefined || draftThread !== null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeProjectCwd = activeProject?.cwd ?? null;
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread: serverThread !== undefined,
      draftThreadEnvMode: draftThread?.envMode,
      projectCwd: activeProjectCwd,
    });
  const canPrepareServerWorktree = Boolean(
    serverThread !== undefined &&
    activeWorktreePath === null &&
    effectiveEnvModeOverride !== undefined,
  );
  const envModeLocked =
    (envLocked && !canPrepareServerWorktree) ||
    (serverThread !== undefined && activeWorktreePath !== null);
  const branchLocked = envLocked && !(canPrepareServerWorktree && effectiveEnvMode === "worktree");

  const showEnvironmentPicker = Boolean(
    availableEnvironments && availableEnvironments.length > 0 && onEnvironmentChange,
  );
  const isMobile = useIsMobile();

  if (!hasActiveThread || !activeProject || (!showGitControls && !activeContextWindow)) return null;

  return (
    <div
      className={cn(
        "[--composer-drawer-inset:1.375rem] relative isolate mx-auto -mt-4 flex w-[calc(100%-2*var(--composer-drawer-inset))] max-w-[calc(48rem-2*var(--composer-drawer-inset))] items-center gap-2 overflow-x-clip overflow-y-visible px-1 pt-5 pb-1 text-[length:var(--app-composer-meta-font-size)] leading-4 font-normal text-muted-foreground/70",
        "before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-b-[16px] before:border before:border-border/70 before:mask-[linear-gradient(to_bottom,transparent_0_1rem,black_1rem)] before:shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)]",
        "dark:before:border-white/7 dark:before:bg-[linear-gradient(to_bottom,transparent_0_1rem,rgb(0_0_0/18%)_1rem,transparent_calc(1rem+10px)),linear-gradient(rgb(255_255_255/1%),rgb(255_255_255/1%))] dark:before:shadow-[0_14px_32px_-18px_rgb(0_0_0/75%)]",
        showGitControls ? "justify-between" : "justify-end",
      )}
      style={{
        paddingLeft: "calc(env(safe-area-inset-left) + var(--spacing) * 2.5)",
        paddingRight: "calc(env(safe-area-inset-right) + var(--spacing) * 2.5)",
      }}
    >
      {showGitControls ? (
        <>
          {isMobile ? (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <MobileRunContextSelector
                envLocked={envLocked}
                envModeLocked={envModeLocked}
                environmentId={environmentId}
                availableEnvironments={availableEnvironments}
                showEnvironmentPicker={showEnvironmentPicker}
                onEnvironmentChange={onEnvironmentChange}
                effectiveEnvMode={effectiveEnvMode}
                activeWorktreePath={activeWorktreePath}
                projectCwd={activeProjectCwd}
                onEnvModeChange={onEnvModeChange}
              />
              {/* The Run-on picker already names the device; only show the
                  static label when there is no picker. */}
              {showEnvironmentPicker ? null : (
                <BranchToolbarDeviceLabel
                  environmentId={environmentId}
                  availableEnvironments={availableEnvironments}
                />
              )}
            </div>
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
                projectCwd={activeProjectCwd}
                onEnvModeChange={onEnvModeChange}
              />
              {showEnvironmentPicker ? null : (
                <BranchToolbarDeviceLabel
                  environmentId={environmentId}
                  availableEnvironments={availableEnvironments}
                />
              )}
            </div>
          )}

          <BranchToolbarBranchSelector
            className="min-w-0 flex-1 justify-end md:ml-auto md:flex-none"
            environmentId={environmentId}
            threadId={threadId}
            {...(draftId ? { draftId } : {})}
            envLocked={branchLocked}
            {...(effectiveEnvModeOverride ? { effectiveEnvModeOverride } : {})}
            {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
            {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
            {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
            {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
          />
        </>
      ) : null}
      {activeContextWindow ? (
        <ContextWindowMeter
          usage={activeContextWindow}
          providerDisplayName={activeThreadProviderDisplayName}
        />
      ) : null}
    </div>
  );
});
