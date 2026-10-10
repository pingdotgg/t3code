import { parseScopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  AlertTriangleIcon,
  CircleDashedIcon,
  CircleDotIcon,
  Clock3Icon,
  FolderGit2Icon,
  FolderIcon,
  GitBranchIcon,
  MessageCircleQuestionIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useEffect, useId } from "react";

import { useThreadCycleShortcut } from "../hooks/useThreadCycleShortcut";
import { cn } from "../lib/utils";
import { useProject, useThreadShell } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { useUiStateStore } from "../uiStateStore";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { ProjectFavicon } from "./ProjectFavicon";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "./Sidebar.logic";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "./ui/dialog";
import { MiddleTruncate } from "./ui/middle-truncate";

const STATUS_PRESENTATION = {
  approval: {
    label: "Needs approval",
    Icon: ShieldAlertIcon,
    className: "text-warning-foreground",
  },
  input: {
    label: "Needs input",
    Icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  working: { label: "Working", Icon: CircleDashedIcon, className: "text-info" },
  waiting: { label: "Waiting", Icon: Clock3Icon, className: "text-muted-foreground" },
  failed: { label: "Failed", Icon: AlertTriangleIcon, className: "text-error" },
  limited: { label: "Limit reached", Icon: AlertTriangleIcon, className: "text-warning" },
  unread: { label: "Unread", Icon: CircleDotIcon, className: "text-success" },
};

function ConversationOption({
  threadKey,
  selected,
  showEnvironment,
  id,
  onChoose,
}: {
  threadKey: string;
  selected: boolean;
  showEnvironment: boolean;
  id: string;
  onChoose: () => void;
}) {
  const ref = parseScopedThreadKey(threadKey);
  const thread = useThreadShell(ref);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const environment = useEnvironment(ref?.environmentId ?? null);
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread?.lastVisitedAt, localLastVisitedAt);
  const status = thread ? resolveSidebarThreadStatus(thread) : "ready";
  const unread = thread !== null && hasUnseenCompletion({ ...thread, lastVisitedAt });
  const presentation =
    status !== "ready" ? STATUS_PRESENTATION[status] : unread ? STATUS_PRESENTATION.unread : null;
  const title = thread?.title ?? "Conversation unavailable";
  const workspace =
    thread?.branch ??
    (thread?.worktreePath ? formatWorktreePathForDisplay(thread.worktreePath) : null);
  const WorkspaceIcon = thread?.branch ? GitBranchIcon : FolderGit2Icon;

  useEffect(() => {
    if (selected) document.getElementById(id)?.scrollIntoView({ block: "nearest" });
  }, [id, selected]);

  return (
    <button
      type="button"
      role="option"
      id={id}
      aria-selected={selected}
      aria-label={title}
      aria-describedby={`${id}-context`}
      tabIndex={-1}
      onClick={onChoose}
      className={cn(
        "flex min-h-20 w-full shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none",
        selected ? "bg-primary/10 ring-2 ring-primary" : "hover:bg-muted/60",
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
        {project ? (
          <ProjectFavicon project={project} className="size-5" />
        ) : (
          <FolderIcon aria-hidden className="size-5 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-sm leading-5 font-medium wrap-anywhere">{title}</div>
        <div
          id={`${id}-context`}
          className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
        >
          <span className="max-w-44 truncate">{project?.title ?? "Conversation"}</span>
          {workspace ? (
            <span className="flex min-w-0 items-center gap-1">
              <WorkspaceIcon aria-hidden className="size-3 shrink-0" />
              <MiddleTruncate value={workspace} />
            </span>
          ) : null}
          {showEnvironment ? (
            <span className="max-w-36 truncate">· {environment?.label ?? ref?.environmentId}</span>
          ) : null}
          {presentation ? <span className="sr-only">{presentation.label}</span> : null}
        </div>
      </div>
      {presentation ? (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-xs font-medium",
            presentation.className,
          )}
          aria-hidden
        >
          <presentation.Icon className="size-3.5" />
          {presentation.label}
        </span>
      ) : null}
    </button>
  );
}

function ConversationWorkspace({ threadKey }: { threadKey: string }) {
  const ref = parseScopedThreadKey(threadKey);
  const thread = useThreadShell(ref);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const environment = useEnvironment(ref?.environmentId ?? null);
  const path = thread?.worktreePath ?? project?.workspaceRoot;
  const Icon = thread?.worktreePath ? FolderGit2Icon : FolderIcon;

  return (
    <div className="mt-3 shrink-0 border-t px-3 pt-3 text-xs text-muted-foreground">
      <div className="mb-1 flex items-center gap-1.5">
        <Icon aria-hidden className="size-3.5" />
        <span>{thread?.worktreePath ? "Worktree" : "Project directory"}</span>
        {environment?.label ? <span className="truncate">· {environment.label}</span> : null}
      </div>
      <MiddleTruncate value={path ?? "Workspace unavailable"} />
    </div>
  );
}

export function ThreadCycleShortcut(props: Parameters<typeof useThreadCycleShortcut>[0]) {
  const { preview, cancel, commit } = useThreadCycleShortcut(props);
  const id = useId();
  const available = new Set(props.threadKeys);
  const keys = preview?.keys.filter((key) => available.has(key)) ?? [];
  const selectedIndex = preview ? keys.indexOf(preview.selectedKey) : -1;
  const start = Math.max(0, Math.min(selectedIndex - 2, keys.length - 5));
  const showEnvironment =
    new Set(keys.map((key) => parseScopedThreadKey(key)?.environmentId)).size > 1;

  return (
    <Dialog
      open={selectedIndex >= 0}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      {preview && selectedIndex >= 0 ? (
        <DialogPopup
          className="w-160 max-w-full"
          showCloseButton={false}
          bottomStickOnMobile={false}
          initialFocus={() => document.getElementById(id)}
        >
          <div className="flex min-h-0 flex-col p-4">
            <div className="mb-3 flex items-center justify-between gap-4 px-3">
              <DialogTitle>Recent conversations</DialogTitle>
              <span className="text-xs text-muted-foreground">
                {selectedIndex + 1} / {keys.length}
              </span>
            </div>
            <div
              id={id}
              role="listbox"
              aria-label="Recent conversations"
              aria-orientation="vertical"
              aria-activedescendant={`${id}-${preview.selectedKey}`}
              tabIndex={0}
              className="flex min-h-0 flex-col gap-1 overflow-y-auto p-1 outline-none"
            >
              {keys.slice(start, start + 5).map((key) => (
                <ConversationOption
                  key={key}
                  id={`${id}-${key}`}
                  threadKey={key}
                  selected={preview.selectedKey === key}
                  showEnvironment={showEnvironment}
                  onChoose={() => commit(key)}
                />
              ))}
            </div>
            <ConversationWorkspace threadKey={preview.selectedKey} />
            <div className="mt-4 text-center">
              <DialogDescription>
                Release to open · Shift to reverse · Esc to cancel
              </DialogDescription>
            </div>
          </div>
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}
