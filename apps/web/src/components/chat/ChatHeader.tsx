import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { CornerLeftUpIcon } from "lucide-react";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useHostDisplayPreferences } from "../../hostDisplayPreferences";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  onOpenParentThread?: (() => void) | undefined;
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

export function shouldRenderOpenInPicker(input: {
  readonly hostShowOpenInPicker: boolean;
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return input.hostShowOpenInPicker && shouldShowOpenInPicker(input);
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onOpenParentThread,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const hostDisplayPreferences = useHostDisplayPreferences();

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-wrap items-center gap-2 overflow-hidden sm:flex-1 sm:flex-nowrap sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <div className="flex min-w-0 flex-1 basis-40 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <h2
                  aria-label={activeThreadTitle}
                  className="min-w-0 shrink truncate text-sm font-medium text-foreground"
                >
                  {activeThreadTitle}
                </h2>
              }
            />
            <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
          </Tooltip>
          {onOpenParentThread && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="outline"
                    className="shrink-0"
                    aria-label="Open parent conversation"
                    onClick={onOpenParentThread}
                  />
                }
              >
                <CornerLeftUpIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Open parent conversation</TooltipPopup>
            </Tooltip>
          )}
          <span className="min-w-0 flex-1" aria-hidden="true" />
        </div>
      </div>
      <div
        data-chat-header-actions
        className={cn(
          "flex min-w-0 flex-wrap items-center justify-start gap-2 sm:shrink-0 sm:justify-end @3xl/header-actions:gap-3",
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
        {shouldRenderOpenInPicker({
          hostShowOpenInPicker: hostDisplayPreferences.showOpenInPicker,
          activeProjectName,
          activeThreadEnvironmentId,
          primaryEnvironmentId,
        }) && (
          <OpenInPicker
            environmentId={activeThreadEnvironmentId}
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
      </div>
    </div>
  );
});
