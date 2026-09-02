import { createFileRoute } from "@tanstack/react-router";

import ChatView from "../components/ChatView";
import { useComposerDraftStore } from "../composerDraftStore";
import { ShellEmbedRouteBridge } from "../shell/lazy";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import { resolveThreadRouteRef, resolveThreadRouteRenderState } from "../threadRoutes";

/** Which part of the thread this document shows. */
export type EmbedSurface = "panel" | "terminal";

/**
 * One part of the thread on its own, for a web view the Qt shell places
 * itself: the right panel's content, or with `?surface=terminal` the terminal
 * drawer. Same session (cookies), its own WebSocket; the panel tabs and the
 * drawer's state converge with the primary document through localStorage
 * (see shell/shellDocumentSync.ts).
 */
function EmbedThreadPanelRouteView() {
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const { surface } = Route.useSearch();

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
      {/* Follows the primary view's thread instead of the shell reloading this document. */}
      <ShellEmbedRouteBridge threadRef={threadRef} surface={surface} />
      {renderState === "ready" || (renderState === "loading" && serverThreadShell !== null) ? (
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
          presentation={surface === "terminal" ? "terminal" : "rightPanel"}
        />
      ) : null}
    </div>
  );
}

export const Route = createFileRoute("/embed/$environmentId/$threadId")({
  validateSearch: (raw: Record<string, unknown>): { surface: EmbedSurface } => ({
    surface: raw.surface === "terminal" ? "terminal" : "panel",
  }),
  component: EmbedThreadPanelRouteView,
});
