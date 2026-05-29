import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import {
  DiffIcon,
  DownloadIcon,
  EllipsisIcon,
  FolderTreeIcon,
  RefreshCwIcon,
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
import { stackedThreadToast, toastManager } from "../ui/toast";
import { exportTimelineResizeDiagnostics } from "./timelineResizeDiagnostics";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
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
  fileExplorerAvailable: boolean;
  fileExplorerOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleFileExplorer: () => void;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
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

export function forceRefreshApp(): void {
  const forceReload = window.desktopBridge?.forceReload;
  if (typeof forceReload === "function") {
    void forceReload().catch(() => {
      window.location.reload();
    });
    return;
  }

  window.location.reload();
}

function handleExportTimelineDiagnostics(): void {
  void exportTimelineResizeDiagnostics()
    .then((result) => {
      if (result === "empty") {
        toastManager.add({
          type: "warning",
          title: "No scroll diagnostics captured yet",
          description: "Scroll through the conversation, then export again.",
        });
        return;
      }
      toastManager.add({
        type: "success",
        title:
          result === "downloaded"
            ? "Scroll diagnostics downloaded"
            : result === "copied"
              ? "Scroll diagnostics copied to clipboard"
              : "Scroll diagnostics shared",
      });
    })
    .catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not export scroll diagnostics",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
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
  fileExplorerAvailable,
  fileExplorerOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleFileExplorer,
  onToggleTerminal,
  onToggleDiff,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isCompactHeader = useMediaQuery("(max-width: 760px)");
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
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
  const renderGitActionsControl = (inMenu = false) =>
    activeProjectName && gitCwd ? (
      <GitActionsControl
        gitCwd={gitCwd}
        activeThreadRef={activeThreadRef}
        inMenu={inMenu}
        {...(draftId ? { draftId } : {})}
      />
    ) : null;
  const hasProjectScriptsControl = activeProjectScripts !== undefined;
  const hasGitActionsControl = Boolean(activeProjectName && gitCwd);
  const showCompactOverflowActions =
    isCompactHeader && (hasProjectScriptsControl || hasGitActionsControl);

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
                  No Git
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
        {!isCompactHeader && renderGitActionsControl()}
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
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="outline" aria-label="More thread actions" />}
          >
            <EllipsisIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom" className="min-w-48">
            {showCompactOverflowActions && hasProjectScriptsControl
              ? renderProjectScriptsControl(true)
              : null}
            {showCompactOverflowActions && hasGitActionsControl
              ? renderGitActionsControl(true)
              : null}
            {showCompactOverflowActions && (hasProjectScriptsControl || hasGitActionsControl) ? (
              <MenuSeparator />
            ) : null}
            <MenuItem onClick={forceRefreshApp}>
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              Force refresh
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={handleExportTimelineDiagnostics}>
              <DownloadIcon aria-hidden="true" className="size-4" />
              Export scroll diagnostics
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
});
