import {
  type EditorId,
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { useNavigate } from "@tanstack/react-router";
import { memo, type RefObject } from "react";
import {
  IconCheckmark as CheckIcon,
  IconChevronDown as ChevronDownIcon,
  IconChevronRight as ChevronRightIcon,
  IconCube as CubeIcon,
  IconPlus as PlusIcon,
} from "symbols-react";

import { openCommandPalette } from "~/commandPaletteBus";
import type { DraftId } from "~/composerDraftStore";
import { useClientSettings } from "~/hooks/useSettings";
import { sortThreads } from "~/lib/threadSort";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";

import type { GitActionsControlHandle } from "../GitActionsControl";
import { HeaderIconActionButton } from "../HeaderIconActionButton";
import { SidebarPanelIcon } from "../icons/custom";
import type { NewProjectScriptInput, ProjectScriptActionResult } from "../ProjectScriptsControl";
import {
  ThreadBreadcrumbProjectChipContent,
  THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME,
  THREAD_BREADCRUMB_PROJECT_CHIP_INTERACTIVE_CLASS_NAME,
  THREAD_BREADCRUMB_SEPARATOR_ICON_CLASS_NAME,
} from "../ThreadBreadcrumb";
import { Badge } from "../ui/badge";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ChatHeaderActionsMenu } from "./ChatHeaderActionsMenu";

interface ChatHeaderProps {
  routeKind: "server" | "draft";
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectId: ProjectId | null;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  isGitRepo: boolean;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  workspaceRoot: string | null;
  gitActionsRef?: RefObject<GitActionsControlHandle | null> | undefined;
  onNewThreadInProject: () => void;
  onToggleRightPanel: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  onExportThread?: (() => void) | undefined;
  onCopyThreadAsMarkdown?: (() => void) | undefined;
  onCopyWorkspacePath?: (() => void) | undefined;
  onCopyThreadId?: (() => void) | undefined;
  onForkThread?: (() => void) | undefined;
  onArchiveThread?: (() => void) | undefined;
  onDeleteThread?: (() => void) | undefined;
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

export function selectHeaderThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  sortOrder: SidebarThreadSortOrder,
): ReadonlyArray<EnvironmentThreadShell> {
  return sortThreads(
    threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.environmentId === environmentId &&
        thread.projectId === projectId,
    ),
    sortOrder,
  );
}

export const ChatHeader = memo(function ChatHeader({
  routeKind,
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectId,
  activeProjectName,
  activeProjectCwd,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  isGitRepo,
  rightPanelAvailable,
  rightPanelOpen,
  gitCwd,
  workspaceRoot,
  gitActionsRef,
  onNewThreadInProject,
  onToggleRightPanel,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onExportThread,
  onCopyThreadAsMarkdown,
  onCopyWorkspacePath,
  onCopyThreadId,
  onForkThread,
  onArchiveThread,
  onDeleteThread,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenIn = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3 md:overflow-visible">
        {activeProjectName && activeProjectId ? (
          <nav
            aria-label="Thread breadcrumb"
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
          >
            <button
              type="button"
              aria-label="Switch project"
              aria-haspopup="dialog"
              onClick={() => openCommandPalette({ open: "switch-project" })}
              className={`${THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME} ${THREAD_BREADCRUMB_PROJECT_CHIP_INTERACTIVE_CLASS_NAME} h-6 shrink-0 text-sm`}
              title={activeProjectName}
            >
              <ThreadBreadcrumbProjectChipContent
                icon={<CubeIcon className="size-3 shrink-0 fill-current opacity-70" aria-hidden />}
                label={activeProjectName}
              />
            </button>
            <ChevronRightIcon className={THREAD_BREADCRUMB_SEPARATOR_ICON_CLASS_NAME} aria-hidden />
            <ThreadTitleMenu
              activeThreadEnvironmentId={activeThreadEnvironmentId}
              activeThreadId={activeThreadId}
              activeThreadTitle={activeThreadTitle}
              activeProjectId={activeProjectId}
              onNewThreadInProject={onNewThreadInProject}
            />
          </nav>
        ) : (
          <h2
            aria-label={activeThreadTitle}
            className="min-w-0 flex-1 truncate px-2 py-0.5 text-sm font-medium text-foreground"
            title={activeThreadTitle}
          >
            {activeThreadTitle}
          </h2>
        )}
        {activeProjectName && !isGitRepo ? (
          <Badge variant="outline" className="text-ui-2xs shrink-0 text-amber-700">
            No Git
          </Badge>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 [-webkit-app-region:no-drag]">
        <ChatHeaderActionsMenu
          routeKind={routeKind}
          activeThreadEnvironmentId={activeThreadEnvironmentId}
          activeThreadId={activeThreadId}
          {...(draftId ? { draftId } : {})}
          activeProjectCwd={activeProjectCwd}
          openInCwd={openInCwd}
          activeProjectScripts={activeProjectScripts}
          preferredScriptId={preferredScriptId}
          keybindings={keybindings}
          gitActionsRef={gitActionsRef}
          availableEditors={availableEditors}
          gitCwd={gitCwd}
          workspaceRoot={workspaceRoot}
          showOpenIn={showOpenIn}
          onRunProjectScript={onRunProjectScript}
          onAddProjectScript={onAddProjectScript}
          onUpdateProjectScript={onUpdateProjectScript}
          onDeleteProjectScript={onDeleteProjectScript}
          onExportThread={onExportThread}
          onCopyThreadAsMarkdown={onCopyThreadAsMarkdown}
          onCopyWorkspacePath={onCopyWorkspacePath}
          onCopyThreadId={onCopyThreadId}
          onForkThread={onForkThread}
          onArchiveThread={onArchiveThread}
          onDeleteThread={onDeleteThread}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <HeaderIconActionButton
                aria-label={rightPanelOpen ? "Close right panel" : "Open right panel"}
                pressed={rightPanelOpen}
                disabled={!rightPanelAvailable}
                onClick={onToggleRightPanel}
              />
            }
          >
            <SidebarPanelIcon className="size-4 rotate-180" aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {rightPanelAvailable
              ? rightPanelOpen
                ? "Close right panel"
                : "Open right panel"
              : "Right panel is unavailable until a project is open"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});

function ThreadTitleMenu({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  activeProjectId,
  onNewThreadInProject,
}: {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeProjectId: ProjectId;
  onNewThreadInProject: () => void;
}) {
  const navigate = useNavigate();
  const threadShells = useThreadShells();
  const threadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const visibleThreads = selectHeaderThreads(
    threadShells,
    activeThreadEnvironmentId,
    activeProjectId,
    threadSortOrder,
  );

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Switch thread"
            className="group flex min-w-0 shrink cursor-pointer items-center gap-2 rounded-md px-2 py-0.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            title={activeThreadTitle}
          />
        }
      >
        <span className="min-w-0 truncate">{activeThreadTitle}</span>
        <ChevronDownIcon className="size-2.5 shrink-0 fill-muted-foreground/60 transition-colors group-hover:fill-foreground/70" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-80 max-w-[calc(100vw-1rem)]">
        {visibleThreads.length > 0 ? (
          visibleThreads.map((thread) => {
            const isActive = thread.id === activeThreadId;
            return (
              <MenuItem
                key={`${thread.environmentId}:${thread.id}`}
                className={cn("grid grid-cols-[1rem_1fr] gap-2", isActive && "bg-accent/60")}
                onClick={() => {
                  if (isActive) return;
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
                  });
                }}
              >
                <span className="flex items-center justify-center">
                  {isActive ? <CheckIcon className="size-3 fill-current" /> : null}
                </span>
                <span className="min-w-0 truncate">{thread.title}</span>
              </MenuItem>
            );
          })
        ) : (
          <MenuItem disabled className="text-muted-foreground">
            No active threads
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem onClick={onNewThreadInProject}>
          <PlusIcon className="size-3.5" aria-hidden />
          New thread
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
