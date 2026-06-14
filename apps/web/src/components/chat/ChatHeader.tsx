import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo } from "react";
import {
  DiffIcon,
  EllipsisIcon,
  FolderTreeIcon,
  GitBranchIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Button } from "../ui/button";
import { useMediaQuery } from "../../hooks/useMediaQuery";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  sourceControlToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  sourceControlOpen: boolean;
  fileExplorerAvailable: boolean;
  fileExplorerOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleFileExplorer: () => void;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
  onToggleSourceControl: () => void;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadTitle,
  activeProjectName,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  sourceControlToggleShortcutLabel,
  gitCwd,
  diffOpen,
  sourceControlOpen,
  fileExplorerAvailable,
  fileExplorerOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleFileExplorer,
  onToggleTerminal,
  onToggleDiff,
  onToggleSourceControl,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isCompactHeader = useMediaQuery("(max-width: 760px)");
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const isRemoteThread =
    primaryEnvironmentId !== null && activeThreadEnvironmentId !== primaryEnvironmentId;
  const remoteEnvRuntimeLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[activeThreadEnvironmentId]?.descriptor?.label ?? null,
  );
  const remoteEnvSavedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[activeThreadEnvironmentId]?.label ?? null,
  );
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvRuntimeLabel ?? remoteEnvSavedLabel ?? "Remote")
    : null;
  const renderProjectScriptsControl = (inMenu = false) =>
    activeProjectScripts ? (
      <ProjectScriptsControl
        scripts={activeProjectScripts}
        keybindings={keybindings}
        preferredScriptId={preferredScriptId}
        inMenu={inMenu}
        onRunScript={onRunProjectScript}
        onAddScript={onAddProjectScript}
        onUpdateScript={onUpdateProjectScript}
        onDeleteScript={onDeleteProjectScript}
      />
    ) : null;
  const hasProjectScriptsControl = activeProjectScripts !== undefined;
  const hasSourceControl = Boolean(activeProjectName && gitCwd);
  const showCompactOverflowActions = isCompactHeader && hasProjectScriptsControl;

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <div className="flex min-w-0 flex-col justify-center">
          <h2
            className="min-w-0 truncate text-sm font-medium leading-tight text-foreground"
            title={activeThreadTitle}
          >
            {activeThreadTitle}
          </h2>
          {(activeProjectName || threadEnvironmentLabel) && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-tight text-muted-foreground">
              {activeProjectName && (
                <span className="min-w-0 truncate" title={activeProjectName}>
                  {activeProjectName}
                </span>
              )}
              {activeProjectName && threadEnvironmentLabel && (
                <span aria-hidden className="shrink-0 text-muted-foreground/50">
                  •
                </span>
              )}
              {threadEnvironmentLabel && (
                <span className="min-w-0 shrink truncate" title={threadEnvironmentLabel}>
                  {threadEnvironmentLabel}
                </span>
              )}
              {activeProjectName && !isGitRepo && (
                <Badge
                  variant="outline"
                  className="ml-0.5 shrink-0 px-1 py-0 text-[10px] text-amber-700"
                >
                  Git not present
                </Badge>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1.5 @3xl/header-actions:gap-3">
        {!isCompactHeader && renderProjectScriptsControl()}
        {!isCompactHeader && showOpenInPicker && (
          <>
            <OpenInPicker
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={openInCwd}
            />
          </>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={sourceControlOpen}
                onPressedChange={onToggleSourceControl}
                aria-label="Toggle source control"
                variant="outline"
                size="xs"
                disabled={!hasSourceControl}
              >
                <GitBranchIcon className="size-4.5 sm:size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {hasSourceControl
              ? sourceControlToggleShortcutLabel
                ? `Toggle source control (${sourceControlToggleShortcutLabel})`
                : "Toggle source control"
              : "Source control is unavailable until this thread has an active project."}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="outline"
                size="xs"
                disabled={!terminalAvailable}
              >
                <TerminalSquareIcon className="size-4.5 sm:size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!terminalAvailable
              ? "Terminal is unavailable until this thread has an active project."
              : terminalToggleShortcutLabel
                ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                : "Toggle terminal drawer"}
          </TooltipPopup>
        </Tooltip>
        {!isCompactHeader && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={fileExplorerOpen}
                  onPressedChange={onToggleFileExplorer}
                  aria-label="Toggle file explorer"
                  variant="outline"
                  size="xs"
                  disabled={!fileExplorerAvailable}
                >
                  <FolderTreeIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {fileExplorerAvailable
                ? "Toggle file explorer"
                : "File explorer is unavailable until this thread has an active project."}
            </TooltipPopup>
          </Tooltip>
        )}
        {!isCompactHeader && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={diffOpen}
                  onPressedChange={onToggleDiff}
                  aria-label="Toggle diff panel"
                  variant="ghost"
                  size="xs"
                  disabled={!isGitRepo && !diffOpen}
                >
                  <DiffIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {!isGitRepo && !diffOpen
                ? "Diff panel is unavailable because this project is not a git repository."
                : diffToggleShortcutLabel
                  ? `Toggle diff panel (${diffToggleShortcutLabel})`
                  : "Toggle diff panel"}
            </TooltipPopup>
          </Tooltip>
        )}
        {isCompactHeader ? (
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="outline" aria-label="More thread actions" />}
            >
              <EllipsisIcon className="size-4.5 sm:size-4" />
            </MenuTrigger>
            <MenuPopup align="end" side="bottom" className="min-w-48">
              <MenuItem onClick={() => onToggleDiff()} disabled={!isGitRepo && !diffOpen}>
                <DiffIcon aria-hidden="true" className="size-4" />
                Diff
              </MenuItem>
              <MenuItem onClick={() => onToggleFileExplorer()} disabled={!fileExplorerAvailable}>
                <FolderTreeIcon aria-hidden="true" className="size-4" />
                File explorer
              </MenuItem>
              {showCompactOverflowActions ? <MenuSeparator /> : null}
              {showCompactOverflowActions && hasProjectScriptsControl
                ? renderProjectScriptsControl(true)
                : null}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
    </div>
  );
});
