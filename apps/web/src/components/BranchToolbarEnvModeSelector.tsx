import type { ScopedThreadRef } from "@t3tools/contracts";
import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { FolderGit2Icon, FolderGitIcon, FolderIcon, GlobeIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent } from "react";
import { T, useGT, useMessages } from "gt-react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useOpenLink } from "../browser/useOpenLink";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { Badge } from "./ui/badge";
import { buildWorkspaceOptions, PREVIOUS_WORKTREE_OPTION } from "./workspaceOptions";
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
import { useInstanceLinkContextMenu } from "../orbit/useInstanceLinkContextMenu";

export function OrbitInstanceUrlChip({
  url,
  threadRef,
}: {
  url: string;
  threadRef: ScopedThreadRef;
}) {
  const openLink = useOpenLink(threadRef);
  const showLinkMenu = useInstanceLinkContextMenu(threadRef);
  const host = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="secondary"
            className="min-w-0 shrink font-normal"
            render={
              <a
                href={url}
                onClick={(event) => {
                  event.preventDefault();
                  void openLink(url, { event }).catch((error: unknown) => console.error(error));
                }}
                onContextMenu={(event) => showLinkMenu(event, url)}
              />
            }
          />
        }
      >
        <GlobeIcon />
        {/* A long domain must not push the other labels out; it collapses with them. */}
        <span
          data-composer-label
          className="min-w-0 max-w-40 group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-40 truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
          >
            {host}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipPopup>Open {url}</TooltipPopup>
    </Tooltip>
  );
}

interface BranchToolbarEnvModeSelectorProps {
  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel?: string | null;
  previousWorktreeBranch?: string | null;
  onUsePreviousWorktree?: () => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
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
  const options = buildWorkspaceOptions({
    activeWorktreePath,
    forceNewWorktree,
    previousWorktreeLabel: onUsePreviousWorktree ? (previousWorktreeLabel ?? null) : null,
    previousWorktreeBranch,
  });

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
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>
          {forceNewWorktree
            ? gt("Each model starts in its own worktree.")
            : (activeWorktreePath ??
              resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode, m))}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={effectiveEnvMode}
      onValueChange={(value: string | null) => {
        if (value === PREVIOUS_WORKTREE_OPTION) {
          onUsePreviousWorktree?.();
          return;
        }
        onEnvModeChange(value as EnvMode);
      }}
      items={options}
    >
      <Tooltip>
        <TooltipTrigger
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
        >
          {effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon className="size-3" />
          ) : activeWorktreePath ? (
            <FolderGitIcon className="size-3" />
          ) : (
            <FolderIcon className="size-3" />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {effectiveEnvMode === "worktree"
            ? resolveEnvModeLabel(effectiveEnvMode, m)
            : resolveCurrentWorkspaceLabel(activeWorktreePath, m)}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        {...composerFloatingLayerProps}
        className={options.length > 2 ? "w-[min(21rem,calc(100vw-2rem))]" : undefined}
      >
        <SelectGroup>
          <SelectGroupLabel>
            <T>Workspace</T>
          </SelectGroupLabel>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.content}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
