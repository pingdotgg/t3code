import {
  Navigate,
  useLocation,
  useMatch,
  useMatches,
  useRouteContext,
} from "@tanstack/react-router";
import { type ReactNode } from "react";

import { BackgroundThreadContext } from "../components/chat/backgroundThread";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { buildThreadRouteParams, type ThreadRouteTarget } from "../threadRoutes";
import { useComposerDraftStore } from "../composerDraftStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { LayoutSurfaceHost } from "./SurfaceHost";
import { layoutRoutePage } from "./pageNavigation";
import { useIndexShowsLayout } from "./useIndexShowsLayout";
import { useLayoutRouteSync } from "./useLayoutRouteSync";
import { useDraftSurfaceCleanupOnLayoutClose } from "./useDraftSurfaceCleanupOnLayoutClose";

/** The workspace stays mounted beneath fullscreen pages so panes retain their state. */
export function WorkspacePlane({ children }: { children: ReactNode }) {
  const location = useLocation();
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  const modalPending = isAppModalPage(location.pathname);
  const threadTarget = useThreadRouteTarget();
  const promotedThreadRef = useComposerDraftStore((store) =>
    threadTarget?.kind === "draft" ? store.getPromotedDraftRedirect(threadTarget.draftId) : null,
  );
  const missingDraft = useComposerDraftStore(
    (store) =>
      threadTarget?.kind === "draft" &&
      store.getDraftSession(threadTarget.draftId) === null &&
      store.getPromotedDraftRedirect(threadTarget.draftId) === null,
  );
  const canonicalTarget: ThreadRouteTarget | null = promotedThreadRef
    ? { kind: "server", threadRef: promotedThreadRef }
    : threadTarget;
  // Rendered matches keep the index workspace mounted during pending thread navigation.
  const atIndex = useMatch({ from: "/_chat/", shouldThrow: false, select: () => true }) === true;
  const { authGateState } = useRouteContext({ from: "__root__" });
  const indexShowsLayout = useIndexShowsLayout(authGateState.status === "hosted-static");
  const layout = useLayoutRouteSync(canonicalTarget, atIndex);
  useDraftSurfaceCleanupOnLayoutClose();
  const workspaceOpen =
    modalOpen ||
    modalPending ||
    threadTarget !== null ||
    layoutRoutePage(location) !== null ||
    (atIndex && indexShowsLayout);
  const pagePlane = workspaceOpen ? undefined : children;
  const host = (
    <LayoutSurfaceHost
      layout={layout}
      active={workspaceOpen}
      background={modalOpen}
      pagePlane={pagePlane}
    />
  );
  return (
    <>
      {!modalOpen && threadTarget?.kind === "server" ? (
        <ThreadLinkPrompt threadRef={threadTarget.threadRef} />
      ) : null}
      <BackgroundThreadContext value={modalOpen}>{host}</BackgroundThreadContext>
      {modalOpen ? children : null}
      {promotedThreadRef && !modalOpen ? (
        <Navigate
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(promotedThreadRef)}
          replace
        />
      ) : missingDraft && !modalOpen ? (
        <Navigate to="/" replace />
      ) : null}
    </>
  );
}
