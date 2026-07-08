import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo, type ReactNode } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { DiffIcon, FileDownIcon, GlobeIcon, LoaderIcon, TerminalSquareIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  AgentWorkflowHeaderActions,
  type AgentWorkflowHeaderAction,
  type AgentWorkflowRunRequest,
} from "./AgentWorkflowHeaderActions";

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
  browserPreviewOpen: boolean;
  exportingThread: boolean;
  exportThreadDisabledReason: string | null;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  workflowActions: ReadonlyArray<AgentWorkflowHeaderAction>;
  onRunProjectScript: (script: ProjectScript) => void;
  onRunWorkflow: (request: AgentWorkflowRunRequest) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onExportThread: () => void;
  onToggleTerminal: () => void;
  onToggleBrowserPreview: () => void;
  onToggleDiff: () => void;
  paneActions?: ReactNode;
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
  browserPreviewOpen,
  exportingThread,
  exportThreadDisabledReason,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  gitCwd,
  diffOpen,
  workflowActions,
  onRunProjectScript,
  onRunWorkflow,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onExportThread,
  onToggleTerminal,
  onToggleBrowserPreview,
  onToggleDiff,
  paneActions,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteEnvironment =
    primaryEnvironmentId !== null && activeThreadEnvironmentId !== primaryEnvironmentId;

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <h2
          className="min-w-0 shrink truncate font-medium text-foreground"
          style={{ fontSize: "var(--app-chat-font-size)" }}
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
      <div className="flex shrink-0 items-center justify-end gap-1">
        {activeProjectScripts && (
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
        {activeProjectName && !isRemoteEnvironment && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
        <AgentWorkflowHeaderActions actions={workflowActions} onRun={onRunWorkflow} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                className="shrink-0 border-transparent shadow-none hover:border-input hover:shadow-xs/5"
                variant="outline"
                size="icon-xs"
                onClick={onExportThread}
                aria-label="Export chat"
                disabled={exportingThread || exportThreadDisabledReason !== null}
              >
                {exportingThread ? (
                  <LoaderIcon className="size-3 animate-spin" />
                ) : (
                  <FileDownIcon className="size-3" />
                )}
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            {exportThreadDisabledReason ?? (exportingThread ? "Exporting chat..." : "Export chat")}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 border-transparent shadow-none hover:border-input hover:shadow-xs/5"
                pressed={browserPreviewOpen}
                onPressedChange={onToggleBrowserPreview}
                aria-label="Toggle browser preview"
                variant="outline"
                size="xs"
              >
                <GlobeIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">Toggle browser preview</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 border-transparent shadow-none hover:border-input hover:shadow-xs/5"
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
                className="shrink-0 border-transparent shadow-none hover:border-input hover:shadow-xs/5"
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
        {paneActions}
      </div>
    </div>
  );
});
