import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { memo, type RefObject } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  IconCheckmark as CheckIcon,
  IconChevronDown as ChevronDownIcon,
  IconChevronRight as ChevronRightIcon,
  IconEllipsis as EllipsisIcon,
  IconPlus as PlusIcon,
} from "symbols-react";
import GitActionsControl, { type GitActionsControlHandle } from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadShells } from "../../state/entities";
import { openCommandPalette } from "../../commandPaletteBus";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { useClientSettings } from "~/hooks/useSettings";
import { sortThreads } from "~/lib/threadSort";
import { ProjectFavicon } from "../ProjectFavicon";
import { HeaderIconActionButton } from "../HeaderIconActionButton";
import {
  ThreadBreadcrumbProjectChipContent,
  THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME,
  THREAD_BREADCRUMB_PROJECT_CHIP_INTERACTIVE_CLASS_NAME,
  THREAD_BREADCRUMB_SEPARATOR_ICON_CLASS_NAME,
} from "../ThreadBreadcrumb";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  gitActionsRef?: RefObject<GitActionsControlHandle | null> | undefined;
  onNewThreadInProject: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  onExportThread?: (() => void) | undefined;
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

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  activeProjectCwd,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  gitActionsRef,
  onNewThreadInProject,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onExportThread,
  onForkThread,
  onArchiveThread,
  onDeleteThread,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const fileScripts = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts ? activeProjectCwd : null,
  );
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. The chip doubles as the command palette's
            project-switcher trigger. */}
        {activeProjectName ? (
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
                icon={
                  <ProjectFavicon
                    environmentId={activeThreadEnvironmentId}
                    cwd={activeProjectCwd ?? ""}
                    className="size-3 shrink-0"
                  />
                }
                label={activeProjectName}
              />
            </button>
            <ChevronRightIcon className={THREAD_BREADCRUMB_SEPARATOR_ICON_CLASS_NAME} aria-hidden />
            <ThreadTitleMenu
              activeThreadEnvironmentId={activeThreadEnvironmentId}
              activeThreadId={activeThreadId}
              activeThreadTitle={activeThreadTitle}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <HeaderIconActionButton
                    aria-label={`New thread in ${activeProjectName}`}
                    onClick={onNewThreadInProject}
                    className="text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <PlusIcon className="size-3" aria-hidden />
              </TooltipTrigger>
              <TooltipPopup side="bottom">New thread in {activeProjectName}</TooltipPopup>
            </Tooltip>
          </nav>
        ) : (
          <ThreadTitleMenu
            activeThreadEnvironmentId={activeThreadEnvironmentId}
            activeThreadId={activeThreadId}
            activeThreadTitle={activeThreadTitle}
          />
        )}
      </div>
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2",
          rightPanelOpen ? "pr-0" : "pr-16",
        )}
      >
        {activeProjectScripts && (
          <ProjectScriptsControl
            compact
            scripts={activeProjectScripts}
            fileScripts={fileScripts}
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
            compact
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            ref={gitActionsRef}
            compact
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
        <Menu>
          <MenuTrigger
            render={
              <HeaderIconActionButton aria-label="More thread actions" title="More actions" />
            }
          >
            <EllipsisIcon className="size-3 rotate-90" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-52">
            <MenuGroup>
              <MenuGroupLabel>Thread</MenuGroupLabel>
              {onExportThread ? (
                <MenuItem onClick={onExportThread}>Export as Markdown</MenuItem>
              ) : null}
              {onForkThread ? <MenuItem onClick={onForkThread}>Fork thread</MenuItem> : null}
              {onArchiveThread ? <MenuItem onClick={onArchiveThread}>Archive</MenuItem> : null}
              {onDeleteThread ? (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={onDeleteThread} variant="destructive">
                    Delete
                  </MenuItem>
                </>
              ) : null}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
});

/**
 * Thread title rendered as a menu that switches between the active project's
 * threads. Draft threads (and threads not yet in the shell snapshot) fall
 * back to a plain heading since there is no sibling list to offer.
 */
function ThreadTitleMenu({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
}: {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
}) {
  const navigate = useNavigate();
  const threadShells = useThreadShells();
  const threadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const activeShell =
    threadShells.find(
      (thread) =>
        thread.environmentId === activeThreadEnvironmentId && thread.id === activeThreadId,
    ) ?? null;
  const visibleThreads = activeShell
    ? sortThreads(
        threadShells.filter(
          (thread) =>
            thread.archivedAt === null &&
            thread.environmentId === activeShell.environmentId &&
            thread.projectId === activeShell.projectId,
        ),
        threadSortOrder,
      )
    : [];

  if (!activeShell) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <h2
              aria-label={activeThreadTitle}
              className="min-w-0 shrink truncate px-2 py-0.5 text-sm font-medium text-foreground"
            >
              {activeThreadTitle}
            </h2>
          }
        />
        <TooltipPopup side="bottom">{activeThreadTitle}</TooltipPopup>
      </Tooltip>
    );
  }

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
                  if (!isActive) {
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(thread.environmentId, thread.id),
                      ),
                    });
                  }
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
      </MenuPopup>
    </Menu>
  );
}
