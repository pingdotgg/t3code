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
import { DiffIcon, TerminalSquareIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type RunProjectScriptOptions,
} from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { TransferToBrowserButton } from "./TransferToBrowserButton";
import { BrowserAnnotationButton } from "./BrowserAnnotationButton";
import { isBrowserAgentSidebarMode, usePrimaryEnvironmentId } from "../../environments/primary";
import { shouldShowBrowserAgentControls } from "../../browserAgents";
import { topBarMainProjectScript } from "../../projectScripts";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  detectedDevServerUrl: string | null;
  preferredScriptId: string | null;
  runningProjectScriptIds: ReadonlySet<string>;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  onRunProjectScript: (script: ProjectScript, options?: RunProjectScriptOptions) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
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

export function shouldShowBrowserAnnotationButton(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly browserAgentSidebarMode: boolean;
}): boolean {
  return input.browserAgentSidebarMode && shouldShowBrowserAgentControls(input);
}

export function shouldShowTransferToBrowserButton(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly browserAgentSidebarMode: boolean;
  readonly mainActionRunning: boolean;
}): boolean {
  return (
    input.mainActionRunning &&
    !input.browserAgentSidebarMode &&
    shouldShowBrowserAgentControls(input)
  );
}

export function shouldShowProjectScriptsControl(input: {
  readonly activeProjectScripts: ProjectScript[] | undefined;
}): boolean {
  return input.activeProjectScripts !== undefined;
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
  detectedDevServerUrl,
  preferredScriptId,
  runningProjectScriptIds,
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
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const browserAgentSidebarMode = typeof window !== "undefined" && isBrowserAgentSidebarMode();
  const showProjectScriptsControl = shouldShowProjectScriptsControl({ activeProjectScripts });
  const mainProjectScript = activeProjectScripts
    ? topBarMainProjectScript(activeProjectScripts, preferredScriptId)
    : null;
  const mainProjectScriptRunning = mainProjectScript
    ? runningProjectScriptIds.has(mainProjectScript.id)
    : false;
  const showOpenInPicker =
    !browserAgentSidebarMode &&
    shouldShowOpenInPicker({
      activeProjectName,
      activeThreadEnvironmentId,
      primaryEnvironmentId,
    });
  const showTransferToBrowser = shouldShowTransferToBrowserButton({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
    browserAgentSidebarMode,
    mainActionRunning: mainProjectScriptRunning,
  });
  const showBrowserAnnotationButton = shouldShowBrowserAnnotationButton({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
    browserAgentSidebarMode,
  });
  const showGitActionsControl = Boolean(activeProjectName);
  const showTerminalToggle = !browserAgentSidebarMode;
  const showDiffToggle = !browserAgentSidebarMode;
  const showHeaderActions =
    showProjectScriptsControl ||
    showOpenInPicker ||
    showTransferToBrowser ||
    showBrowserAnnotationButton ||
    showGitActionsControl ||
    showTerminalToggle ||
    showDiffToggle;

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-wrap items-center gap-2 overflow-hidden sm:flex-1 sm:flex-nowrap sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <h2
          className="min-w-0 flex-1 basis-40 truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          <Badge
            variant="outline"
            className="min-w-0 max-w-full shrink overflow-hidden sm:max-w-56"
          >
            <span className="min-w-0 truncate">{activeProjectName}</span>
          </Badge>
        )}
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      {showHeaderActions && (
        <div className="flex min-w-0 flex-wrap items-center justify-start gap-2 sm:shrink-0 sm:justify-end @3xl/header-actions:gap-3">
          {showProjectScriptsControl && activeProjectScripts !== undefined && (
            <ProjectScriptsControl
              scripts={activeProjectScripts}
              keybindings={keybindings}
              preferredScriptId={preferredScriptId}
              runningScriptIds={runningProjectScriptIds}
              onRunScript={onRunProjectScript}
              onAddScript={onAddProjectScript}
              onUpdateScript={onUpdateProjectScript}
              onDeleteScript={onDeleteProjectScript}
            />
          )}
          {showOpenInPicker && (
            <OpenInPicker
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={openInCwd}
            />
          )}
          {showTransferToBrowser && (
            <TransferToBrowserButton
              activeProjectName={activeProjectName}
              activeProjectScripts={activeProjectScripts}
              activeThreadEnvironmentId={activeThreadEnvironmentId}
              activeThreadId={activeThreadId}
              detectedDevServerUrl={detectedDevServerUrl}
            />
          )}
          {showGitActionsControl && (
            <GitActionsControl
              gitCwd={gitCwd}
              activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
              {...(draftId ? { draftId } : {})}
            />
          )}
          {showBrowserAnnotationButton && (
            <BrowserAnnotationButton
              activeThreadEnvironmentId={activeThreadEnvironmentId}
              activeThreadId={activeThreadId}
            />
          )}
          {showTerminalToggle && (
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
          )}
          {showDiffToggle && (
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
          )}
        </div>
      )}
    </div>
  );
});
