import { useLocation, useMatches, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStableCallback } from "../hooks/useStableCallback";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import {
  findLayoutTab,
  findLayoutTabByContent,
  focusLayoutTab,
  layoutTabContentKey,
  isLayoutPageContent,
  openLayoutTab,
  replaceLayoutTabContent,
  selectFocusedTab,
  showLayoutContent,
  type LayoutOpenPlacement,
  type LayoutState,
  type LayoutTabContent,
} from "./layoutModel";
import { useLayoutBehavior, type LayoutNewTabPosition } from "./layoutBehavior";
import { arrangeLayoutChange, useLayoutStore } from "./layoutStore";
import { layoutChatRoute } from "./useLayoutSettingsSync";
import { layoutPageHref, layoutPageKind } from "./pageNavigation";
import { isAppModalPage, getMainAppHref } from "../components/sidebar/mainAppLocation";

type RouteNewTab =
  | { readonly placement: LayoutOpenPlacement; readonly position: LayoutNewTabPosition }
  | { readonly replaceTabId: string };

/** Set once the page's first route has shown; a later mount is a navigation. */
let documentRouteShown = false;

/**
 * The page was reloaded and this is its first route: the URL is the one the
 * last session left, which stays on the last chat while focus rests on a tab
 * with no route of its own (see the layout-to-route subscription below).
 */
function isReloadedRoute(): boolean {
  if (documentRouteShown) return false;
  const [entry] = performance.getEntriesByType("navigation");
  return entry !== undefined && "type" in entry && entry.type === "reload";
}

/**
 * Show the route's thread in the layout: focus the tab showing it, hand a
 * promoted draft's tab to its thread, open it where a new tab was requested,
 * or else in a new column after the focused one (niri's open-window).
 */
function showRouteInLayout(
  layout: LayoutState,
  content: LayoutTabContent,
  promotedDraftId: DraftId | null,
  newTab: RouteNewTab | null,
): LayoutState {
  if (isLayoutPageContent(content)) {
    const opened = openLayoutTab(layout, content);
    const existing = findLayoutTabByContent(opened, content);
    return existing ? replaceLayoutTabContent(opened, existing.tab.id, content) : opened;
  }
  if (content.kind === "chat" && content.target.kind === "server" && promotedDraftId) {
    const draftTab = findLayoutTabByContent(layout, {
      kind: "chat",
      target: { kind: "draft", draftId: promotedDraftId },
    });
    if (draftTab) {
      const replaced = replaceLayoutTabContent(layout, draftTab.tab.id, content);
      return focusLayoutTab(replaced, draftTab.tab.id);
    }
  }
  if (newTab && !findLayoutTabByContent(layout, content)) {
    // A launcher tab that started the thread turns into its chat.
    if ("replaceTabId" in newTab) {
      if (findLayoutTab(layout, (tab) => tab.id === newTab.replaceTabId)) {
        const replaced = replaceLayoutTabContent(layout, newTab.replaceTabId, content);
        return focusLayoutTab(replaced, newTab.replaceTabId);
      }
      return showLayoutContent(layout, content);
    }
    return openLayoutTab(layout, content, {
      placement: newTab.placement,
      position: newTab.position,
    });
  }
  return showLayoutContent(layout, content);
}

/**
 * Derive the route layout during render, then commit that same object after paint.
 * Stable tab ids preserve promoted drafts; focus changes create history entries.
 */
export function useLayoutRouteSync(
  threadTarget: ThreadRouteTarget | null,
  /** The URL is the index, which shows the layout with no thread behind the URL. */
  atIndex = false,
): LayoutState {
  const navigate = useNavigate();
  const location = useLocation();
  const pageKind = layoutPageKind(location.pathname);
  const appModalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  const appModalPaused = appModalOpen || isAppModalPage(location.pathname);
  const pagePlaneOpen = appModalPaused || (pageKind !== null && location.search.pane !== 1);
  const layout = useLayoutStore((state) => state.layout);
  const routeContent: LayoutTabContent | null =
    pageKind !== null
      ? pagePlaneOpen
        ? null
        : { kind: pageKind, href: location.href }
      : threadTarget
        ? { kind: "chat", target: threadTarget }
        : null;
  const routeKey = routeContent ? layoutTabContentKey(routeContent) : null;
  const routeHref = routeContent && isLayoutPageContent(routeContent) ? location.href : routeKey;
  const readPagePlaneOpen = useStableCallback(() => pagePlaneOpen);
  const routeKeyRef = useRef<string | null>(routeKey);
  const promotedDraftId = useComposerDraftStore((store) =>
    threadTarget?.kind === "server"
      ? (store.getDraftIdByRef(threadTarget.threadRef) ?? null)
      : null,
  );
  const newTabRequest = useLayoutStore((state) => state.newTabRequest);
  const { newTabPosition } = useLayoutBehavior();
  const newTab: RouteNewTab | null =
    newTabRequest === null
      ? null
      : typeof newTabRequest === "string"
        ? { placement: newTabRequest, position: newTabPosition }
        : newTabRequest;
  // Keep the generated tab ids through the render retry. Once the store moves
  // off the captured base, later focus and close actions render its live layout.
  const [sync, setSync] = useState(() => ({
    startedOnPagePlane: pagePlaneOpen,
    settled: true,
    request: {
      href:
        routeContent && isReloadedRoute() && findLayoutTabByContent(layout, routeContent)
          ? routeHref
          : null,
      base: layout,
      derived: layout,
      content: routeContent,
      promotedDraftId,
      newTab,
      pending: false,
    },
  }));
  const { request } = sync;
  if (!pagePlaneOpen && (sync.startedOnPagePlane || request.href !== routeHref)) {
    const pending = request.href !== routeHref;
    const restoringWorkspace = sync.startedOnPagePlane && location.href === getMainAppHref();
    setSync({
      startedOnPagePlane: false,
      settled: false,
      request: {
        href: routeHref,
        base: layout,
        derived:
          pending && routeContent && !restoringWorkspace
            ? arrangeLayoutChange(
                layout,
                showRouteInLayout(layout, routeContent, promotedDraftId, newTab),
              )
            : layout,
        content: routeContent,
        promotedDraftId,
        newTab,
        pending,
      },
    });
  } else if (!appModalPaused && !sync.settled && layout !== request.base) {
    setSync({ ...sync, settled: true });
  }
  const derived = sync.settled || layout !== request.base ? layout : request.derived;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Mark the document route as shown after its first committed mount so later renders do not repeat reload restoration.
  useEffect(() => {
    documentRouteShown = true;
  }, []);
  const committedRequest = useRef<typeof request | null>(null);
  // Commit before paint, including commitDerived's fallback if queued focus or
  // another store update changed the base after this route was rendered.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Commit the rendered route request to the external layout store before pane DOM paints.
  useLayoutEffect(() => {
    if (pagePlaneOpen) return;
    routeKeyRef.current = routeKey;
    if (committedRequest.current === request) return;
    committedRequest.current = request;
    if (!request.pending) return;
    const { base, derived, content, promotedDraftId, newTab } = request;
    if (content && derived !== base) {
      useLayoutStore
        .getState()
        .commitDerived(base, derived, (current) =>
          showRouteInLayout(current, content, promotedDraftId, newTab),
        );
    }
    if (newTab && content) useLayoutStore.getState().clearNewTabRequest();
  }, [pagePlaneOpen, request, routeKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to layout focus changes and keeps the router URL aligned with the focused tab
  useEffect(() => {
    if (pagePlaneOpen) return;
    return useLayoutStore.subscribe((state, previous) => {
      if (readPagePlaneOpen() || state.layout === previous.layout) return;
      const focused = selectFocusedTab(state.layout);
      const before = selectFocusedTab(previous.layout);
      const focusedKey = focused ? layoutTabContentKey(focused.content) : null;
      const beforeKey = before ? layoutTabContentKey(before.content) : null;
      const routeKey = routeKeyRef.current;
      if (focusedKey !== beforeKey && focusedKey !== routeKey) {
        // A page tab returns to its own saved filters, scope, and section.
        if (focused && isLayoutPageContent(focused.content)) {
          void navigate({ href: layoutPageHref(focused.content) });
          return;
        }
        if (focused?.content.kind === "chat") {
          void navigate({
            ...layoutChatRoute(focused.content),
            replace:
              before?.id === focused.id &&
              before.content.kind === "chat" &&
              before.content.target.kind === "draft" &&
              focused.content.target.kind === "server",
          });
          return;
        }
      }
      // Keep the URL while any tab still shows its thread; leave for the index after the last
      // such tab closes.
      if (routeKey === null || focused?.content.kind === "chat") return;
      if (findLayoutTab(state.layout, (tab) => layoutTabContentKey(tab.content) === routeKey)) {
        return;
      }
      void navigate({ to: "/" });
    });
  }, [pagePlaneOpen, navigate, readPagePlaneOpen, routeKeyRef]);

  // Opened on the index while a chat holds focus (a restart restores the
  // layout), or reloaded on a chat while another holds the saved focus (a
  // second window moved it): the URL catches up with it once, as a focus
  // change would.
  const catchUpOnMount = useRef(atIndex || request.href !== null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Replace the restored document URL with the saved focused layout tab after mount.
  useEffect(() => {
    if (!catchUpOnMount.current) return;
    catchUpOnMount.current = false;
    if (readPagePlaneOpen()) return;
    const focused = selectFocusedTab(useLayoutStore.getState().layout);
    if (
      focused &&
      isLayoutPageContent(focused.content) &&
      layoutTabContentKey(focused.content) !== routeKeyRef.current
    ) {
      void navigate({ href: layoutPageHref(focused.content), replace: true });
      return;
    }
    if (
      focused?.content.kind === "chat" &&
      layoutTabContentKey(focused.content) !== routeKeyRef.current
    ) {
      void navigate({ ...layoutChatRoute(focused.content), replace: true });
    }
  }, [navigate, readPagePlaneOpen]);

  return appModalPaused ? layout : derived;
}
