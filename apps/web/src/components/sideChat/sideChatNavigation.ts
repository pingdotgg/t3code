import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  deriveSideChatTree,
  type SideChatTreeRow,
} from "@t3tools/client-runtime/state/thread-relationships";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { useNavigate } from "@tanstack/react-router";

import {
  type RightPanelSurface,
  type SideChatSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { readSideChatTreeShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { usePendingSideChatStore } from "./pendingSideChatStore";
import { sideChatSurfacePath, topSideChatId } from "./sideChatPanel.logic";

interface SideChatLink {
  readonly sideChat?: { readonly lessonThreadId: ThreadId } | null | undefined;
}

/**
 * Shows `threadId` in its top-level side chat's tab on the lesson's panel, and
 * un-maximizes the panel so the lesson stays in view.
 */
export function revealSideChat(
  lessonRef: ScopedThreadRef,
  threadId: ThreadId,
  automatic = false,
): void {
  const rows = deriveSideChatTree(readSideChatTreeShells(lessonRef), lessonRef.threadId);
  const panels = useRightPanelStore.getState();
  panels.openLessonSideChat(
    lessonRef,
    { topThreadId: topSideChatId(rows, threadId) ?? threadId, threadId },
    automatic,
  );
  panels.setMaximized(lessonRef, false);
}

/** Reveals the side chat and puts the cursor in its composer once its panel shows it. */
export function focusSideChat(lessonRef: ScopedThreadRef, threadId: ThreadId): void {
  revealSideChat(lessonRef, threadId);
  usePendingSideChatStore
    .getState()
    .requestFocus(scopedThreadKey(scopeThreadRef(lessonRef.environmentId, threadId)));
}

/**
 * Leaves the side chat `surface` shows: the tab goes back to its parent side chat,
 * or closes when the side chat is a top-level one.
 */
export function leaveSideChat(
  lessonRef: ScopedThreadRef,
  surface: SideChatSurface,
  rows: ReadonlyArray<SideChatTreeRow>,
): "walked" | "closed" {
  const path = sideChatSurfacePath(rows, surface.threadId);
  const panels = useRightPanelStore.getState();
  if (path.length > 1) {
    panels.navigateSideChat(lessonRef, surface.id, path.slice(0, -1), path);
    return "walked";
  }
  panels.closeSurface(lessonRef, surface.id);
  return "closed";
}

/**
 * Puts the cursor in the lesson's composer, with the lesson in view: a maximized panel
 * shrinks back, and in the sheet layout the panel is a modal over the lesson, so it hides;
 * its tabs stay for the panel toggle to bring back.
 */
export function returnToLesson(
  lessonRef: ScopedThreadRef,
  sheet: boolean,
  focusComposer: () => void,
): void {
  showLesson(lessonRef, sheet);
  focusComposer();
}

/** The lesson-in-view half of `returnToLesson`, for callers that already return focus there. */
export function showLesson(lessonRef: ScopedThreadRef, sheet: boolean): void {
  const panels = useRightPanelStore.getState();
  panels.setMaximized(lessonRef, false);
  if (sheet) panels.close(lessonRef);
}

/** Where a thread opens: a side chat opens on its lesson's route, in the lesson's panel. */
export interface ThreadOpenTarget {
  readonly routeThreadId: ThreadId;
  readonly sideChatThreadId: ThreadId | null;
}

export function resolveThreadOpenTarget(
  thread: { readonly id: ThreadId } & SideChatLink,
): ThreadOpenTarget {
  return thread.sideChat
    ? { routeThreadId: thread.sideChat.lessonThreadId, sideChatThreadId: thread.id }
    : { routeThreadId: thread.id, sideChatThreadId: null };
}

/** The lesson a side chat belongs to; an ordinary thread is its own lesson. */
export function sideChatLessonRef(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } & SideChatLink,
): ScopedThreadRef {
  return scopeThreadRef(thread.environmentId, resolveThreadOpenTarget(thread).routeThreadId);
}

/**
 * Reveals the side chat before navigating, so the lesson mounts with its panel
 * already showing it. A target already on screen is not navigated to again, which
 * would drop the route's hash (a revealed citation).
 */
export async function openThreadTarget(input: {
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly environmentId: EnvironmentId;
  readonly target: ThreadOpenTarget;
  readonly currentThreadRef?: ScopedThreadRef | null;
  readonly replace?: boolean;
}): Promise<void> {
  const routeRef = scopeThreadRef(input.environmentId, input.target.routeThreadId);
  if (input.target.sideChatThreadId !== null) {
    revealSideChat(routeRef, input.target.sideChatThreadId);
  }
  if (
    input.currentThreadRef &&
    scopedThreadKey(input.currentThreadRef) === scopedThreadKey(routeRef)
  ) {
    return;
  }
  await input.navigate({
    to: "/$environmentId/$threadId",
    params: buildThreadRouteParams(routeRef),
    ...(input.replace ? { replace: true } : {}),
  });
}

/** A side chat's activity shows in its lesson's panel, so the lesson being on screen is enough. */
export function isSideChatNotificationQuiet(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: SideChatLink;
  readonly activeEnvironmentId: string | undefined;
  readonly activeThreadId: string | undefined;
  readonly documentActive: boolean;
}): boolean {
  const lessonThreadId = input.thread.sideChat?.lessonThreadId;
  return (
    lessonThreadId !== undefined &&
    input.documentActive &&
    input.activeEnvironmentId === input.environmentId &&
    input.activeThreadId === lessonThreadId
  );
}

/** The side chat the panel's active tab shows, while that side chat is still open. */
export function resolveFinishableSideChat(input: {
  readonly surfaces: ReadonlyArray<RightPanelSurface>;
  readonly activeSurfaceId: string | null;
  readonly shells: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "id" | "sideChat">>;
  readonly environmentId: EnvironmentId;
}): {
  readonly threadId: ThreadId;
  readonly label: string;
  readonly surface: SideChatSurface;
  readonly finished: boolean;
} | null {
  const surface = input.surfaces.find((entry) => entry.id === input.activeSurfaceId);
  if (surface?.kind !== "lesson-side-chat") return null;
  const shell = input.shells.find(
    (entry) => entry.environmentId === input.environmentId && entry.id === surface.threadId,
  );
  const sideChat = shell?.sideChat;
  if (shell === undefined || sideChat == null) return null;
  return {
    threadId: shell.id,
    label: sideChat.label,
    surface,
    finished: sideChat.state === "done",
  };
}
