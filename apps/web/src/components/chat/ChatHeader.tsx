import {
  type EnvironmentId,
  type EditorId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { useRemoteOpenState, type RemoteOpenMode } from "../../remoteOpen";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadTitle: string;
  /** Drafts have no server thread yet, so the title carries no action menu. */
  isServerThread: boolean;
  /** PR state feeding the settled classification, resolved by ChatView. */
  changeRequestState: ChangeRequestStateLike | null;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  activeProjectFaviconPath: string | null;
  openInCwd: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
}

/**
 * Rename commit rule shared with the sidebar's inline rename: trim, reject
 * empty (the caller toasts), and skip the mutation when nothing changed.
 */
export function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly remoteOpenMode: RemoteOpenMode;
}): boolean {
  if (!input.activeProjectName) return false;
  if (
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  ) {
    return true;
  }
  // Remote environments get the picker in deep-link mode (or its explicit
  // "no SSH route" state). Non-primary local backends (e.g. WSL) keep it
  // hidden, matching pre-remote behavior.
  return input.remoteOpenMode !== "local-exec";
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadTitle,
  isServerThread,
  changeRequestState,
  activeProjectName,
  activeProjectCwd,
  activeProjectFaviconPath,
  openInCwd,
  keybindings,
  availableEditors,
  rightPanelOpen,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const fileScripts = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts ? activeProjectCwd : null,
  );
  const remoteOpenState = useRemoteOpenState(activeThreadEnvironmentId);
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
    remoteOpenMode: remoteOpenState.mode,
  });
  const activeThreadRef = useMemo(
    () => scopeThreadRef(activeThreadEnvironmentId, activeThreadId),
    [activeThreadEnvironmentId, activeThreadId],
  );
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  // Inline rename, keyed by thread: navigating away drops an in-progress
  // rename instead of committing stale text. Cleared on thread change (not
  // just hidden) so returning to the thread doesn't revive the old draft.
  const [renaming, setRenaming] = useState<{ threadId: ThreadId; title: string } | null>(null);
  if (renaming !== null && renaming.threadId !== activeThreadId) {
    setRenaming(null);
  }
  const renamingTitle = renaming?.threadId === activeThreadId ? renaming.title : null;
  const renameCommittedRef = useRef(false);
  const startRename = useCallback(() => {
    renameCommittedRef.current = false;
    setRenaming({ threadId: activeThreadId, title: activeThreadTitle });
  }, [activeThreadId, activeThreadTitle]);
  const commitRename = useCallback(
    (title: string) => {
      setRenaming(null);
      const resolution = resolveRenameCommit({ title, originalTitle: activeThreadTitle });
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
    },
    [activeThreadEnvironmentId, activeThreadId, activeThreadTitle, updateThreadMetadata],
  );
  const { openMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    changeRequestState,
    onStartRename: startRename,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const openMenuFromTitle = useCallback(() => {
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  }, [openMenu]);
  const handleHeaderContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (renamingTitle !== null) return;
      // The right-side controls (git, scripts, open-in) keep their own
      // behavior; only the breadcrumb area opens the thread menu.
      if ((event.target as HTMLElement).closest("[data-chat-header-actions]")) return;
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
    },
    [isServerThread, openMenu, renamingTitle],
  );
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        renameCommittedRef.current = true;
        commitRename(event.currentTarget.value);
      } else if (event.key === "Escape") {
        renameCommittedRef.current = true;
        setRenaming(null);
      }
    },
    [commitRename],
  );
  return (
    <div
      className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3"
      onContextMenu={handleHeaderContextMenu}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
              <ChevronDownIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
              />
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          )}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
          rightPanelOpen ? "pr-10" : "pr-24",
        )}
      >
        {showOpenInPicker && (
          <OpenInPicker
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
      </div>
    </div>
  );
});
