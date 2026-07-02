import {
  type EnvironmentId,
  type EditorId,
  type ExternalTerminalId,
  type OrchestrationThreadOrigin,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { CalendarClockIcon } from "lucide-react";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { OpenInTerminalPicker } from "./OpenInTerminalPicker";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeThreadOrigin?: OrchestrationThreadOrigin | null;
  activeProjectName: string | undefined;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  availableTerminals: ReadonlyArray<ExternalTerminalId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly openInCwd: string | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    Boolean(input.openInCwd) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeThreadOrigin,
  activeProjectName,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  availableTerminals,
  rightPanelOpen,
  gitCwd,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    openInCwd,
    primaryEnvironmentId,
  });
  const scheduledOrigin = activeThreadOrigin?.type === "scheduled-task" ? activeThreadOrigin : null;
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
        {scheduledOrigin ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label={`Scheduled task: ${scheduledOrigin.scheduledTaskTitle}`}
                  className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
                />
              }
            >
              <CalendarClockIcon className="size-3" />
              <span>Scheduled</span>
            </TooltipTrigger>
            <TooltipPopup side="top">
              Scheduled task: {scheduledOrigin.scheduledTaskTitle}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
          rightPanelOpen ? "pr-0" : "pr-16",
        )}
      >
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
        {showOpenInPicker && (
          <>
            <OpenInPicker
              environmentId={activeThreadEnvironmentId}
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={openInCwd}
            />
            <OpenInTerminalPicker
              environmentId={activeThreadEnvironmentId}
              availableTerminals={availableTerminals}
              openInCwd={openInCwd}
            />
          </>
        )}
        {activeProjectName && gitCwd && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
      </div>
    </div>
  );
});
