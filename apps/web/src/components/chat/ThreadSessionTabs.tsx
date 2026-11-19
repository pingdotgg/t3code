import { useGT } from "gt-react";
import { Link } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { MessageSquareIcon, PlusIcon } from "lucide-react";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { cn } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { selectThreadSessionTabs } from "./threadSessionTabs.logic";

function revealActiveSession(element: HTMLAnchorElement | null) {
  element?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function ThreadSessionTabs({
  environmentId,
  projectId,
  activeThreadId,
  onNewThread,
  isDraft = false,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  activeThreadId: ThreadId;
  onNewThread: () => void;
  isDraft?: boolean;
}) {
  const gt = useGT();
  const project = scopeProjectRef(environmentId, projectId);
  const threads = useThreadShellsForProjectRefs([project]);
  const sessions = selectThreadSessionTabs(threads, project, activeThreadId);
  if (sessions.length === 0 && !isDraft) return null;
  return (
    <nav
      aria-label="Threads"
      className={cn(
        "drag-region hidden h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-sidebar px-3 md:flex wco:pr-(--workspace-native-controls-inset)",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
      data-session-tabs
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
        {sessions.map((thread) => (
          <Link
            key={thread.id}
            ref={thread.id === activeThreadId ? revealActiveSession : undefined}
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: thread.id }}
            aria-current={thread.id === activeThreadId ? "page" : undefined}
            title={thread.title}
            className={cn(
              "flex h-8 max-w-52 min-w-0 shrink-0 items-center gap-2 rounded-lg border px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [-webkit-app-region:no-drag]",
              thread.id === activeThreadId
                ? "border-border bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
            )}
          >
            <MessageSquareIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{thread.title}</span>
          </Link>
        ))}
        {isDraft ? (
          <span
            aria-current="page"
            className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs text-foreground [-webkit-app-region:no-drag]"
            ref={(element) => element?.scrollIntoView({ block: "nearest", inline: "nearest" })}
          >
            <MessageSquareIcon aria-hidden className="size-3 shrink-0" />
            {gt("New thread")}
          </span>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              className="[-webkit-app-region:no-drag]"
              variant="ghost"
              size="icon-sm"
              aria-label="New thread"
              onClick={onNewThread}
            />
          }
        >
          <PlusIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>New thread</TooltipPopup>
      </Tooltip>
    </nav>
  );
}
