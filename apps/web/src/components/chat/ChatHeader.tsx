import {
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { EllipsisIcon, DiffIcon, TerminalSquareIcon, PlayIcon, FolderOpenIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import GitActionsControl from "../GitActionsControl";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator as MenuDivider, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { readNativeApi } from "~/nativeApi";

const HEADER_ACTIONS_COMPACT_BREAKPOINT_PX = 860;

interface ChatHeaderProps {
  activeThreadId: ThreadId;
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
  gitCwd: string | null;
  diffOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
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
  gitCwd,
  diffOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleDiff,
}: ChatHeaderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [useOverflowPopover, setUseOverflowPopover] = useState(false);
  const hasOverflowActions = activeProjectScripts !== undefined || activeProjectName !== undefined;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateLayout = (width: number) => {
      setUseOverflowPopover(width < HEADER_ACTIONS_COMPACT_BREAKPOINT_PX);
    };

    updateLayout(container.clientWidth);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateLayout(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="@container/header-actions flex min-w-0 flex-1 items-center gap-2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          <Badge variant="outline" className="min-w-0 shrink overflow-hidden">
            <span className="min-w-0 truncate">{activeProjectName}</span>
          </Badge>
        )}
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        {hasOverflowActions && useOverflowPopover ? (
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="outline" aria-label="More actions" />}
            >
              <EllipsisIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {activeProjectScripts && activeProjectScripts.length > 0 && (
                <>
                  <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                    Run script
                  </div>
                  {activeProjectScripts.slice(0, 5).map((script) => (
                    <MenuItem key={script.id} onClick={() => onRunProjectScript(script)}>
                      <PlayIcon className="size-4 shrink-0" />
                      {script.name}
                    </MenuItem>
                  ))}
                  {activeProjectScripts.length > 5 && (
                    <MenuItem disabled className="text-muted-foreground">
                      +{activeProjectScripts.length - 5} more
                    </MenuItem>
                  )}
                  <MenuDivider />
                </>
              )}
              {activeProjectName && (
                <>
                  <MenuItem
                    onClick={() => {
                      const api = readNativeApi();
                      if (!api || !openInCwd) return;
                      void api.shell.openInEditor(openInCwd, "file-manager");
                    }}
                  >
                    <FolderOpenIcon className="size-4 shrink-0" />
                    Open folder
                  </MenuItem>
                  <MenuDivider />
                  <GitActionsControl inMenu gitCwd={gitCwd} activeThreadId={activeThreadId} />
                </>
              )}
            </MenuPopup>
          </Menu>
        ) : null}
        {!useOverflowPopover && activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {!useOverflowPopover && activeProjectName && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {!useOverflowPopover && activeProjectName && (
          <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} />
        )}
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
                <TerminalSquareIcon className="size-3" />
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
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="outline"
                size="xs"
                disabled={!isGitRepo}
              >
                <DiffIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!isGitRepo
              ? "Diff panel is unavailable because this project is not a git repository."
              : diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
