import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { isListedThreadLineage } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import type { AtomRegistry } from "effect/reactivity";

import { useComposerDraftStore } from "../composerDraftStore";
import { createLiveRegion } from "../hooks/useLiveRegion";
import { liveShellEnvironmentIdsAtom } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "../threadRoutes";
import {
  type BackgroundThreadMemory,
  type BackgroundThreadSnapshot,
  nextBackgroundThreadAnnouncement,
  resolveBackgroundThreadRequest,
} from "./backgroundThreadAnnouncement";

const backgroundThreadLiveRegion = createLiveRegion();
const attachBackgroundThreadRegion = backgroundThreadLiveRegion.attach;

function readOpenThreadKey(router: AnyRouter): string | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const draft =
    target?.kind === "draft"
      ? useComposerDraftStore.getState().getDraftSession(target.draftId)
      : null;
  const ref = resolveActiveThreadRouteRef(target, draft);
  return ref === null ? null : scopedThreadKey(ref);
}

/** Speaks status changes for threads other than the open one, for the life of the app. */
export function startBackgroundThreadAnnouncements(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  let memory: BackgroundThreadMemory = new Map();
  let openThreadKey = readOpenThreadKey(router);

  const update = () => {
    const threads = registry.get(environmentThreadShells.quietThreadShellsAtom);
    const liveEnvironmentIds = registry.get(liveShellEnvironmentIdsAtom);
    const now = new Date().toISOString();
    const snapshots: BackgroundThreadSnapshot[] = [];
    for (const thread of threads) {
      // Subagents and side chats have no row of their own; their requests surface on the parent.
      if (thread.archivedAt !== null || !isListedThreadLineage(thread.lineage)) continue;
      if (!liveEnvironmentIds.has(thread.environmentId)) continue;
      snapshots.push({
        key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        title: thread.title,
        ...resolveBackgroundThreadRequest(thread),
        runId: thread.latestRun?.runId ?? null,
        runStatus: thread.latestRun?.status ?? null,
        activeRunId: thread.runtime?.activeRunId ?? null,
        snoozed: effectiveSnoozed(thread, { now }),
      });
    }
    const next = nextBackgroundThreadAnnouncement(memory, snapshots, openThreadKey);
    memory = next.memory;
    if (next.announcement !== null) backgroundThreadLiveRegion.announce(next.announcement);
  };

  // The draft store changes on every keystroke; only a new open thread matters here.
  const updateOpenThread = () => {
    const next = readOpenThreadKey(router);
    if (next === openThreadKey) return;
    openThreadKey = next;
    update();
  };

  const unsubscribes = [
    registry.subscribe(environmentThreadShells.quietThreadShellsAtom, update),
    registry.subscribe(liveShellEnvironmentIdsAtom, update),
    router.subscribe("onResolved", updateOpenThread),
    useComposerDraftStore.subscribe(updateOpenThread),
  ];
  update();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/**
 * The region the background announcements are spoken through. It lives outside
 * the sidebar because a collapsed sidebar is inert, which silences its rows.
 */
export function BackgroundThreadAnnouncer() {
  // No role="status": Orca 50 maps it to a status bar in Chromium and drops its updates.
  return <div ref={attachBackgroundThreadRegion} aria-live="polite" className="sr-only" />;
}
