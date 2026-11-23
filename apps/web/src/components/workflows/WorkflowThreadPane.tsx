import { type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";

/** Opens the thread as a full thread view. */
export function useOpenThreadPage(): (threadRef: ScopedThreadRef) => void {
  const navigate = useNavigate();
  return (threadRef) =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
}

/** What a transcript's tab is called: the step its agent did, or the thread's own title. */
export function WorkflowThreadTabLabel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const shell = useQuietThreadShell(threadRef);
  const step = shell?.workflowRun?.step;
  return step === undefined
    ? (shell?.title ?? gt("Agent", { $context: "fallback title of a coding agent's thread" }))
    : gt("{step} · transcript", { step, $context: "tab: the agent thread of a workflow step" });
}

/**
 * An agent step's thread beside its run: the same chat as anywhere, composer included, so a
 * person can read what the agent did and talk to it without leaving the run.
 */
export default function WorkflowThreadPane({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const openThreadPage = useOpenThreadPage();
  const shell = useQuietThreadShell(threadRef);
  const snapshotLoaded = useEnvironmentShellHasSnapshot(threadRef.environmentId);
  const openFull = () => openThreadPage(threadRef);
  // The diff panel and the terminal drawer belong to the full thread view, so both lead there.
  const panel: SideChatParentPanel = {
    hostRef: threadRef,
    openToolDiff: openFull,
    runShellCommand: openFull,
  };
  return shell === null ? (
    <p className="p-3 text-xs text-muted-foreground" role="status">
      {snapshotLoaded ? gt("This thread is no longer there.") : gt("Loading the thread…")}
    </p>
  ) : (
    // The attribute is how the embedded chat knows the keyboard is meant for it.
    <div data-side-chat-pane className="flex min-h-0 flex-1 flex-col">
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
    </div>
  );
}
