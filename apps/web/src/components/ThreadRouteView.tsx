import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { visibilityParentKey } from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import ChatView from "./ChatView";
import { BackgroundThreadContext } from "./chat/backgroundThread";
import { SidebarInset } from "./ui/sidebar";
import { useComposerDraftStore } from "../composerDraftStore";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import {
  useEnvironmentThreadRefs,
  useAnyEnvironmentHiding,
  useQuietThreadShell,
} from "../state/entities";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentShellStatus } from "../state/shell";
import { environmentThreadShells, threadFamilies, useEnvironmentThread } from "../state/threads";
import { cn } from "../lib/utils";
import {
  buildThreadRouteParams,
  isThreadRouteSnapshotAuthoritative,
  resolveThreadRouteRenderState,
  type ThreadRouteTarget,
} from "../threadRoutes";

/**
 * Keeps the family of an open thread the shell leaves out (an older settled thread) in the shell
 * rows until the route leaves it, so every reader of its shell row finds it.
 */
function useOpenThreadFamily(threadRef: ScopedThreadRef | null, missing: boolean) {
  const key = threadRef === null ? null : scopedThreadKey(threadRef);
  // Sticks to the route thread, so the row the family brings in does not release it.
  const [mountedKey, setMountedKey] = useState<string | null>(null);
  const nextKey = missing || mountedKey === key ? key : null;
  if (nextKey !== mountedKey) setMountedKey(nextKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the open thread's family in the thread family registry until the route leaves it
  useEffect(() => {
    const ref = mountedKey === null ? null : parseScopedThreadKey(mountedKey);
    if (ref === null) return;
    return threadFamilies.mount(appAtomRegistry, ref.environmentId, ref.threadId);
  }, [mountedKey]);
}

/**
 * Unkeyed so navigating between server threads reuses one ChatView. Rendered by the `_chat`
 * layout, since an element only survives a route swap when the same parent renders it. Draft
 * promotion runs in the draft store; this only follows the redirect it leaves behind.
 * `background` keeps the thread mounted, inert and in place under Settings or Usage.
 */
export function ThreadRouteView({
  target,
  background = false,
  asPane = false,
  className,
  onTargetUnavailable,
}: {
  target: ThreadRouteTarget;
  background?: boolean;
  asPane?: boolean;
  className?: string;
  onTargetUnavailable?: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const draftRedirect = useComposerDraftStore((store) =>
    draftId === null ? null : store.getPromotedDraftRedirect(draftId),
  );
  const serverThreadRef = target.kind === "server" ? target.threadRef : null;
  const serverThreadShell = useQuietThreadShell(serverThreadRef);
  const shellStatus = useEnvironmentShellStatus(serverThreadRef?.environmentId ?? null);
  const environmentThreadRefs = useEnvironmentThreadRefs(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shellStatus);
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  // Reached from the sidebar before finalize, the thread still has its draft.
  const serverThreadDraftId = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftIdByRef(serverThreadRef) : null,
  );
  // The ChatView that carried a draft keeps its key through the redirect to its thread, and only
  // until the route leaves that thread, so later visits reuse the shared unkeyed ChatView.
  const [handoffKey, setHandoffKey] = useState<{ threadKey: string; key: string } | null>(null);
  const nextHandoffKey =
    draftId !== null && draftSession === null && draftRedirect
      ? handoffKey?.key === draftId
        ? handoffKey
        : { threadKey: scopedThreadKey(draftRedirect), key: draftId }
      : serverThreadRef && handoffKey?.threadKey === scopedThreadKey(serverThreadRef)
        ? handoffKey
        : serverThreadRef && serverThreadDraftId
          ? { threadKey: scopedThreadKey(serverThreadRef), key: serverThreadDraftId }
          : null;
  if (nextHandoffKey !== handoffKey) {
    setHandoffKey(nextHandoffKey);
  }
  const environmentHasDraftThreads = useComposerDraftStore((store) =>
    serverThreadRef ? store.hasDraftThreadsInEnvironment(serverThreadRef.environmentId) : false,
  );
  // Until the shell lists the thread, its own load (HTTP, then the socket)
  // decides whether it exists. Read only then: once listed, ChatView keeps
  // this stream open and its updates need not re-render the route.
  const unlistedThreadRef =
    target.kind === "server" && serverThreadShell === null && draftThread === null
      ? target.threadRef
      : null;
  const unlistedThreadDetail = useEnvironmentThread(
    unlistedThreadRef?.environmentId ?? null,
    unlistedThreadRef?.threadId ?? null,
  );
  useOpenThreadFamily(serverThreadRef, bootstrapComplete && unlistedThreadRef !== null);
  const hiddenKeys = useAtomValue(environmentThreadShells.hiddenThreadKeysAtom);
  const unlistedThread = Option.getOrNull(Option.map(unlistedThreadDetail.data, (p) => p.thread));
  const unlistedParentKey =
    unlistedThreadRef === null || unlistedThread === null
      ? null
      : visibilityParentKey(unlistedThreadRef.environmentId, unlistedThread);
  const unlistedParentShell = useQuietThreadShell(
    unlistedParentKey === null ? null : parseThreadKey(unlistedParentKey),
  );
  const hidingAnywhere = useAnyEnvironmentHiding();
  const draftRedirectShell = useQuietThreadShell(draftRedirect ?? null);
  const hiddenByTagFilter = serverThreadRef !== null && hiddenKeys.has(threadKey(serverThreadRef));
  // Cached detail can predate a tag or an archive, so while hiding an off-shell thread opens only
  // as the child of a loaded, visible parent (lineage never changes); anything else stays closed.
  const offShellBlocked =
    hidingAnywhere &&
    unlistedThreadRef !== null &&
    !(
      unlistedParentKey !== null &&
      unlistedParentShell !== null &&
      !hiddenKeys.has(unlistedParentKey)
    );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: serverThreadShell !== null,
    serverThreadDeleted: serverThreadShell?.deletedAt != null,
    unlistedThreadDetail,
    draftThreadExists: draftThread !== null,
  });
  const environmentHasAnyThreads = environmentThreadRefs.length > 0 || environmentHasDraftThreads;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears pending file drops and navigates the router home once a server thread is confirmed missing
  useEffect(() => {
    if (target.kind !== "server" || !bootstrapComplete) {
      return;
    }
    if (renderState === "missing") {
      const { clearPendingFileDropsForThread } = useSidebarPendingFileDropStore.getState();
      clearPendingFileDropsForThread(target.threadRef);
      if (environmentHasAnyThreads && !background && !onTargetUnavailable) {
        void navigate({ to: "/", replace: true });
      }
    }
  }, [
    background,
    bootstrapComplete,
    environmentHasAnyThreads,
    navigate,
    onTargetUnavailable,
    renderState,
    target,
  ]);

  let view: React.ReactNode = null;
  let redirect: React.ReactNode = null;
  if (target.kind === "draft") {
    if (
      draftSession &&
      hiddenKeys.has(
        threadKey({ environmentId: draftSession.environmentId, threadId: draftSession.threadId }),
      )
    ) {
      // A draft whose thread is already live and hidden (mid-promotion): never mount it.
      redirect = <Navigate to="/" replace />;
    } else if (draftSession) {
      view = (
        <ChatView
          key={target.draftId}
          draftId={target.draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          routeKind="draft"
          forceExpandedMobileComposer
        />
      );
    } else if (draftRedirect && hiddenKeys.has(threadKey(draftRedirect))) {
      // Back to a promoted draft whose thread is now hidden: never mount it.
      redirect = <Navigate to="/" replace />;
    } else if (draftRedirect && hidingAnywhere && draftRedirectShell === null) {
      // While hiding, a thread outside the live list is judged by the server route, unmounted here.
      redirect = (
        <Navigate
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(draftRedirect)}
          replace
        />
      );
    } else if (draftRedirect) {
      // Same slot and key as the server route renders, so the swap keeps this instance.
      view = (
        <ChatView
          key={target.draftId}
          environmentId={draftRedirect.environmentId}
          threadId={draftRedirect.threadId}
          routeKind="server"
        />
      );
      redirect = (
        <Navigate
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(draftRedirect)}
          replace
        />
      );
    } else {
      redirect = <Navigate to="/" replace />;
    }
  } else if (hiddenByTagFilter) {
    redirect = <Navigate to="/" replace />;
  } else if (offShellBlocked) {
    // Before the shell bootstraps, a listed visible thread can still look off-shell.
    if (bootstrapComplete && unlistedThread !== null) redirect = <Navigate to="/" replace />;
  } else if (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null)) {
    view = (
      <ChatView
        key={nextHandoffKey?.key}
        environmentId={target.threadRef.environmentId}
        threadId={target.threadRef.threadId}
        routeKind="server"
      />
    );
  }

  const unavailable =
    (view === null && redirect !== null) ||
    (target.kind === "server" && bootstrapComplete && renderState === "missing");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes a split pane after its thread is confirmed missing or its draft is no longer available
  useEffect(() => {
    if (!background && unavailable) onTargetUnavailable?.();
  }, [background, unavailable, onTargetUnavailable]);

  if (asPane) {
    return (
      <div
        className={cn(
          "relative flex h-full w-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background surface-grain",
          className,
        )}
        inert={background}
      >
        <BackgroundThreadContext value={background}>{view}</BackgroundThreadContext>
        {background || (unavailable && onTargetUnavailable) ? null : redirect}
      </div>
    );
  }

  return (
    <SidebarInset
      className={cn("h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh", className)}
      inert={background}
    >
      <BackgroundThreadContext value={background}>{view}</BackgroundThreadContext>
      {background ? null : redirect}
    </SidebarInset>
  );
}
