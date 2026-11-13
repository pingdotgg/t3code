import { type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Maximize2Icon, XIcon } from "lucide-react";

import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { Button } from "../ui/button";

/**
 * An agent step's thread beside its run: the same chat as anywhere, composer included, so a
 * person can read what the agent did and talk to it without leaving the run.
 */
export default function WorkflowThreadPane({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const shell = useQuietThreadShell(threadRef);
  const snapshotLoaded = useEnvironmentShellHasSnapshot(threadRef.environmentId);
  const openFull = () =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  // The diff panel and the terminal drawer belong to the full thread view, so both lead there.
  const panel: SideChatParentPanel = { openToolDiff: openFull, runShellCommand: openFull };
  return (
    // The attribute is how the embedded chat knows the keyboard is meant for it.
    <div data-side-chat-pane className="flex h-full min-h-0 flex-col">
      <div className="flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 border-b ps-3 pe-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {shell?.workflowRun?.step ?? shell?.title ?? "Agent"}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open as a full thread"
          onClick={openFull}
        >
          <Maximize2Icon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close transcript" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {shell === null ? (
        <p className="p-3 text-xs text-muted-foreground" role="status">
          {snapshotLoaded ? "This thread is no longer there." : "Loading the thread…"}
        </p>
      ) : (
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              environmentId={threadRef.environmentId}
              threadId={threadRef.threadId}
              routeKind="server"
              embedded={panel}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      )}
    </div>
  );
}
