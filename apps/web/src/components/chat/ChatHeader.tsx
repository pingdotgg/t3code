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
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { MobileActionBar } from "../mobile/MobileActionBar";
import { usePrimaryEnvironmentId } from "../../environments/primary";

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
  onRunProjectScript: (script: ProjectScript) => void;
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
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleDiff,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });

  return (
    <div className="@container/header-actions flex w-full min-w-0 flex-1 flex-col gap-2.5 max-md:gap-2 md:flex-row md:items-center md:gap-2">
      <div className="flex min-w-0 items-start gap-2 sm:items-center sm:gap-3 md:min-w-0 md:flex-1 md:overflow-hidden">
        <SidebarTrigger className="mt-0.5 size-7 shrink-0 sm:mt-0 md:hidden" />
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:gap-1.5 md:flex-row md:items-center md:gap-2">
          <h2
            className="min-w-0 truncate text-base font-semibold leading-snug tracking-tight text-foreground/95 md:text-sm md:font-medium md:text-foreground"
            title={activeThreadTitle}
          >
            {activeThreadTitle}
          </h2>
          {activeProjectName && (
            <div className="flex min-w-0 items-center gap-1.5 md:contents">
              {activeProjectName && (
                <Badge
                  variant="outline"
                  className="h-5 max-w-full shrink px-1.5 text-[10px] sm:h-auto sm:px-2 sm:text-xs"
                >
                  <span className="min-w-0 truncate">{activeProjectName}</span>
                </Badge>
              )}
              {activeProjectName && !isGitRepo && (
                <Badge
                  variant="outline"
                  className="h-5 shrink-0 px-1.5 text-[10px] text-amber-700 sm:h-auto sm:px-2"
                >
                  No Git
                </Badge>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Desktop action bar */}
      <div className="max-md:hidden flex min-w-0 shrink-0 items-center gap-1.5 overflow-x-auto rounded-lg border border-border/70 bg-muted/35 p-1 [-ms-overflow-style:none] [scrollbar-width:none] md:justify-end md:gap-2 md:overflow-visible md:rounded-none md:border-0 md:bg-transparent md:p-0 [&::-webkit-scrollbar]:hidden [&_[data-slot=group]]:shrink-0 [&_[data-slot=toggle]]:shrink-0 @3xl/header-actions:gap-3">
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
      </div>

      {/* Mobile action bar */}
      <div className="md:hidden">
        <MobileActionBar
          activeThreadEnvironmentId={activeThreadEnvironmentId}
          activeThreadId={activeThreadId}
          {...(draftId ? { draftId } : {})}
          activeProjectScripts={activeProjectScripts}
          preferredScriptId={preferredScriptId}
          keybindings={keybindings}
          onRunProjectScript={onRunProjectScript}
          onAddProjectScript={onAddProjectScript}
          onUpdateProjectScript={onUpdateProjectScript}
          onDeleteProjectScript={onDeleteProjectScript}
          activeProjectName={activeProjectName}
          gitCwd={gitCwd}
          isGitRepo={isGitRepo}
          terminalAvailable={terminalAvailable}
          terminalOpen={terminalOpen}
          terminalToggleShortcutLabel={terminalToggleShortcutLabel}
          onToggleTerminal={onToggleTerminal}
          diffOpen={diffOpen}
          diffToggleShortcutLabel={diffToggleShortcutLabel}
          onToggleDiff={onToggleDiff}
        />
      </div>
    </div>
  );
});
