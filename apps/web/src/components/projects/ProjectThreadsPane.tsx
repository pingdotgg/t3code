import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { hostRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadShell, useVisibleThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { projectAgentThreads, projectThreadActivity } from "./projectCoordinator.logic";

/** The coordinator's right panel tab: the project's threads, or one of them picked from the list. */
export function ProjectThreadsPane(props: {
  readonly coordinatorRef: ScopedThreadRef;
  readonly threadId: ThreadId | undefined;
  readonly parentPanel: SideChatParentPanel;
}) {
  const { coordinatorRef, threadId } = props;
  return threadId === undefined ? (
    <ProjectThreadList coordinatorRef={coordinatorRef} />
  ) : (
    <ProjectThreadView
      coordinatorRef={coordinatorRef}
      threadId={threadId}
      parentPanel={props.parentPanel}
    />
  );
}

function ProjectThreadList({ coordinatorRef }: { readonly coordinatorRef: ScopedThreadRef }) {
  const coordinator = useQuietThreadShell(coordinatorRef);
  const shells = useVisibleThreadShells();
  const threads =
    coordinator === null
      ? []
      : projectAgentThreads(shells, coordinatorRef.environmentId, coordinator.projectId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b border-border px-3 text-xs font-medium">
        Project threads
      </div>
      {threads.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">
          No other threads in this project yet. Threads the coordinator delegates appear here.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto py-1" aria-label="Project threads">
          {threads.map((thread) => {
            const activity = projectThreadActivity(thread);
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  onClick={() =>
                    useRightPanelStore.getState().openProjectThreads(coordinatorRef, thread.id)
                  }
                >
                  <span className="truncate text-sm">{thread.title}</span>
                  <span className="flex gap-1.5 text-xs text-muted-foreground">
                    {activity ? <span className="text-foreground">{activity}</span> : null}
                    {thread.lineage.parentThreadId === coordinatorRef.threadId ? (
                      <span>Delegated</span>
                    ) : null}
                    <span className="truncate">{thread.modelSelection.model}</span>
                    <span className="ml-auto shrink-0">
                      <RelativeTime timestamp={thread.updatedAt} />
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ProjectThreadView(props: {
  readonly coordinatorRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly parentPanel: SideChatParentPanel;
}) {
  const { coordinatorRef, threadId } = props;
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(coordinatorRef.environmentId, threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the coordinator panel as host in the panel store
  useEffect(
    () => hostRightPanel(scopeThreadRef(coordinatorRef.environmentId, threadId), coordinatorRef),
    [coordinatorRef, threadId],
  );
  const shell = useQuietThreadShell(threadRef);
  const backToList = () => useRightPanelStore.getState().openProjectThreads(coordinatorRef, null);
  return (
    <div data-side-chat-pane className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-1">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="All project threads"
          onClick={backToList}
        >
          <ArrowLeftIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {shell?.title ?? "Thread"}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open as main thread"
          disabled={shell === null}
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(threadRef),
            })
          }
        >
          <ExternalLinkIcon />
        </Button>
      </div>
      {shell === null ? (
        <p className="p-3 text-xs text-muted-foreground">This thread is no longer available.</p>
      ) : (
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              environmentId={coordinatorRef.environmentId}
              threadId={threadId}
              routeKind="server"
              embedded={props.parentPanel}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      )}
    </div>
  );
}
