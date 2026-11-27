import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import { linkedThreadRouteParams, linkedThreadSurface } from "../../linkedThreadSurface";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { LinkedThread } from "../chat/LinkedThreadPane";
import { useWorkflowThreadOpen } from "./useWorkflowThreadOpen";

/** Opens the thread as a full thread view; `linked` reads it through `viaEnvironmentId`. */
export function useOpenThreadPage(): (
  threadRef: ScopedThreadRef,
  viaEnvironmentId?: EnvironmentId,
) => void {
  const navigate = useNavigate();
  return (threadRef, viaEnvironmentId) =>
    void (viaEnvironmentId === undefined
      ? navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) })
      : navigate({
          to: "/linked/$viaEnvironmentId/$linkedEnvironmentId/$linkedThreadId",
          params: linkedThreadRouteParams({ viaEnvironmentId, ...threadRef }),
        }));
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
export default function WorkflowThreadPane({
  viaEnvironmentId,
  threadRef,
}: {
  /** The environment running the workflow. */
  readonly viaEnvironmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
}) {
  const threadOpen = useWorkflowThreadOpen(viaEnvironmentId, threadRef.environmentId);
  if (threadOpen.open === "linked" && threadOpen.label !== null) {
    const surface = linkedThreadSurface({
      viaEnvironmentId,
      ...threadRef,
      label: threadOpen.label,
      title: null,
    });
    return <LinkedThread key={surface.id} panelRef={null} surface={surface} visible />;
  }
  return <ConnectedWorkflowThreadPane threadRef={threadRef} />;
}

function ConnectedWorkflowThreadPane({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
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
