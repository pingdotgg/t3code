import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  resolveWorkspacePickerItems,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { ExistingWorktreeItemContent } from "./ExistingWorktreeItemContent";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

interface BranchToolbarEnvModeSelectorProps {
  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  workspaceItems: ReturnType<typeof resolveWorkspacePickerItems>;
  worktreesStatus?: string | null;
  onSelectWorktree?: ((path: string) => void) | undefined;
  onWorkspacePickerOpenChange?: (open: boolean) => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  workspaceItems,
  worktreesStatus,
  onSelectWorktree,
  onWorkspacePickerOpenChange,
}: BranchToolbarEnvModeSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.workspace",
  );
  const envModeItems = workspaceItems.map((item) => ({ value: item.value, label: item.label }));

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
            ? resolveEnvModeLabel("worktree")
            : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
        </ComposerContextLabel>
      </span>
    );

    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>
          {forceNewWorktree
            ? "Each model starts in its own worktree."
            : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={workspaceItems[0]?.value ?? effectiveEnvMode}
      onOpenChange={onWorkspacePickerOpenChange}
      onValueChange={(value: string | null) => {
        if (value?.startsWith("worktree:")) {
          onSelectWorktree?.(value.slice("worktree:".length));
          return;
        }
        if (value === "worktree") onEnvModeChange("worktree");
      }}
      items={envModeItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 shrink"
              aria-label="Workspace"
              data-composer-shortcut="composer.workspace"
              data-composer-context-control
              onMouseDownCapture={stopContextMenuMouseDown}
            />
          }
        >
          {activeWorktreePath ? (
            <FolderGitIcon className="size-3" />
          ) : effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon className="size-3" />
          ) : (
            <FolderIcon className="size-3" />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {effectiveEnvMode === "worktree"
            ? resolveEnvModeLabel("worktree")
            : resolveCurrentWorkspaceLabel(activeWorktreePath)}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        {...composerFloatingLayerProps}
        className="w-[min(21rem,calc(100vw-2rem))]"
      >
        <SelectGroup>
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          {workspaceItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.path ? (
                <ExistingWorktreeItemContent path={item.path} />
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <FolderGit2Icon className="size-3" />
                  {item.label}
                </span>
              )}
            </SelectItem>
          ))}
          {onSelectWorktree && worktreesStatus ? (
            <SelectGroupLabel>{worktreesStatus}</SelectGroupLabel>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
