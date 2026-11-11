import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { FolderGit2Icon, FolderGitIcon, FolderIcon, GitBranchPlusIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent } from "react";
import { T, useGT, useMessages } from "gt-react";

import {
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  resolveWorkspaceModeLabel,
  WORKSPACE_MODES,
  type EnvMode,
  type WorkspaceMode,
} from "./BranchToolbar.logic";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { SharedTooltipTrigger } from "./ui/shared-tooltip";

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  workspaceMode: WorkspaceMode;
  activeWorktreePath: string | null;
  onWorkspaceModeChange: (mode: WorkspaceMode) => void;
  previousWorktreeLabel?: string | null;
  previousWorktreeBranch?: string | null;
  onUsePreviousWorktree?: () => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  workspaceMode,
  activeWorktreePath,
  onWorkspaceModeChange,
  previousWorktreeLabel,
  previousWorktreeBranch = null,
  onUsePreviousWorktree,
}: BranchToolbarEnvModeSelectorProps) {
  const gt = useGT();
  const m = useMessages();
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.workspace",
  );
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  const envModeItems = [
    ...WORKSPACE_MODES.map((entry) => ({ value: entry.mode, label: m(entry.label) })),
    ...(showPreviousWorktree && previousWorktreeLabel
      ? [{ value: PREVIOUS_WORKTREE_SELECT_VALUE, label: previousWorktreeLabel }]
      : []),
  ];

  const stopContextMenuMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0 || event.ctrlKey) {
      event.stopPropagation();
    }
  };

  if (envLocked || forceNewWorktree) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1.5 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-sm sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        {activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        <ComposerContextLabel>
          {forceNewWorktree
            ? resolveEnvModeLabel("worktree", m)
            : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode, m)}
        </ComposerContextLabel>
      </span>
    );

    return (
      <SharedTooltipTrigger
        render={lockedRow}
        label={
          forceNewWorktree
            ? gt("Each model starts in its own worktree.")
            : (activeWorktreePath ??
              resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode, m))
        }
      />
    );
  }

  return (
    <Select
      modal={false}
      value={workspaceMode}
      onValueChange={(value: string | null) => {
        if (value === PREVIOUS_WORKTREE_SELECT_VALUE) {
          onUsePreviousWorktree?.();
          return;
        }
        onWorkspaceModeChange(value as WorkspaceMode);
      }}
      items={envModeItems}
    >
      <SharedTooltipTrigger
        render={
          <ComposerSelectControl
            size="xs"
            className="min-w-0 shrink"
            aria-label={gt("Workspace")}
            data-composer-shortcut="composer.workspace"
            data-composer-context-control
            onMouseDownCapture={stopContextMenuMouseDown}
          />
        }
        label={
          <>
            {m(WORKSPACE_MODES.find((entry) => entry.mode === workspaceMode)!.description)}
            {shortcutLabel ? ` · ${shortcutLabel}` : null}
          </>
        }
      >
        <WorkspaceModeIcon mode={workspaceMode} />
        <ComposerContextLabel>
          <SelectValue />
        </ComposerContextLabel>
      </SharedTooltipTrigger>
      <SelectPopup
        alignItemWithTrigger={false}
        {...composerFloatingLayerProps}
        className="w-[min(21rem,calc(100vw-2rem))]"
      >
        <SelectGroup>
          <SelectGroupLabel>
            <T>Workspace</T>
          </SelectGroupLabel>
          {WORKSPACE_MODES.map((entry) => (
            <SelectItem key={entry.mode} value={entry.mode}>
              <WorkspaceModeItemContent mode={entry.mode} />
            </SelectItem>
          ))}
          {showPreviousWorktree && previousWorktreeLabel ? (
            <SelectItem value={PREVIOUS_WORKTREE_SELECT_VALUE}>
              <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});

function WorkspaceModeIcon({ mode }: { mode: WorkspaceMode }) {
  if (mode === "branch-off") return <GitBranchPlusIcon className="size-3" />;
  if (mode === "open") return <FolderGit2Icon className="size-3" />;
  return <FolderIcon className="size-3" />;
}

export function WorkspaceModeItemContent({ mode }: { mode: WorkspaceMode }) {
  const m = useMessages();
  return (
    <span className="flex items-start gap-1.5">
      <span className="pt-0.75">
        <WorkspaceModeIcon mode={mode} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span>{resolveWorkspaceModeLabel(mode, m)}</span>
        <span className="text-muted-foreground text-xs">
          {m(WORKSPACE_MODES.find((entry) => entry.mode === mode)!.description)}
        </span>
      </span>
    </span>
  );
}
