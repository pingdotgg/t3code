import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { ChatHeader } from "../components/chat/ChatHeader";
import {
  ChatPaneHeader,
  ChatPaneHeaderControls,
  useHeaderControlsInset,
} from "../components/chat/ChatPaneHeader";
import { PanelLayoutControls } from "../components/chat/PanelLayoutControls";
import { useComposerDraftStore } from "../composerDraftStore";
import { selectThreadPanelOpen, useRightPanelStore } from "../rightPanelStore";
import { useProject, useThreadShell } from "../state/entities";
import type { ThreadRouteTarget } from "../threadRoutes";

const ignore = () => {};

/** Use the real chat header over an inert body until ChatView mounts, so a new pane paints
 * immediately without shifting its chrome. */
export function ChatPaneStandIn({ target }: { target: ThreadRouteTarget }) {
  const draft = useComposerDraftStore((store) =>
    target.kind === "draft" ? store.getDraftSession(target.draftId) : null,
  );
  const thread = useThreadShell(target.kind === "server" ? target.threadRef : null);
  const threadRef =
    target.kind === "server"
      ? target.threadRef
      : draft
        ? scopeThreadRef(draft.environmentId, draft.threadId)
        : null;
  const projectRef = (() => {
    if (thread) return scopeProjectRef(thread.environmentId, thread.projectId);
    if (draft) return scopeProjectRef(draft.environmentId, draft.projectId);
    return null;
  })();
  const project = useProject(projectRef);
  const threadPanelOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const [controlsInset, measureControls] = useHeaderControlsInset();
  return (
    <div
      inert
      className="@container/header-actions relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      <div className="pane-mobile-chrome flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
        <ChatPaneHeader reserveNativeControlsInset>
          <ChatPaneHeaderControls measureRef={measureControls}>
            <PanelLayoutControls
              threadPanelOpen={threadPanelOpen}
              threadPanelPresentation="inline"
              threadPanelShortcutLabel={null}
              onToggleThreadPanel={ignore}
            />
          </ChatPaneHeaderControls>
          {threadRef ? (
            <ChatHeader
              activeThreadEnvironmentId={threadRef.environmentId}
              activeThreadId={threadRef.threadId}
              activeThreadTitle={thread?.title ?? "New thread"}
              isServerThread={target.kind === "server"}
              activeProject={project ?? null}
              parentThreadLink={null}
              onOpenThread={ignore}
              rightPanelOpen={false}
              trailingInset={controlsInset}
            />
          ) : null}
        </ChatPaneHeader>
        <div aria-hidden className="min-h-0 flex-1" />
      </div>
    </div>
  );
}
