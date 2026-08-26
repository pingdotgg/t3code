import { ShellRightPanelState } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import ChatView from "../components/ChatView";
import { useComposerDraftStore } from "../composerDraftStore";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import {
  buildThreadRouteParams,
  resolveThreadRouteRef,
  resolveThreadRouteRenderState,
} from "../threadRoutes";

const isShellRightPanelState = Schema.is(ShellRightPanelState);

/**
 * The right panel's content on its own, for the Qt shell's second web view.
 * Same session (cookies), its own WebSocket; the tab model converges with the
 * primary document through localStorage (see shell/shellDocumentSync.ts).
 */
function EmbedThreadPanelRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });

  // Follow the primary document: when it moves to another thread, navigate in
  // place instead of the shell reloading this document with a new URL.
  useEffect(() => {
    const shell = window.t3Shell;
    if (!shell) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void shell
      .onState((state) => {
        const rightPanel = state.rightPanel;
        if (!isShellRightPanelState(rightPanel)) return;
        const target = resolveThreadRouteRef(
          Object.fromEntries(
            rightPanel.embedPath
              .split("/")
              .slice(2)
              .map((segment, index) => [
                index === 0 ? "environmentId" : "threadId",
                decodeURIComponent(segment),
              ]),
          ),
        );
        if (
          target === null ||
          (threadRef !== null &&
            target.environmentId === threadRef.environmentId &&
            target.threadId === threadRef.threadId)
        ) {
          return;
        }
        void navigate({
          to: "/embed/$environmentId/$threadId",
          params: buildThreadRouteParams(target),
          replace: true,
        });
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unsubscribe = dispose;
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [navigate, threadRef]);
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
