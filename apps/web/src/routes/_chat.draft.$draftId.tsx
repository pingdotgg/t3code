import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import ChatView from "../components/ChatView";
import {
  resolveDraftPromotionNavigationTarget,
  threadHasStarted,
} from "../components/ChatView.logic";
import {
  DraftId,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { waitForDraftHeroTransition } from "../components/chat/draftHeroTransition";
import { buildThreadRouteParams } from "../threadRoutes";
import { useThreadPullRequestLinkActions } from "../hooks/useThreadPullRequestLink";
import { useServerConfigs, useThread, useThreadRefs } from "../state/entities";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const threadRefs = useThreadRefs();
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef = draftSession?.promotedTo ?? inferredThreadRef;
  const serverThread = useThread(serverThreadRef);
  const serverThreadStarted = threadHasStarted(serverThread);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(serverThreadRef);
  const canonicalThreadRef = resolveDraftPromotionNavigationTarget({
    serverThreadRef,
    serverThreadStarted,
    backgroundSubmissionPending,
  });

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  // A pending PR link (set by "open a thread on this PR" surfaces) applies once
  // the pre-minted thread exists on the server. It fires before the route
  // navigates away, and the in-flight key keeps a re-render from sending it
  // twice. There is no in-app retry: the draft session is finalized the moment
  // the thread route takes over, so a failure is reported to the reader
  // instead, and the pull-request panel's own Link item is the way back.
  const { linkPullRequest } = useThreadPullRequestLinkActions();
  const pendingLinkedPullRequest = draftSession?.linkedPullRequest ?? null;
  // Reactive, not a one-shot read: capabilities arrive after connect, and a
  // read that misses them would skip the link with nothing left to re-run it
  // before the thread route finalizes the draft.
  const serverConfigs = useServerConfigs();
  const linkAttemptKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!inferredThreadRef || !pendingLinkedPullRequest) return;
    if (
      serverConfigs.get(inferredThreadRef.environmentId)?.environment.capabilities
        .threadPullRequestLinking !== true
    ) {
      return;
    }
    const attemptKey = `${inferredThreadRef.environmentId}:${inferredThreadRef.threadId}:${pendingLinkedPullRequest.number}`;
    if (linkAttemptKeyRef.current === attemptKey) return;
    linkAttemptKeyRef.current = attemptKey;
    void (async () => {
      const result = await linkPullRequest(inferredThreadRef, pendingLinkedPullRequest);
      if (result._tag === "Failure") {
        // Released so a draft still on screen can try again; an interrupted
        // command is a navigation, not a failure worth a toast.
        linkAttemptKeyRef.current = null;
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: `Could not link #${pendingLinkedPullRequest.number} to this thread`,
            description: "Link it from the pull request's menu.",
          });
        }
        return;
      }
      useComposerDraftStore.getState().setDraftThreadLinkedPullRequest(draftId, null);
    })();
  }, [draftId, inferredThreadRef, linkPullRequest, pendingLinkedPullRequest, serverConfigs]);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }

    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(canonicalThreadRef),
        replace: true,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  if (!draftSession) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <ChatView
        draftId={draftId}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        routeKind="draft"
        forceExpandedMobileComposer
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: DraftChatThreadRouteView,
});
