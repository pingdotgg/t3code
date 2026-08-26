import { createFileRoute } from "@tanstack/react-router";

import ChatView from "../components/ChatView";
import { useComposerDraftStore } from "../composerDraftStore";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { resolveThreadRouteRef, resolveThreadRouteRenderState } from "../threadRoutes";

/**
 * The right panel's content on its own, for the Qt shell's second web view.
 * Same session (cookies), its own WebSocket; the tab model converges with the
 * primary document through localStorage (see shell/shellDocumentSync.ts).
 */
function EmbedThreadPanelRouteView() {
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const shell = useEnvironmentQuery(
    threadRef === null ? null : environmentShell.stateAtom(threadRef.environmentId),
  );
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  // Drafts persist to localStorage, so a draft the primary document is
  // showing is visible here too (its own store copy, same key).
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists,
  });

  if (!threadRef) {
    return null;
  }
  return (
    <div className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground md:h-dvh">
      {renderState === "ready" || (renderState === "loading" && serverThreadShell !== null) ? (
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
          presentation="rightPanel"
        />
      ) : null}
    </div>
  );
}

export const Route = createFileRoute("/embed/$environmentId/$threadId")({
  component: EmbedThreadPanelRouteView,
});
