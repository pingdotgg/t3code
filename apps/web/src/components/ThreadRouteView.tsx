import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  Activity,
  memo,
  startTransition,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import ChatView from "./ChatView";
import {
  createKeptViewLifetimes,
  KeptViewFrame,
  KeptViewLifetimeContext,
  setUrlRouteTargetKey,
} from "./keptView";
import { resolveDraftPromotionNavigationTarget, threadHasStarted } from "./ChatView.logic";
import { waitForDraftHeroTransition } from "./chat/draftHeroTransition";
import { SidebarInset } from "./ui/sidebar";
import {
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import {
  useEnvironmentThreadRefs,
  useThreadRefs,
  useThreadShell,
  useThreadStatus,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";
import {
  buildThreadRouteParams,
  finishWarmingThreadView,
  isThreadRouteSnapshotAuthoritative,
  keepReleasedThreadView,
  resolveKeptThreadViews,
  resolveThreadRouteRenderState,
  resolveThreadRouteTarget,
  threadRouteTargetFromKey,
  threadRouteTargetKey,
  type KeptThreadView,
  type ThreadRouteTarget,
} from "../threadRoutes";

// Kept views re-render only when their own thread or route kind changes.
const KeptChatView = memo(ChatView);

// Updated on commit so route reveals use the mounted view pool.
let keptThreadKeys: ReadonlySet<string> = new Set();

const WARM_UP_QUIET_MS = 1_000;
let lastUserInputAt = 0;
let trackingUserInput = false;
// Hide warming views before their live input listeners can handle a user's event.
let interruptWarmUp: (() => void) | null = null;
function trackUserInput() {
  if (trackingUserInput || typeof window === "undefined") return;
  trackingUserInput = true;
  // Register before warming views so their listeners disconnect first.
  const record = () => {
    lastUserInputAt = performance.now();
    interruptWarmUp?.();
  };
  for (const type of ["keydown", "pointerdown", "wheel", "paste"] as const) {
    window.addEventListener(type, record, { capture: true, passive: true });
  }
}

function whenQuietAndIdle(callback: () => void, initialDelayMs: number): () => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  const attempt = () => {
    const quietFor = performance.now() - lastUserInputAt;
    if (quietFor < WARM_UP_QUIET_MS) {
      timeout = setTimeout(attempt, WARM_UP_QUIET_MS - quietFor);
    } else if (typeof requestIdleCallback === "function") {
      idle = requestIdleCallback(
        () => {
          idle = undefined;
          if (performance.now() - lastUserInputAt < WARM_UP_QUIET_MS) attempt();
          else callback();
        },
        { timeout: 2_000 },
      );
    } else {
      callback();
    }
  };
  timeout = setTimeout(attempt, initialDelayMs);
  return () => {
    clearTimeout(timeout);
    if (idle !== undefined) cancelIdleCallback(idle);
  };
}

const ThreadRouteView = memo(function ThreadRouteView({ target }: { target: ThreadRouteTarget }) {
  const navigate = useNavigate();
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const threadRefs = useThreadRefs();
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef: ScopedThreadRef | null =
    target.kind === "server" ? target.threadRef : (draftSession?.promotedTo ?? inferredThreadRef);
  const serverThread = useThreadShell(serverThreadRef);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(
    target.kind === "draft" ? serverThreadRef : null,
  );
  const canonicalThreadRef =
    target.kind === "draft"
      ? resolveDraftPromotionNavigationTarget({
          serverThreadRef,
          serverThread,
          backgroundSubmissionPending,
        })
      : null;

  const shell = useEnvironmentQuery(
    serverThreadRef === null ? null : environmentShell.stateAtom(serverThreadRef.environmentId),
  );
  const serverThreadShell = serverThread;
  const environmentThreadRefs = useEnvironmentThreadRefs(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shell.data?.status);
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) =>
    serverThreadRef ? store.hasDraftThreadsInEnvironment(serverThreadRef.environmentId) : false,
  );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: serverThreadShell !== null,
    serverThreadDeleted: serverThreadShell?.deletedAt != null,
    draftThreadExists: draftThread !== null,
  });
  const serverThreadStarted = threadHasStarted(serverThreadShell);
  const environmentHasAnyThreads = environmentThreadRefs.length > 0 || environmentHasDraftThreads;

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

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
    if (target.kind !== "draft" || draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate, target.kind]);

  useEffect(() => {
    if (target.kind !== "server" || !bootstrapComplete) {
      return;
    }
    if (renderState === "missing") {
      const { clearPendingFileDropsForThread } = useSidebarPendingFileDropStore.getState();
      clearPendingFileDropsForThread(target.threadRef);
      if (environmentHasAnyThreads) {
        void navigate({ to: "/", replace: true });
      }
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, renderState, target]);

  useEffect(() => {
    if (target.kind !== "server" || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(target.threadRef);
  }, [draftThread, serverThreadStarted, target]);

  let activeView: Omit<KeptThreadView, "visit"> | null = null;
  if (target.kind === "draft") {
    if (draftSession) {
      activeView = {
        key: target.draftId,
        // Only the thread fields: a draft session also carries a projectId.
        threadKey: scopedThreadKey({
          environmentId: draftSession.environmentId,
          threadId: draftSession.threadId,
        }),
        environmentId: draftSession.environmentId,
        threadId: draftSession.threadId,
        draftId: target.draftId,
      };
    }
  } else if (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null)) {
    activeView = {
      key: scopedThreadKey(target.threadRef),
      threadKey: scopedThreadKey(target.threadRef),
      environmentId: target.threadRef.environmentId,
      threadId: target.threadRef.threadId,
      draftId: null,
    };
  }
  const [keptViews, setKeptViews] = useState<ReadonlyArray<KeptThreadView>>([]);
  const [releasedView, setReleasedView] = useState<KeptThreadView | null>(null);
  const keptUpdate = resolveKeptThreadViews(keptViews, activeView);
  const nextKeptViews = keptUpdate.views;
  if (nextKeptViews !== keptViews) {
    setKeptViews(nextKeptViews);
    if (keptUpdate.released !== null) setReleasedView(keptUpdate.released);
  }
  // Warm the displaced view after the shown thread loads and input goes quiet.
  // Render hidden at idle priority, then lay out at the next quiet moment.
  const shownThreadStatus = useThreadStatus(target.kind === "server" ? target.threadRef : null);
  const shownThreadLoaded =
    target.kind !== "server" || shownThreadStatus === "live" || shownThreadStatus === "deleted";
  useEffect(trackUserInput, []);
  useEffect(() => {
    if (releasedView === null || !shownThreadLoaded) return;
    return whenQuietAndIdle(
      () =>
        startTransition(() => {
          setKeptViews((current) => keepReleasedThreadView(current, releasedView));
          setReleasedView(null);
        }),
      WARM_UP_QUIET_MS,
    );
  }, [releasedView, shownThreadLoaded]);
  const [laidOutWarmKey, setLaidOutWarmKey] = useState<string | null>(null);
  const warmingKey = keptViews.find((view) => view.warming === true)?.key ?? null;
  const layingOutKey = warmingKey !== null && warmingKey === laidOutWarmKey ? warmingKey : null;
  useEffect(() => {
    if (warmingKey === null || layingOutKey !== null) return;
    return whenQuietAndIdle(() => startTransition(() => setLaidOutWarmKey(warmingKey)), 0);
  }, [layingOutKey, warmingKey]);
  useLayoutEffect(() => {
    if (layingOutKey === null) return;
    interruptWarmUp = () => flushSync(() => setLaidOutWarmKey(null));
    return () => {
      interruptWarmUp = null;
    };
  }, [layingOutKey]);
  const finishWarming = (viewKey: string) => {
    setKeptViews((current) => finishWarmingThreadView(current, viewKey));
    setLaidOutWarmKey(null);
  };
  useLayoutEffect(() => {
    keptThreadKeys = new Set(
      keptViews.flatMap((view) => (view.draftId === null ? [view.threadKey] : [])),
    );
  }, [keptViews]);
  const [lifetimes] = useState(createKeptViewLifetimes);
  const insetRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    lifetimes.retain(new Set(keptViews.map((view) => view.key)));
  }, [keptViews, lifetimes]);
  useEffect(() => {
    const inset = insetRef.current;
    return () => {
      // Activity hides keep lifetimes; only removal releases them.
      setTimeout(() => {
        if (!inset?.isConnected) lifetimes.retain(new Set());
      }, 0);
    };
  }, [lifetimes]);
  const activeViewKey =
    activeView === null
      ? null
      : (nextKeptViews.find((view) =>
          activeView.draftId === null
            ? view.threadKey === activeView.threadKey
            : view.key === activeView.key,
        )?.key ?? null);
  // Activity preserves DOM; pause media when its view hides.
  useLayoutEffect(() => {
    const inset = insetRef.current;
    return () => {
      for (const media of inset?.querySelectorAll<HTMLMediaElement>("video, audio") ?? []) {
        if (!media.paused) media.pause();
      }
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each change of the shown view pauses the one it hid.
  }, [activeViewKey]);

  return (
    <SidebarInset
      ref={insetRef}
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
    >
      {nextKeptViews.map((view) => (
        <Activity
          key={view.key}
          mode={view.key === activeViewKey || view.key === layingOutKey ? "visible" : "hidden"}
        >
          <KeptViewLifetimeContext value={lifetimes.get(view.key)}>
            <KeptViewFrame
              viewKey={view.key}
              warming={view.warming === true && view.key !== activeViewKey}
              onWarm={finishWarming}
            >
              <KeptChatView
                environmentId={view.environmentId}
                threadId={view.threadId}
                {...(view.draftId === null
                  ? { routeKind: "server" as const }
                  : {
                      routeKind: "draft" as const,
                      draftId: view.draftId,
                      forceExpandedMobileComposer: true,
                    })}
              />
            </KeptViewFrame>
          </KeptViewLifetimeContext>
        </Activity>
      ))}
    </SidebarInset>
  );
});

/** Hosting above the outlet preserves chat views across full-page navigation. */
export function KeptChatSurface() {
  const targetKey = useParams({
    strict: false,
    select: (params) => threadRouteTargetKey(resolveThreadRouteTarget(params)),
  });
  // Defer warm reveals so sidebar selection paints first; first opens stay urgent.
  const deferredTargetKey = useDeferredValue(targetKey);
  const targetThreadKey = targetKey?.startsWith("server:")
    ? targetKey.slice("server:".length)
    : null;
  const reveal = targetThreadKey !== null && keptThreadKeys.has(targetThreadKey);
  // Full-page returns have no visible thread to hold during a transition.
  const shownKey = reveal && deferredTargetKey !== null ? deferredTargetKey : targetKey;
  // Keys typed before a deferred reveal lands go to the URL's thread.
  useLayoutEffect(() => setUrlRouteTargetKey(targetKey), [targetKey]);
  const [shownTargetKey, setShownTargetKey] = useState(shownKey);
  if (shownKey !== null && shownKey !== shownTargetKey) {
    setShownTargetKey(shownKey);
  }
  const target = useMemo(() => threadRouteTargetFromKey(shownTargetKey), [shownTargetKey]);
  if (target === null) return null;
  return (
    <Activity mode={targetKey !== null && shownKey !== null ? "visible" : "hidden"}>
      <ThreadRouteView target={target} />
    </Activity>
  );
}
