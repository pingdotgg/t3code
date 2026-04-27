import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@forma/contracts";
import { scopeThreadRef } from "@forma/client-runtime";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import {
  IconChevronRight as ChevronRightIcon,
  IconCube as CubeIcon,
  IconPlusminus as DiffIcon,
} from "symbols-react";
import { TerminalToggleIcon } from "../icons/custom";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { DesktopSidebarReopenButton } from "../sidebar/DesktopSidebarReopenButton";
import {
  ThreadBreadcrumbProjectChipContent,
  THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME,
  THREAD_BREADCRUMB_PROJECT_CHIP_INTERACTIVE_CLASS_NAME,
  THREAD_BREADCRUMB_SEPARATOR_ICON_CLASS_NAME,
} from "../ThreadBreadcrumb";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";

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
  onOpenProjectSwitcher: () => void;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
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
  onOpenProjectSwitcher,
  onToggleTerminal,
  onToggleDiff,
}: ChatHeaderProps) {
  return (
    <div className="@container/header-actions flex min-h-4 min-w-0 flex-1 items-center gap-2 sm:min-h-4 h-4">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden md:overflow-visible sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <DesktopSidebarReopenButton />
        {activeProjectName ? (
          <nav
            aria-label="Thread breadcrumb"
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
          >
            <button
              type="button"
              aria-label="Switch project"
              aria-haspopup="dialog"
              onClick={onOpenProjectSwitcher}
              className={`${THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME} ${THREAD_BREADCRUMB_PROJECT_CHIP_INTERACTIVE_CLASS_NAME} text-sm`}
              title={activeProjectName}
            >
              <ThreadBreadcrumbProjectChipContent
                icon={<CubeIcon className="size-3 shrink-0 fill-current opacity-70" aria-hidden />}
                label={activeProjectName}
              />
            </button>
            <ChevronRightIcon className={THREAD_BREADCRUMB_SEPARATOR_ICON_CLASS_NAME} aria-hidden />
            <h2
              className="min-w-0 shrink truncate text-sm font-medium text-foreground"
              title={activeThreadTitle}
            >
              {activeThreadTitle}
            </h2>
          </nav>
        ) : (
          <h2
            className="min-w-0 shrink truncate text-sm font-medium text-foreground"
            title={activeThreadTitle}
          >
            {activeThreadTitle}
          </h2>
        )}
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">
        {activeProjectScripts && (
          <ProjectScriptsControl
            compact
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {activeProjectName && (
          <OpenInPicker
            compact
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            compact
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 [&_svg]:fill-current"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="outline"
                size="xs"
                disabled={!terminalAvailable}
              >
                <TerminalToggleIcon className="size-3" />
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
                className="shrink-0 [&_svg]:fill-current"
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="outline"
                size="xs"
                disabled={!isGitRepo}
              >
                <DiffIcon className="size-3 fill-current" />
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
