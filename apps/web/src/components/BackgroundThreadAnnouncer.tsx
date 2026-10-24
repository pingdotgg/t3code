import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useLiveRegion } from "../hooks/useLiveRegion";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useQuietThreadShells } from "../state/entities";
import { liveShellEnvironmentIdsAtom } from "../state/shell";
import { resolveActiveThreadRouteRef } from "../threadRoutes";
import {
  type BackgroundThreadMemory,
  type BackgroundThreadSnapshot,
  nextBackgroundThreadAnnouncement,
  resolveBackgroundThreadRequest,
} from "./backgroundThreadAnnouncement";

/**
 * Speaks status changes for threads other than the open one. It lives outside
 * the sidebar because a collapsed sidebar is inert, which silences its rows.
 */
export function BackgroundThreadAnnouncer() {
  const threads = useQuietThreadShells();
  const liveEnvironmentIds = useAtomValue(liveShellEnvironmentIdsAtom);
  const routeTarget = useThreadRouteTarget();
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const openThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
  const openThreadKey = openThreadRef === null ? null : scopedThreadKey(openThreadRef);
  const { regionRef, announce } = useLiveRegion();
  const memoryRef = useRef<BackgroundThreadMemory>(new Map());

  useEffect(() => {
    const now = new Date().toISOString();
    const snapshots: BackgroundThreadSnapshot[] = [];
    for (const thread of threads) {
      // Subagents have no row of their own; their requests surface on the parent.
      if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent")
        continue;
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
    const { memory, announcement } = nextBackgroundThreadAnnouncement(
      memoryRef.current,
      snapshots,
      openThreadKey,
    );
    memoryRef.current = memory;
    if (announcement !== null) announce(announcement);
  }, [threads, liveEnvironmentIds, openThreadKey, announce]);

  // No role="status": Orca 50 maps it to a status bar in Chromium and drops its updates.
  return <div ref={regionRef} aria-live="polite" className="sr-only" />;
}
