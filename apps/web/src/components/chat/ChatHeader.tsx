import {
  type AuthSessionRole,
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo, useEffect, useState } from "react";
import GitActionsControl, { type GitPullRequestCommentsAction } from "../GitActionsControl";
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
import { PreviewButton } from "./PreviewButton";
import { BrowserAnnotationButton } from "./BrowserAnnotationButton";
import {
  fetchSessionState,
  isBrowserAgentSidebarMode,
  usePrimaryEnvironmentId,
} from "../../environments/primary";
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
  projectPreviewUrl: string | null | undefined;
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
  pullRequestCommentsAction?: GitPullRequestCommentsAction;
  onRunProjectScript: (script: ProjectScript, options?: RunProjectScriptOptions) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onUpdateProjectPreviewUrl: (previewUrl: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
  onSubmitGitPrompt: (prompt: string) => boolean | Promise<boolean>;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly currentSessionRole: AuthSessionRole | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.currentSessionRole === "owner" &&
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

export function shouldShowPreviewButton(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly browserAgentSidebarMode: boolean;
  readonly mainActionRunning: boolean;
  readonly projectPreviewUrl?: string | null | undefined;
}): boolean {
  return (
    (input.mainActionRunning || (input.projectPreviewUrl?.trim().length ?? 0) > 0) &&
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
  projectPreviewUrl,
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
  pullRequestCommentsAction,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onUpdateProjectPreviewUrl,
  onToggleTerminal,
  onToggleDiff,
  onSubmitGitPrompt,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [currentSessionRole, setCurrentSessionRole] = useState<AuthSessionRole | null>(() =>
    typeof window !== "undefined" && window.desktopBridge ? "owner" : null,
  );
  useEffect(() => {
    if (typeof window !== "undefined" && window.desktopBridge) {
      setCurrentSessionRole("owner");
      return;
    }

    let cancelled = false;
    void fetchSessionState()
      .then((session) => {
        if (cancelled) return;
        setCurrentSessionRole(session.authenticated ? (session.role ?? null) : null);
      })
      .catch(() => {
        if (cancelled) return;
        setCurrentSessionRole(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);
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
      currentSessionRole,
    });
  const showPreviewButton = shouldShowPreviewButton({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
    browserAgentSidebarMode,
    mainActionRunning: mainProjectScriptRunning,
    projectPreviewUrl,
  });
  const showBrowserAnnotationButton = shouldShowBrowserAnnotationButton({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
    browserAgentSidebarMode,
  });
  const showGitActionsControl = Boolean(activeProjectName);
  const showTerminalToggle = true;
  const showDiffToggle = !browserAgentSidebarMode;
  const showHeaderActions =
    showProjectScriptsControl ||
    showOpenInPicker ||
    showPreviewButton ||
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
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      {showHeaderActions && (
        <div className="flex min-w-0 flex-wrap items-center justify-start gap-2 sm:flex-1 sm:flex-nowrap @3xl/header-actions:gap-3">
          {showBrowserAnnotationButton && (
            <BrowserAnnotationButton
              activeThreadEnvironmentId={activeThreadEnvironmentId}
              activeThreadId={activeThreadId}
            />
          )}
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 sm:flex-nowrap @3xl/header-actions:gap-3">
            {showProjectScriptsControl && activeProjectScripts !== undefined && (
              <ProjectScriptsControl
                scripts={activeProjectScripts}
                keybindings={keybindings}
                preferredScriptId={preferredScriptId}
                runningScriptIds={runningProjectScriptIds}
                previewUrl={projectPreviewUrl}
                onRunScript={onRunProjectScript}
                onAddScript={onAddProjectScript}
                onUpdateScript={onUpdateProjectScript}
                onDeleteScript={onDeleteProjectScript}
                onUpdatePreviewUrl={onUpdateProjectPreviewUrl}
              />
            )}
            {showOpenInPicker && (
              <OpenInPicker
                keybindings={keybindings}
                availableEditors={availableEditors}
                openInCwd={openInCwd}
              />
            )}
            {showPreviewButton && (
              <PreviewButton
                activeProjectName={activeProjectName}
                activeProjectScripts={activeProjectScripts}
                projectPreviewUrl={projectPreviewUrl}
                activeThreadEnvironmentId={activeThreadEnvironmentId}
                activeThreadId={activeThreadId}
                detectedDevServerUrl={detectedDevServerUrl}
              />
            )}
            {showTerminalToggle && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Toggle
                      className={browserAgentSidebarMode ? "shrink-0 px-2" : "shrink-0"}
                      pressed={terminalOpen}
                      onPressedChange={onToggleTerminal}
                      aria-label={
                        browserAgentSidebarMode ? "Toggle CLI terminal" : "Toggle terminal drawer"
                      }
                      variant="outline"
                      size="xs"
                      disabled={!terminalAvailable}
                    >
                      <TerminalSquareIcon className="size-3" />
                      {browserAgentSidebarMode ? (
                        <span className="text-[10px] font-semibold uppercase leading-none">
                          CLI
                        </span>
                      ) : null}
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
            {showGitActionsControl && (
              <GitActionsControl
                gitCwd={gitCwd}
                activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
                onSubmitPrompt={onSubmitGitPrompt}
                {...(draftId ? { draftId } : {})}
                {...(pullRequestCommentsAction ? { pullRequestCommentsAction } : {})}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
});
