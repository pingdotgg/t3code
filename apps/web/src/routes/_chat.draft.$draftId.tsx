import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import ChatView from "../components/ChatView";
import { resolveStartedThreadRef } from "../components/ChatView.logic";
import {
  DraftId,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../composerDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { waitForDraftHeroTransition } from "../components/chat/draftHeroTransition";
import { buildThreadRouteParams, resolveDraftThreadSubscriptionRef } from "../threadRoutes";
import { useThreadDetail } from "../state/entities";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const serverThreadRef = resolveDraftThreadSubscriptionRef(draftSession);
  // Promotion is driven by the authoritative detail stream. The composed
  // `useThread` view intentionally overlays shell metadata, whose independent
  // subscription can briefly lag and erase a started session/latest turn.
  const serverThreadDetail = useThreadDetail(serverThreadRef);
  const canonicalThreadRef = resolveStartedThreadRef(serverThreadRef, serverThreadDetail);
  const serverThreadStarted = canonicalThreadRef !== null;

  useEffect(() => {
    if (!serverThreadStarted || !serverThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(serverThreadRef);
  }, [draftSession?.promotedTo, serverThreadRef, serverThreadStarted]);

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
