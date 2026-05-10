import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@forma/contracts";
import type { RefObject } from "react";
import { memo } from "react";
import { type DraftId } from "~/composerDraftStore";
import { IconChevronRight as ChevronRightIcon, IconCube as CubeIcon } from "symbols-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { DesktopSidebarReopenButton } from "../sidebar/DesktopSidebarReopenButton";
import {
  ThreadBreadcrumbProjectChipContent,
  THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME,
  THREAD_BREADCRUMB_PROJECT_CHIP_INTERACTIVE_CLASS_NAME,
  THREAD_BREADCRUMB_SEPARATOR_ICON_CLASS_NAME,
} from "../ThreadBreadcrumb";
import { SidebarTrigger } from "../ui/sidebar";
import { HeaderIconActionButton } from "../HeaderIconActionButton";
import { SidebarPanelIcon } from "../icons/custom";
import { ChatHeaderActionsMenu } from "./ChatHeaderActionsMenu";
import { type GitActionsControlHandle } from "../GitActionsControl";

interface ChatHeaderProps {
  routeKind: "server" | "draft";
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
  gitActionsRef?: RefObject<GitActionsControlHandle | null> | undefined;
  availableEditors: ReadonlyArray<EditorId>;
  gitCwd: string | null;
  workspaceRoot: string | null;
  filesAvailable: boolean;
  filesOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onOpenProjectSwitcher: () => void;
  onToggleFiles: () => void;
  onCopyThreadAsMarkdown: () => void;
  onCopyWorkspacePath?: (() => void) | undefined;
  onCopyThreadId?: (() => void) | undefined;
  onForkThread?: (() => void) | undefined;
  onArchiveThread?: (() => void) | undefined;
  onDeleteThread?: (() => void) | undefined;
}

export const ChatHeader = memo(function ChatHeader({
  routeKind,
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
  gitActionsRef,
  availableEditors,
  gitCwd,
  workspaceRoot,
  filesAvailable,
  filesOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onOpenProjectSwitcher,
  onToggleFiles,
  onCopyThreadAsMarkdown,
  onCopyWorkspacePath,
  onCopyThreadId,
  onForkThread,
  onArchiveThread,
  onDeleteThread,
}: ChatHeaderProps) {
  return (
    <div className="@container/header-actions flex flex-1 items-center gap-2">
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
          <Badge variant="outline" className="text-ui-2xs shrink-0 text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <ChatHeaderActionsMenu
          routeKind={routeKind}
          activeThreadEnvironmentId={activeThreadEnvironmentId}
          activeThreadId={activeThreadId}
          {...(draftId ? { draftId } : {})}
          openInCwd={openInCwd}
          activeProjectScripts={activeProjectScripts}
          preferredScriptId={preferredScriptId}
          keybindings={keybindings}
          gitActionsRef={gitActionsRef}
          availableEditors={availableEditors}
          gitCwd={gitCwd}
          workspaceRoot={workspaceRoot}
          onRunProjectScript={onRunProjectScript}
          onAddProjectScript={onAddProjectScript}
          onUpdateProjectScript={onUpdateProjectScript}
          onDeleteProjectScript={onDeleteProjectScript}
          onCopyThreadAsMarkdown={onCopyThreadAsMarkdown}
          onCopyWorkspacePath={onCopyWorkspacePath}
          onCopyThreadId={onCopyThreadId}
          onForkThread={onForkThread}
          onArchiveThread={onArchiveThread}
          onDeleteThread={onDeleteThread}
        />
        {!filesOpen ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <HeaderIconActionButton
                  onClick={onToggleFiles}
                  aria-label="Toggle files panel"
                  disabled={!filesAvailable}
                >
                  <SidebarPanelIcon className="size-4 rotate-180" />
                </HeaderIconActionButton>
              }
            />
            <TooltipPopup side="bottom">
              {!filesAvailable
                ? "Files panel is unavailable until this thread has an active project."
                : "Toggle files panel"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
});
