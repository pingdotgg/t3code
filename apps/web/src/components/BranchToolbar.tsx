import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { readLocalApi } from "../localApi";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  GitBranchIcon,
  HistoryIcon,
  PlusIcon,
  ScaleIcon,
} from "lucide-react";
import {
  type Ref,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  memo,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useProject, useThreadShellsForProjectRefs } from "../state/entities";
import {
  ADD_TO_MACHINE_LABEL_CLASS,
  type EnvMode,
  type EnvironmentOption,
  resolveContextStripCompaction,
  type ContextStripCompaction,
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  resolvePreviousWorktreeLabel,
  resolvePreviousWorktreeSeed,
  type PreviousWorktreeSeed,
} from "./BranchToolbar.logic";
import {
  BranchToolbarBranchSelector,
  type BranchToolbarBranchSelectorHandle,
} from "./BranchToolbarBranchSelector";
import { openAddProjectToMachine } from "./AddProjectToMachineDialog";
import { type AddProjectTarget, useAddProjectTargets } from "../hooks/useAddProjectTargets";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { StartTruncatedPath } from "./StartTruncatedPath";
import { Badge } from "./ui/badge";
import { useRelativeTimeState } from "../hooks/useRelativeTimeState";
import { useConnectedEnvironmentIds } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { ComposerControl } from "./chat/ComposerControl";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ComposerSurface } from "./chat/ComposerSurface";
import { measureRestingComposerControls } from "./chat/restingComposerControlsMeasurement";
import {
  resolveRestingComposerControlsMinimumWidth,
  resolveRestingComposerControlsNaturalWidth,
} from "./composerFooterLayout";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";

export interface BranchToolbarHandle {
  openBranchPicker: () => void;
  usePreviousWorktree: () => void;
}

interface BranchToolbarProps {
  layout?: "composer" | "panel";
  panelSection?: "all" | "workspace" | "branch";
  forceNewWorktree?: boolean;
  ref?: Ref<BranchToolbarHandle>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  showGitControls: boolean;
  draftId?: DraftId;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  /** Shown at the end of the composer strip, such as the new thread's permissions. */
  trailing?: ReactNode;
  afterBranch?: ReactNode;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  /** The thread's machine is offline or reconnecting. */
  environmentUnavailable?: boolean;
  /** Panel only: where the branch picker renders the thread's PR rows. */
  panelPrRowsContainer?: HTMLElement | null;
}

interface WorkspaceMenuProps {
  branch?: {
    label: string;
    disabled: boolean;
    open: boolean;
    focusSearch: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
    onContextMenu: (event: ReactMouseEvent) => void;
  };
  /** List Run on here because no machine chip is shown, as on local threads. */
  showRunOn: boolean;
  forceNewWorktree: boolean;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  envModeLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  showEnvironmentPicker: boolean;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  workspaceRoot: string;
  previousWorktree: PreviousWorktreeSeed | null;
  onUsePreviousWorktree: () => void;
  addTargets: readonly AddProjectTarget[];
  onAddToMachine: (environmentId: EnvironmentId) => void;
}

type MachineMenuProps = Pick<
  WorkspaceMenuProps,
  | "autoEnvironmentLabel"
  | "onAutoEnvironment"
  | "envLocked"
  | "environmentId"
  | "availableEnvironments"
  | "showEnvironmentPicker"
  | "onEnvironmentChange"
  | "addTargets"
  | "onAddToMachine"
> & { environmentUnavailable: boolean };

/** "2h ago · 3 files changed" for the previous worktree row; the count is read while open. */
function PreviousWorktreeMeta({
  environmentId,
  worktree,
}: {
  environmentId: EnvironmentId;
  worktree: PreviousWorktreeSeed;
}) {
  const status = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd: worktree.worktreePath } }),
  );
  const changedFiles = status.data?.isRepo ? status.data.workingTree.files.length : null;
  const relative = useRelativeTimeState(worktree.updatedAt);
  const age =
    relative.status === "relative"
      ? relative.suffix
        ? `${relative.value} ${relative.suffix}`
        : relative.value
      : "";
  const parts = [
    age,
    changedFiles === null
      ? null
      : changedFiles === 0
        ? "no changes"
        : `${changedFiles} ${changedFiles === 1 ? "file" : "files"} changed`,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? (
    <span className="flex shrink-0 flex-col items-end gap-0.5 text-meta text-dim-foreground">
      {parts.map((part) => (
        <span key={part}>{part}</span>
      ))}
    </span>
  ) : null;
}

/** The composer's workspace and branch chip. Machines have their own chip, `MachineMenu`. */
const WorkspaceMenu = memo(function WorkspaceMenu({
  branch,
  showRunOn,
  forceNewWorktree,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  envModeLocked,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  onEnvironmentChange,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  workspaceRoot,
  previousWorktree,
  onUsePreviousWorktree,
  addTargets,
  onAddToMachine,
}: WorkspaceMenuProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const open = branch?.open ?? workspaceOpen;
  const setOpen = branch?.onOpenChange ?? setWorkspaceOpen;
  const inWorktree = forceNewWorktree || effectiveEnvMode === "worktree" || activeWorktreePath;
  const WorkspaceIcon = inWorktree ? FolderGit2Icon : GitBranchIcon;
  const workspaceLabel = forceNewWorktree
    ? resolveEnvModeLabel("worktree")
    : envModeLocked
      ? resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)
      : effectiveEnvMode === "worktree"
        ? resolveEnvModeLabel("worktree")
        : resolveCurrentWorkspaceLabel(activeWorktreePath);
  const canPickEnvironment = (showEnvironmentPicker && !envLocked) || addTargets.length > 0;
  const icon = <WorkspaceIcon aria-hidden className="size-3 shrink-0" />;

  if (envModeLocked && !(showRunOn && canPickEnvironment) && !branch) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="inline-flex h-7 shrink-0 items-center ps-2 pe-0.5 text-muted-foreground sm:h-5.5"
              data-composer-context-control
              aria-label={workspaceLabel}
            />
          }
        >
          {icon}
        </TooltipTrigger>
        <TooltipPopup>{workspaceLabel}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(nextOpen) => {
        if (nextOpen) {
          popupRef.current
            ?.querySelector<HTMLElement>(
              branch?.focusSearch
                ? 'input[role="combobox"]'
                : '[data-composer-workspace] [aria-checked="true"]',
            )
            ?.focus();
        }
      }}
      modal={false}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<ComposerControl size="xs" />}
              className={branch ? "min-w-0 max-w-full" : envModeLocked ? "ps-2 pe-0.5" : "ps-2"}
              aria-label={
                branch ? `Branch and workspace: ${branch.label}` : `Workspace: ${workspaceLabel}`
              }
              onContextMenu={branch?.onContextMenu}
              data-composer-context-control
              data-composer-shortcut={[
                showRunOn && canPickEnvironment ? "composer.host" : "",
                !envModeLocked ? "composer.workspace" : "",
              ].join(" ")}
            />
          }
        >
          {icon}
          {envModeLocked && !branch ? null : (
            <>
              <ComposerContextLabel compact={branch ? "truncate" : "hide"}>
                {branch?.label ?? workspaceLabel}
              </ComposerContextLabel>
              <ChevronDownIcon
                aria-hidden
                data-composer-chevron
                className="size-2.5 shrink-0 text-muted-foreground"
              />
            </>
          )}
        </TooltipTrigger>
        <TooltipPopup>
          <span className="flex flex-col gap-0.5">
            {branch ? <span>{branch.label}</span> : null}
            <span>{workspaceLabel}</span>
          </span>
        </TooltipPopup>
      </Tooltip>
      <MenuPopup
        ref={popupRef}
        spacing="relaxed"
        align="start"
        side="top"
        // Workspace choices and paths need a consistent width regardless of the chip label.
        className="w-90"
        {...composerFloatingLayerProps}
        data-composer-run-context
      >
        {showRunOn && availableEnvironments && availableEnvironments.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Run on</MenuGroupLabel>
            <MenuRadioGroup
              value={autoEnvironmentLabel ? "auto" : environmentId}
              onValueChange={(value) =>
                value === "auto"
                  ? onAutoEnvironment?.()
                  : onEnvironmentChange?.(value as EnvironmentId)
              }
            >
              {availableEnvironments.map((env) => (
                <MenuRadioItem
                  key={env.environmentId}
                  disabled={
                    envLocked || (!onEnvironmentChange && env.environmentId !== environmentId)
                  }
                  value={env.environmentId}
                  closeOnClick
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <EnvironmentMachineIcon
                      kind={env.machine}
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate">{env.label}</span>
                    {env.isPrimary ? null : connectedEnvironmentIds.includes(env.environmentId) ? (
                      <Badge variant="success">Online</Badge>
                    ) : (
                      <Badge variant="unavailable">Offline</Badge>
                    )}
                  </span>
                </MenuRadioItem>
              ))}
              {onAutoEnvironment && (
                <MenuRadioItem
                  value="auto"
                  disabled={envLocked}
                  closeOnClick
                  onClick={() => {
                    if (autoEnvironmentLabel) onAutoEnvironment?.();
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <ScaleIcon
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="shrink-0">{autoEnvironmentLabel ?? "Auto balance"}</span>
                    <span className="min-w-0 truncate text-meta text-dim-foreground">
                      Least busy machine
                    </span>
                  </span>
                </MenuRadioItem>
              )}
            </MenuRadioGroup>
            {addTargets.length > 0 ? (
              <MenuSub>
                <MenuSubTrigger>
                  <span className={ADD_TO_MACHINE_LABEL_CLASS}>
                    <PlusIcon className="size-3" />
                    <span className="min-w-0 truncate">Add to another machine</span>
                  </span>
                </MenuSubTrigger>
                <MenuSubPopup {...composerFloatingLayerProps}>
                  {addTargets.map((target) => (
                    <MenuItem
                      key={target.environmentId}
                      onClick={() => onAddToMachine(target.environmentId)}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <EnvironmentMachineIcon kind={target.machine} className="size-3" />
                        <span className="min-w-0 truncate">{target.label}</span>
                      </span>
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            ) : null}
          </MenuGroup>
        ) : null}
        <MenuGroup data-composer-workspace>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup
            value={effectiveEnvMode}
            onValueChange={(value) => onEnvModeChange(value as EnvMode)}
          >
            <MenuRadioItem disabled={envModeLocked || forceNewWorktree} value="local" closeOnClick>
              <span className="flex min-w-0 items-center gap-2.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="shrink-0">{resolveCurrentWorkspaceLabel(activeWorktreePath)}</span>
                <StartTruncatedPath
                  path={activeWorktreePath ?? workspaceRoot}
                  className="min-w-0 flex-1 pe-2 text-meta text-dim-foreground"
                />
              </span>
            </MenuRadioItem>
            <MenuRadioItem disabled={envModeLocked} value="worktree" closeOnClick>
              <span className="flex min-w-0 items-center gap-2.5">
                <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0">{resolveEnvModeLabel("worktree")}</span>
                <span className="min-w-0 truncate text-meta text-dim-foreground">
                  {forceNewWorktree
                    ? "Each model starts in its own worktree."
                    : "Starts in a fresh worktree."}
                </span>
              </span>
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {previousWorktree ? (
          <MenuGroup>
            <MenuGroupLabel>Previous worktree</MenuGroupLabel>
            <MenuItem disabled={envModeLocked} onClick={onUsePreviousWorktree}>
              <HistoryIcon />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 truncate">
                  {previousWorktree.branch ?? previousWorktree.worktreePath}
                </span>
                {open ? (
                  <PreviousWorktreeMeta environmentId={environmentId} worktree={previousWorktree} />
                ) : null}
              </span>
            </MenuItem>
          </MenuGroup>
        ) : null}
        {branch ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>
                {inWorktree && !activeWorktreePath ? "Base ref" : "Branch"}
              </MenuGroupLabel>
            </MenuGroup>
            <div
              className="flex min-h-0 flex-col"
              inert={branch.disabled}
              aria-busy={branch.disabled}
              onKeyDown={(event) => {
                if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
              }}
            >
              {branch.children}
            </div>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

/** The composer's machine chip, shown on remote threads: only the machines to run on. */
const MachineMenu = memo(function MachineMenu({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  onEnvironmentChange,
  environmentUnavailable,
  addTargets,
  onAddToMachine,
}: MachineMenuProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const popupRef = useRef<HTMLDivElement>(null);
  const activeEnvironment = availableEnvironments?.find(
    (env) => env.environmentId === environmentId,
  );
  const environmentLabel = autoEnvironmentLabel ?? activeEnvironment?.label ?? environmentId;
  const canPickEnvironment = (showEnvironmentPicker && !envLocked) || addTargets.length > 0;
  const icon = autoEnvironmentLabel ? (
    <ScaleIcon aria-hidden className="size-3 shrink-0" />
  ) : (
    <EnvironmentMachineIcon
      kind={activeEnvironment?.machine ?? "server"}
      className="size-3 shrink-0"
    />
  );
  const tooltip = (
    <TooltipPopup>
      {environmentLabel}
      {environmentUnavailable ? " (offline)" : ""}
    </TooltipPopup>
  );

  if (!canPickEnvironment) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                "inline-flex h-7 min-w-0 max-w-[48%] flex-initial items-center justify-start gap-1 rounded-md border border-transparent ps-2 pe-1.75 text-meta text-dim-foreground sm:h-6",
                environmentUnavailable && "text-warning-foreground",
              )}
              aria-label={`Run on: ${environmentLabel}`}
              data-composer-context-control
            />
          }
        >
          {icon}
          <ComposerContextLabel>{environmentLabel}</ComposerContextLabel>
        </TooltipTrigger>
        {tooltip}
      </Tooltip>
    );
  }

  return (
    <Menu
      onOpenChangeComplete={(nextOpen) => {
        if (nextOpen) {
          popupRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
        }
      }}
      modal={false}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<ComposerControl size="xs" />}
              className={cn(
                "min-w-0 max-w-full",
                environmentUnavailable && "text-warning-foreground",
              )}
              aria-label={`Run on: ${environmentLabel}`}
              data-composer-context-control
              data-composer-shortcut="composer.host"
            />
          }
        >
          {icon}
          <ComposerContextLabel>{environmentLabel}</ComposerContextLabel>
          <ChevronDownIcon
            aria-hidden
            data-composer-chevron
            className="size-2.5 shrink-0 text-muted-foreground"
          />
        </TooltipTrigger>
        {tooltip}
      </Tooltip>
      <MenuPopup
        ref={popupRef}
        spacing="relaxed"
        align="start"
        side="top"
        className="w-72"
        {...composerFloatingLayerProps}
        data-composer-run-context
      >
        <MenuGroup>
          <MenuGroupLabel>Run on</MenuGroupLabel>
          <MenuRadioGroup
            value={autoEnvironmentLabel ? "auto" : environmentId}
            onValueChange={(value) =>
              value === "auto"
                ? onAutoEnvironment?.()
                : onEnvironmentChange?.(value as EnvironmentId)
            }
          >
            {availableEnvironments?.map((env) => (
              <MenuRadioItem
                key={env.environmentId}
                disabled={
                  envLocked || (!onEnvironmentChange && env.environmentId !== environmentId)
                }
                value={env.environmentId}
                closeOnClick
              >
                <span className="flex min-w-0 items-center gap-2">
                  <EnvironmentMachineIcon
                    kind={env.machine}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate">{env.label}</span>
                  {env.isPrimary ? null : connectedEnvironmentIds.includes(env.environmentId) ? (
                    <Badge variant="success">Online</Badge>
                  ) : (
                    <Badge variant="unavailable">Offline</Badge>
                  )}
                </span>
              </MenuRadioItem>
            ))}
            {onAutoEnvironment && (
              <MenuRadioItem
                value="auto"
                disabled={envLocked}
                closeOnClick
                onClick={() => {
                  if (autoEnvironmentLabel) onAutoEnvironment?.();
                }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ScaleIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="shrink-0">{autoEnvironmentLabel ?? "Auto balance"}</span>
                  <span className="min-w-0 truncate text-meta text-dim-foreground">
                    Least busy machine
                  </span>
                </span>
              </MenuRadioItem>
            )}
          </MenuRadioGroup>
          {addTargets.length > 0 ? (
            <MenuSub>
              <MenuSubTrigger>
                <span className={ADD_TO_MACHINE_LABEL_CLASS}>
                  <PlusIcon className="size-3" />
                  <span className="min-w-0 truncate">Add to another machine</span>
                </span>
              </MenuSubTrigger>
              <MenuSubPopup {...composerFloatingLayerProps}>
                {addTargets.map((target) => (
                  <MenuItem
                    key={target.environmentId}
                    onClick={() => onAddToMachine(target.environmentId)}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <EnvironmentMachineIcon kind={target.machine} className="size-3" />
                      <span className="min-w-0 truncate">{target.label}</span>
                    </span>
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          ) : null}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

/** The thread panel's run-context row: machine, workspace, and a copy-path context menu. */
function showWorkspaceContextMenu(event: ReactMouseEvent, workspacePath: string) {
  const api = readLocalApi();
  if (!api) return;
  event.preventDefault();
  event.stopPropagation();
  void api.contextMenu
    .show([{ id: "copy-path", label: "Copy full path", icon: "copy" }], {
      x: event.clientX,
      y: event.clientY,
    })
    .then((action) => {
      if (action !== "copy-path") return;
      const clipboardPath = formatFilePathForClipboard(workspacePath);
      void writeTextToClipboard(clipboardPath, "workspace path").then(
        (didCopy) => {
          if (didCopy) {
            toastManager.add({
              type: "success",
              title: "Path copied",
              description: clipboardPath,
            });
          }
        },
        (error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to copy path",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        },
      );
    });
}

interface RunContextSelectorProps {
  displayMode?: "toolbar" | "panel";
  workspaceRoot?: string;
  forceNewWorktree: boolean;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  envModeLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  showEnvironmentPicker: boolean;
  showEnvironmentIndicator: boolean;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel: string | null;
  previousWorktreeBranch: string | null;
  onUsePreviousWorktree: () => void;
  addTargets: readonly AddProjectTarget[];
  onAddToMachine: (environmentId: EnvironmentId) => void;
}

const RunContextSelector = memo(function RunContextSelector({
  displayMode = "toolbar",
  workspaceRoot,
  forceNewWorktree,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  envModeLocked,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  showEnvironmentIndicator,
  onEnvironmentChange,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  previousWorktreeBranch,
  onUsePreviousWorktree,
  addTargets,
  onAddToMachine,
}: RunContextSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const activeEnvironment =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  const WorkspaceIcon =
    effectiveEnvMode === "worktree"
      ? FolderGit2Icon
      : activeWorktreePath
        ? FolderGitIcon
        : FolderIcon;
  const workspaceLabel = forceNewWorktree
    ? resolveEnvModeLabel("worktree")
    : envModeLocked
      ? resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)
      : effectiveEnvMode === "worktree"
        ? resolveEnvModeLabel("worktree")
        : resolveCurrentWorkspaceLabel(activeWorktreePath);
  const isPanel = displayMode === "panel";
  const isLocked = !isPanel && (envLocked || envModeLocked);
  const workspacePath =
    forceNewWorktree || (effectiveEnvMode === "worktree" && !activeWorktreePath)
      ? null
      : (activeWorktreePath ?? workspaceRoot);
  const handleContextMenu = (event: ReactMouseEvent) => {
    if (isPanel && workspacePath) {
      showWorkspaceContextMenu(event, workspacePath);
    }
  };
  const workspaceIcon = (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <WorkspaceIcon className={isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"} />
      </TooltipTrigger>
      <TooltipPopup>
        {isPanel
          ? forceNewWorktree
            ? "Each model starts in its own worktree."
            : (workspacePath ?? workspaceLabel)
          : workspaceLabel}
      </TooltipPopup>
    </Tooltip>
  );
  const environmentIcon = (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        {autoEnvironmentLabel ? (
          <ScaleIcon
            className={isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0"}
            aria-hidden="true"
          />
        ) : (
          <EnvironmentMachineIcon
            kind={activeEnvironment?.machine ?? "server"}
            // Wide machine glyphs need a little more box to match the square row icons.
            className={
              isPanel ? cn(THREAD_DETAILS_PANEL_ICON_CLASS, "-mx-px size-4.5") : "size-3 shrink-0"
            }
          />
        )}
      </TooltipTrigger>
      <TooltipPopup>{autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}</TooltipPopup>
    </Tooltip>
  );
  const icon = showEnvironmentIndicator ? environmentIcon : workspaceIcon;
  const triggerContent = (
    <>
      {isPanel ? (
        autoEnvironmentLabel ? (
          <ScaleIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        ) : (
          <EnvironmentMachineIcon
            kind={activeEnvironment?.machine ?? "server"}
            className={THREAD_DETAILS_PANEL_ICON_CLASS}
          />
        )
      ) : (
        icon
      )}
      <ComposerContextLabel displayMode={displayMode}>
        {autoEnvironmentLabel ??
          (isPanel || showEnvironmentIndicator
            ? (activeEnvironment?.label ?? "Run on")
            : workspaceLabel)}
      </ComposerContextLabel>
    </>
  );

  if (isLocked) {
    return (
      <span
        className={cn(
          isPanel
            ? THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS
            : "inline-flex h-7 min-w-0 max-w-[48%] flex-initial items-center justify-start gap-1 rounded-md border border-transparent px-1.75 text-dim-foreground text-caption sm:h-6",
        )}
        onContextMenu={handleContextMenu}
        aria-label={
          isPanel
            ? `Run context: ${[autoEnvironmentLabel ?? activeEnvironment?.label, workspaceLabel].filter(Boolean).join(", ")}`
            : undefined
        }
        data-composer-context-control
      >
        {triggerContent}
      </span>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={isPanel ? <ThreadDetailsControl /> : <ComposerControl size="xs" />}
        className={isPanel ? undefined : "min-w-0 max-w-[48%] flex-initial justify-start"}
        onContextMenu={handleContextMenu}
        onMouseDownCapture={
          isPanel
            ? (event) => {
                if (event.button !== 0 || event.ctrlKey) event.stopPropagation();
              }
            : undefined
        }
        aria-label={
          isPanel
            ? `Run context: ${[autoEnvironmentLabel ?? activeEnvironment?.label, workspaceLabel].filter(Boolean).join(", ")}`
            : undefined
        }
        data-composer-context-control
        data-composer-shortcut={[
          showEnvironmentPicker && !envLocked ? "composer.host" : "",
          !envModeLocked ? "composer.workspace" : "",
        ].join(" ")}
      >
        {triggerContent}
        {isPanel ? (
          <ChevronDownIcon className="ms-auto size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
      </MenuTrigger>
      <MenuPopup
        align="start"
        side={isPanel ? "right" : "top"}
        className={
          isPanel
            ? "w-(--anchor-width)"
            : previousWorktreeLabel
              ? "w-[min(21rem,calc(100vw-2rem))]"
              : undefined
        }
        {...(!isPanel ? composerFloatingLayerProps : {})}
      >
        {isPanel && workspacePath ? (
          <MenuGroup>
            <MenuGroupLabel>{activeEnvironment?.label ?? "Environment"}</MenuGroupLabel>
            <div className="px-2 py-1 text-caption text-muted-foreground break-all">
              {workspacePath}
            </div>
          </MenuGroup>
        ) : null}
        {availableEnvironments &&
        ((showEnvironmentPicker && onEnvironmentChange) || addTargets.length > 0) ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Run on</MenuGroupLabel>
              <MenuRadioGroup
                value={autoEnvironmentLabel ? "auto" : environmentId}
                onValueChange={(value) =>
                  value === "auto"
                    ? onAutoEnvironment?.()
                    : onEnvironmentChange?.(value as EnvironmentId)
                }
              >
                {onAutoEnvironment && (
                  <MenuRadioItem
                    value="auto"
                    disabled={envLocked}
                    closeOnClick
                    onClick={() => {
                      if (autoEnvironmentLabel) onAutoEnvironment?.();
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ScaleIcon className="size-3" aria-hidden="true" />
                      <span className="min-w-0 truncate">
                        {autoEnvironmentLabel ?? "Auto balance"}
                      </span>
                    </span>
                  </MenuRadioItem>
                )}
                {availableEnvironments.map((env) => (
                  <MenuRadioItem
                    key={env.environmentId}
                    disabled={
                      envLocked || (!onEnvironmentChange && env.environmentId !== environmentId)
                    }
                    value={env.environmentId}
                    closeOnClick
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                      <span className="min-w-0 truncate">{env.label}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              {addTargets.length > 0 ? (
                <MenuSub>
                  <MenuSubTrigger>
                    <span className={ADD_TO_MACHINE_LABEL_CLASS}>
                      <PlusIcon className="size-3" />
                      <span className="min-w-0 truncate">Add to another machine</span>
                    </span>
                  </MenuSubTrigger>
                  <MenuSubPopup {...(!isPanel ? composerFloatingLayerProps : {})}>
                    {addTargets.map((target) => (
                      <MenuItem
                        key={target.environmentId}
                        onClick={() => onAddToMachine(target.environmentId)}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <EnvironmentMachineIcon kind={target.machine} className="size-3" />
                          <span className="min-w-0 truncate">{target.label}</span>
                        </span>
                      </MenuItem>
                    ))}
                  </MenuSubPopup>
                </MenuSub>
              ) : null}
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup
            value={effectiveEnvMode}
            onValueChange={(value) => {
              if (value === "previous-worktree") {
                onUsePreviousWorktree();
                return;
              }
              onEnvModeChange(value as EnvMode);
            }}
          >
            <MenuRadioItem disabled={envModeLocked || forceNewWorktree} value="local" closeOnClick>
              <span className="flex min-w-0 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                <MiddleTruncate value={resolveCurrentWorkspaceLabel(activeWorktreePath)} />
              </span>
            </MenuRadioItem>
            <MenuRadioItem disabled={envModeLocked} value="worktree" closeOnClick>
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
              </span>
            </MenuRadioItem>
            {previousWorktreeLabel ? (
              <MenuRadioItem disabled={envModeLocked} value="previous-worktree" closeOnClick>
                <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

const COMPOSER_CONTEXT_MOTION_DURATION_MS = 180;
const COMPOSER_CONTEXT_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const COMPOSER_CONTEXT_LABEL_SELECTOR = "[data-composer-label]";
const RESTING_CONTROLS_SELECTOR = '[data-chat-composer-resting-controls="true"]';

function readStripCompaction(strip: HTMLElement): ContextStripCompaction {
  const value = strip.dataset.compact;
  return value === "labels" || value === "branch" ? value : "none";
}

/** A hidden or squeezed label's scrollWidth loses its tail, causing label/icon flapping. */
function labelTextWidth(label: HTMLElement, range: Range): number {
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  let width = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    width += range.getBoundingClientRect().width;
  }
  const motion = label.querySelector<HTMLElement>("[data-composer-label-motion]");
  const maxWidth = motion ? Number.parseFloat(getComputedStyle(motion).maxWidth) : Number.NaN;
  return Number.isFinite(maxWidth) ? Math.min(width, maxWidth) : width;
}

function animateLabelWidths(
  previousRects: ReadonlyMap<HTMLElement, DOMRect>,
  animations: Map<HTMLElement, Animation>,
) {
  for (const animation of animations.values()) animation.cancel();
  animations.clear();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  for (const [label, previousRect] of previousRects) {
    if (!label.isConnected) continue;
    const nextWidth = label.getBoundingClientRect().width;
    if (Math.abs(previousRect.width - nextWidth) < 0.5) continue;

    const animation = label.animate(
      [
        { width: `${previousRect.width}px`, maxWidth: `${previousRect.width}px` },
        { width: `${nextWidth}px`, maxWidth: `${nextWidth}px` },
      ],
      {
        duration: COMPOSER_CONTEXT_MOTION_DURATION_MS,
        easing: COMPOSER_CONTEXT_MOTION_EASING,
        fill: "backwards",
      },
    );
    animations.set(label, animation);
    animation.addEventListener(
      "finish",
      () => {
        if (animations.get(label) === animation) animations.delete(label);
      },
      { once: true },
    );
  }
}

/**
 * How far the strip collapses: labels to icons, then the branch. The strip is measured when
 * it, a control group or a hosted control resizes, when its text or children
 * change, and when fonts load, which covers everything the widths depend on.
 */
function useStripCompaction(): readonly [
  attach: (element: HTMLDivElement | null) => (() => void) | undefined,
  compaction: ContextStripCompaction,
] {
  const [compaction, setCompaction] = useState<ContextStripCompaction>("none");

  const attach = (current: HTMLDivElement | null) => {
    if (!current) return;
    const labelAnimations = new Map<HTMLElement, Animation>();

    const measure = () => {
      // The committed attribute, not render state, so a stale closure cannot misread it.
      const compact = readStripCompaction(current);
      const stripWidth = current.clientWidth;
      if (stripWidth === 0) return;
      const stripStyle = getComputedStyle(current);
      const available =
        stripWidth -
        (Number.parseFloat(stripStyle.paddingInlineStart) || 0) -
        (Number.parseFloat(stripStyle.paddingInlineEnd) || 0);
      const contentWidth = (parent: Element): number => {
        const gap = Number.parseFloat(getComputedStyle(parent).columnGap) || 0;
        let width = 0;
        let counted = 0;
        for (const child of parent.children) {
          if (!(child instanceof HTMLElement)) continue;
          if (child.offsetWidth === 0) continue;
          const style = getComputedStyle(child);
          const position = style.position;
          if (position === "absolute" || position === "fixed") continue;
          width +=
            child.offsetWidth +
            (Number.parseFloat(style.marginInlineStart) || 0) +
            (Number.parseFloat(style.marginInlineEnd) || 0);
          counted += 1;
        }
        return width + gap * Math.max(0, counted - 1);
      };
      const stripGap = Number.parseFloat(stripStyle.columnGap) || 0;
      let needed = 0;
      let groups = 0;
      for (const child of current.children) {
        if (!(child instanceof HTMLElement)) continue;
        const controls = child.querySelector<HTMLElement>(RESTING_CONTROLS_SELECTOR);
        const controlsMeasurement = controls ? measureRestingComposerControls(controls) : null;
        if (controlsMeasurement) {
          child.style.minWidth = `${resolveRestingComposerControlsMinimumWidth(controlsMeasurement)}px`;
        }
        const width = controlsMeasurement
          ? resolveRestingComposerControlsNaturalWidth(controlsMeasurement)
          : contentWidth(child);
        if (width <= 1) continue;
        groups += 1;
        needed += width;
      }
      needed += stripGap * Math.max(0, groups - 1);
      const range = document.createRange();
      let labelsSavedWidth = 0;
      for (const label of current.querySelectorAll<HTMLElement>(COMPOSER_CONTEXT_LABEL_SELECTOR)) {
        const textWidth = labelTextWidth(label, range);
        needed += Math.max(0, textWidth - label.getBoundingClientRect().width);
        if (label.dataset.composerLabel === "hide") labelsSavedWidth += textWidth;
      }
      const nextCompaction = resolveContextStripCompaction({
        current: compact,
        neededWidth: needed,
        availableWidth: available,
        labelsSavedWidth,
      });
      if (nextCompaction === compact) return;
      const previousRects = new Map(
        Array.from(current.querySelectorAll<HTMLElement>(COMPOSER_CONTEXT_LABEL_SELECTOR)).map(
          (label) => [label, label.getBoundingClientRect()] as const,
        ),
      );
      flushSync(() => setCompaction(nextCompaction));
      animateLabelWidths(previousRects, labelAnimations);
    };

    let stopResize = () => {};
    const observeSizes = () => {
      stopResize();
      stopResize = observeResize(
        [
          current,
          ...Array.from(current.children),
          ...Array.from(current.querySelectorAll(COMPOSER_CONTEXT_LABEL_SELECTOR)),
        ],
        measure,
      );
    };
    observeSizes();
    // Text and control changes alter natural widths without resizing a hidden
    // or squeezed label, so they re-measure too. Only added or removed elements
    // can change the observed set; re-subscribing delivers a measure itself.
    const mutations = new MutationObserver((records) => {
      const elementsChanged = records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element),
      );
      if (elementsChanged) observeSizes();
      else measure();
    });
    mutations.observe(current, { childList: true, characterData: true, subtree: true });
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      stopResize();
      mutations.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
      for (const animation of labelAnimations.values()) animation.cancel();
    };
  };

  return [attach, compaction] as const;
}

export const BranchToolbar = memo(function BranchToolbar({
  layout = "composer",
  panelSection = "all",
  forceNewWorktree = false,
  ref,
  environmentId,
  threadId,
  projectId,
  worktreePath,
  isServerThread,
  showGitControls,
  draftId,
  onEnvModeChange,
  envMode,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
  trailing,
  afterBranch,
  environmentUnavailable = false,
  panelPrRowsContainer,
}: BranchToolbarProps) {
  const branchSelectorRef = useRef<BranchToolbarBranchSelectorHandle>(null);
  const threadRef = scopeThreadRef(environmentId, threadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  // The composer retains resolved thread details while bootstrap cleanup can remove its shell.
  const activeProjectRef = scopeProjectRef(environmentId, projectId);
  const activeProject = useProject(activeProjectRef);
  const activeWorktreePath = forceNewWorktree ? null : worktreePath;
  const effectiveEnvMode = forceNewWorktree ? "worktree" : envMode;
  const envModeLocked = envLocked || (isServerThread && activeWorktreePath !== null);

  const canUsePreviousWorktree = !isServerThread && !envModeLocked && !forceNewWorktree;
  const projectRefsForWorktreeLookup = canUsePreviousWorktree ? [activeProjectRef] : [];
  const projectThreads = useThreadShellsForProjectRefs(projectRefsForWorktreeLookup);
  const previousWorktreeSeed = canUsePreviousWorktree
    ? resolvePreviousWorktreeSeed({
        threads: projectThreads,
        currentWorktreePath: activeWorktreePath,
      })
    : null;
  const onUsePreviousWorktree = () => {
    if (!previousWorktreeSeed) return;
    setDraftThreadContext(draftId ?? threadRef, {
      branch: previousWorktreeSeed.branch,
      worktreePath: previousWorktreeSeed.worktreePath,
      envMode: "worktree",
      projectRef: activeProjectRef,
    });
  };

  useImperativeHandle(
    ref,
    () => ({
      openBranchPicker: () => branchSelectorRef.current?.open(),
      usePreviousWorktree: () => {
        if (!showGitControls || !canUsePreviousWorktree || !previousWorktreeSeed) return;
        onUsePreviousWorktree();
        onComposerFocusRequest?.();
      },
    }),
    [
      canUsePreviousWorktree,
      onComposerFocusRequest,
      onUsePreviousWorktree,
      previousWorktreeSeed,
      showGitControls,
    ],
  );

  const addTargets = useAddProjectTargets(activeProject, availableEnvironments);
  const onAddToMachine = (targetEnvironmentId: EnvironmentId | null) =>
    openAddProjectToMachine({ projectRef: activeProjectRef, targetEnvironmentId });
  // A project on one machine still gets the picker when it can be added to another.
  const hasMultipleEnvironments = (availableEnvironments?.length ?? 0) > 1 || addTargets.length > 0;
  const showEnvironmentPicker = hasMultipleEnvironments && onEnvironmentChange !== undefined;
  const activeEnvironmentOption =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  const [attachStrip, stripCompaction] = useStripCompaction();

  if (!activeProject) return null;

  if (layout === "panel") {
    return (
      <div className="flex w-full flex-col" data-thread-panel-run-context>
        {panelSection !== "branch" ? (
          <RunContextSelector
            displayMode="panel"
            workspaceRoot={activeProject.workspaceRoot}
            forceNewWorktree={forceNewWorktree}
            autoEnvironmentLabel={autoEnvironmentLabel}
            onAutoEnvironment={onAutoEnvironment}
            envLocked={envLocked}
            envModeLocked={envModeLocked}
            environmentId={environmentId}
            availableEnvironments={availableEnvironments}
            showEnvironmentPicker={showEnvironmentPicker}
            showEnvironmentIndicator={activeEnvironmentOption !== null}
            onEnvironmentChange={onEnvironmentChange}
            effectiveEnvMode={effectiveEnvMode}
            activeWorktreePath={activeWorktreePath}
            onEnvModeChange={onEnvModeChange}
            previousWorktreeLabel={
              previousWorktreeSeed ? resolvePreviousWorktreeLabel(previousWorktreeSeed) : null
            }
            previousWorktreeBranch={previousWorktreeSeed?.branch ?? null}
            onUsePreviousWorktree={onUsePreviousWorktree}
            addTargets={addTargets}
            onAddToMachine={onAddToMachine}
          />
        ) : null}
        {panelSection !== "workspace" ? (
          <BranchToolbarBranchSelector
            displayMode="panel"
            className="w-full"
            environmentId={environmentId}
            threadId={threadId}
            {...(draftId ? { draftId } : {})}
            envLocked={envLocked}
            effectiveEnvModeOverride={effectiveEnvMode}
            {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
            {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
            startFromOrigin={startFromOrigin}
            onStartFromOriginChange={onStartFromOriginChange}
            {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
            {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
            {...(panelPrRowsContainer !== undefined
              ? { prRowsContainer: panelPrRowsContainer }
              : {})}
          />
        ) : null}
      </div>
    );
  }

  // The primary environment is implicit until its connection needs attention. Without the
  // machine chip, the workspace menu lists Run on instead.
  const showMachineChip = activeEnvironmentOption?.isPrimary !== true || environmentUnavailable;
  const workspaceMenuProps = {
    showRunOn: !showMachineChip,
    forceNewWorktree,
    autoEnvironmentLabel,
    onAutoEnvironment,
    envLocked,
    envModeLocked,
    environmentId,
    availableEnvironments,
    showEnvironmentPicker,
    onEnvironmentChange,
    effectiveEnvMode,
    activeWorktreePath,
    onEnvModeChange,
    workspaceRoot: activeProject.workspaceRoot,
    previousWorktree: previousWorktreeSeed,
    onUsePreviousWorktree,
    addTargets,
    onAddToMachine,
  };
  const machineMenu = showMachineChip ? (
    <MachineMenu
      autoEnvironmentLabel={autoEnvironmentLabel}
      onAutoEnvironment={onAutoEnvironment}
      envLocked={envLocked}
      environmentId={environmentId}
      availableEnvironments={availableEnvironments}
      showEnvironmentPicker={showEnvironmentPicker}
      onEnvironmentChange={onEnvironmentChange}
      environmentUnavailable={environmentUnavailable}
      addTargets={addTargets}
      onAddToMachine={onAddToMachine}
    />
  ) : null;
  // Without Git the workspace chip stands alone, so the machine chip leads it here.
  const workspaceMenu = (
    <>
      {machineMenu}
      <WorkspaceMenu {...workspaceMenuProps} />
    </>
  );

  return (
    <ComposerSurface.ContextStrip
      ref={attachStrip}
      data-compact={stripCompaction === "none" ? undefined : stripCompaction}
      data-composer-context-control
    >
      {!showGitControls ? workspaceMenu : null}
      {showGitControls ? machineMenu : null}
      {showGitControls ? (
        <BranchToolbarBranchSelector
          forceNewWorktree={forceNewWorktree}
          ref={branchSelectorRef}
          className="min-w-0 flex-initial"
          renderWorkspaceMenu={(branch) => (
            <WorkspaceMenu {...workspaceMenuProps} branch={branch} />
          )}
          environmentId={environmentId}
          threadId={threadId}
          {...(draftId ? { draftId } : {})}
          envLocked={envLocked}
          effectiveEnvModeOverride={effectiveEnvMode}
          {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
          {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
          startFromOrigin={startFromOrigin}
          onStartFromOriginChange={onStartFromOriginChange}
          {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
          {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        />
      ) : null}
      {afterBranch}
      {trailing}
    </ComposerSurface.ContextStrip>
  );
});
