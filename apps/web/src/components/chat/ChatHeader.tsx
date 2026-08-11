import {
  type EnvironmentId,
  type EditorId,
  type GitResolvedPullRequest,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo, type ReactNode } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { FileDownIcon, LoaderIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { SidebarCollapsedTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  AgentWorkflowHeaderActions,
  type AgentWorkflowHeaderAction,
  type AgentWorkflowRunRequest,
} from "./AgentWorkflowHeaderActions";
import { WorkflowRunsButton, type WorkflowRunPresentation } from "./WorkflowRunSummary";

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
  exportingThread: boolean;
  exportThreadDisabledReason: string | null;
  gitCwd: string | null;
  workflowActions: ReadonlyArray<AgentWorkflowHeaderAction>;
  workflowRuns: ReadonlyArray<WorkflowRunPresentation>;
  onRunProjectScript: (script: ProjectScript) => void;
  onRunWorkflow: (request: AgentWorkflowRunRequest) => void;
  onListOpenPullRequests: () => Promise<ReadonlyArray<GitResolvedPullRequest>>;
  onPrewarmProviderSession: () => void;
  onPrewarmReviewPullRequest: (pullRequestNumber: number) => void;
  onNavigateThread: (threadId: ThreadId) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onExportThread: () => void;
  panelToggles?: ReactNode;
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
  exportingThread,
  exportThreadDisabledReason,
  gitCwd,
  workflowActions,
  workflowRuns,
  onRunProjectScript,
  onRunWorkflow,
  onListOpenPullRequests,
  onPrewarmProviderSession,
  onPrewarmReviewPullRequest,
  onNavigateThread,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onExportThread,
  panelToggles,
  paneActions,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteEnvironment =
    primaryEnvironmentId !== null && activeThreadEnvironmentId !== primaryEnvironmentId;

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarCollapsedTrigger className="no-drag size-6 shrink-0" />
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
        <AgentWorkflowHeaderActions
          actions={workflowActions}
          onRun={onRunWorkflow}
          onListOpenPullRequests={onListOpenPullRequests}
          onPrewarmProviderSession={onPrewarmProviderSession}
          onPrewarmReviewPullRequest={onPrewarmReviewPullRequest}
        />
        <WorkflowRunsButton runs={workflowRuns} onNavigateThread={onNavigateThread} />
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
        {panelToggles}
        {paneActions}
      </div>
    </div>
  );
});
