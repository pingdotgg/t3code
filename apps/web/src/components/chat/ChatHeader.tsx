import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { PlusIcon, SquarePenIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { canShareWithGuestAtom } from "./guestShareAvailability";
import { useAtomValue } from "@effect/atom-react";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { ProjectFavicon } from "../ProjectFavicon";
import { PANE_TAB_CLASS, PaneNotch, PaneTabButton } from "../PaneNotch";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { GuestShareIndicator } from "./GuestShareControls";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeThreadLinkOrigin?: string | null | undefined;
  isServerThread: boolean;
  activeProject: EnvironmentProject | null;
  parentThreadLink: { threadId: ThreadId; title: string } | null;
  onOpenThread: (threadId: ThreadId) => void;
  rightPanelOpen: boolean;
  onNewThreadInProject: () => void;
  onOpenProjectSettings?: (() => void) | undefined;
  onFindInThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
}

function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

// Delay the input-swallowing native menu through the double-click rename interval.
const TITLE_MENU_OPEN_DELAY_MS = 500;
export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  activeThreadLinkOrigin,
  isServerThread,
  activeProject,
  parentThreadLink,
  onOpenThread,
  rightPanelOpen,
  onNewThreadInProject,
  onOpenProjectSettings,
  onFindInThread,
}: ChatHeaderProps) {
  const activeProjectName = activeProject?.isScratch ? "No project" : activeProject?.title;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const canOperateThread = useEnvironmentScope(
    activeThreadEnvironmentId,
    AuthOrchestrationOperateScope,
  );
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(activeThreadEnvironmentId));
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId ||
      renaming.environmentId !== activeThreadEnvironmentId ||
      !canOperateThread)
  ) {
    setRenaming(null);
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (
      !isServerThread ||
      !readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)
    )
      return;
    renameCommittedRef.current = false;
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  };
  const commitRename = (title: string) => {
    setRenaming(null);
    if (!readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)) return;
    const resolution = resolveRenameCommit({
      title,
      originalTitle: renamingTitle ?? activeThreadTitle,
    });
    if (resolution.action === "reject-empty") {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (resolution.action === "noop") return;
    void updateThreadMetadata({
      environmentId: activeThreadEnvironmentId,
      input: { threadId: activeThreadId, title: resolution.title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    });
  };
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    onStartRename: startRename,
    onFind: onFindInThread,
    canShareWithGuest,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = () => {
    if (titleMenuTimerRef.current === null) return;
    clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the pending title-menu timer when the thread switches or the header unmounts
  useEffect(
    () => () => {
      if (titleMenuTimerRef.current === null) return;
      clearTimeout(titleMenuTimerRef.current);
      titleMenuTimerRef.current = null;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A pending title menu belongs to the thread that was clicked, so switching threads drops it.
    [activeThreadEnvironmentId, activeThreadId],
  );
  const openTitleMenuNow = () => {
    cancelPendingTitleMenu();
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const openMenuFromTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    // Keyboard activation can never be the first half of a double-click, so
    // it opens without waiting.
    if (event.detail === 0 || window.desktopBridge === undefined) {
      openTitleMenuNow();
      return;
    }
    cancelPendingTitleMenu();
    titleMenuTimerRef.current = window.setTimeout(() => {
      titleMenuTimerRef.current = null;
      openTitleMenuNow();
    }, TITLE_MENU_OPEN_DELAY_MS);
  };
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    cancelPendingTitleMenu();
    closeMenu();
    startRename();
  };
  const handleHeaderContextMenu = (event: ReactMouseEvent) => {
    if (renamingTitle !== null) return;
    if (!isServerThread && onOpenProjectSettings === undefined) return;
    cancelPendingTitleMenu();
    event.preventDefault();
    if (!isServerThread) {
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show([{ id: "project-settings", label: "Project settings", icon: "settings" }], {
          x: event.clientX,
          y: event.clientY,
        })
        .then((action) => {
          if (action === "project-settings") onOpenProjectSettings?.();
        });
      return;
    }
    openMenu({ x: event.clientX, y: event.clientY });
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      renameCommittedRef.current = true;
      setRenaming(null);
    }
  };
  const tabIcon = isServerThread ? (
    activeProject ? (
      <ProjectFavicon project={activeProject} className="size-3.5" />
    ) : null
  ) : (
    <SquarePenIcon aria-hidden className="size-3.5 shrink-0 text-foreground" />
  );
  // The project name left the header with the breadcrumb; the tab's tooltip
  // keeps it, in the breadcrumb's old order.
  const tabTooltip = activeProjectName
    ? `${activeProjectName} / ${activeThreadTitle}`
    : activeThreadTitle;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center self-stretch",
        rightPanelOpen ? "pr-10" : "pr-24",
      )}
      onContextMenu={handleHeaderContextMenu}
    >
      <PaneNotch>
        {parentThreadLink ? (
          <ParentThreadTab link={parentThreadLink} onOpenThread={onOpenThread} />
        ) : null}
        {renamingTitle !== null ? (
          <div
            className={cn(
              PANE_TAB_CLASS,
              "inset-ring inset-ring-ring/50 focus-within:inset-ring-ring",
            )}
          >
            {tabIcon}
            <input
              autoFocus
              dir="auto"
              aria-label="Thread title"
              className="min-w-24 max-w-full bg-transparent outline-none [field-sizing:content]"
              defaultValue={renamingTitle}
              onBlur={(event) => {
                if (renameCommittedRef.current) return;
                if (
                  event.relatedTarget instanceof HTMLElement &&
                  event.relatedTarget.closest("button")
                ) {
                  setRenaming(null);
                  return;
                }
                commitRename(event.currentTarget.value);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleRenameKeyDown}
            />
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                isServerThread ? (
                  <PaneTabButton
                    ref={titleButtonRef}
                    type="button"
                    aria-label={`Thread actions for ${activeThreadTitle}`}
                    aria-haspopup="menu"
                    onClick={openMenuFromTitle}
                    onDoubleClick={canOperateThread ? handleTitleDoubleClick : undefined}
                    onBlur={cancelPendingTitleMenu}
                  />
                ) : (
                  <div className={PANE_TAB_CLASS} />
                )
              }
            >
              {tabIcon}
              <h2 className="min-w-0 truncate" dir={textDirection(activeThreadTitle)}>
                {activeThreadTitle}
              </h2>
            </TooltipTrigger>
            <TooltipPopup side="bottom">{tabTooltip}</TooltipPopup>
          </Tooltip>
        )}
        {activeProject ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="bare"
                  size="icon-xs"
                  data-pane-notch-add=""
                  aria-label={`New thread in ${activeProjectName}`}
                  onClick={onNewThreadInProject}
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">New thread in {activeProjectName}</TooltipPopup>
          </Tooltip>
        ) : null}
        {renamingTitle === null && activeThreadLinkOrigin ? (
          <Tooltip>
            <TooltipTrigger render={<Badge variant="info" size="sm" />}>
              From {activeThreadLinkOrigin}
            </TooltipTrigger>
            <TooltipPopup side="top">
              Started by an agent on {activeThreadLinkOrigin} through a linked environment.
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </PaneNotch>
      {isServerThread ? <GuestShareIndicator threadRef={activeThreadRef} /> : null}
    </div>
  );
});

/**
 * A subagent thread's way back to its parent: a muted notch control ahead of
 * the thread's own tab.
 */
function ParentThreadTab({
  link,
  onOpenThread,
}: {
  readonly link: { threadId: ThreadId; title: string };
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="sm"
            aria-label={`Open parent thread: ${link.title}`}
            onClick={() => onOpenThread(link.threadId)}
            className="min-w-0 max-w-40 shrink [-webkit-app-region:no-drag]"
          />
        }
      >
        <span className="min-w-0 truncate">{link.title}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{link.title}</TooltipPopup>
    </Tooltip>
  );
}
