import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { DraftId } from "./composerDraftStore";

export type ThreadRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    };

type DraftThreadRouteState = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  promotedTo?: ScopedThreadRef | null;
};

export type ThreadRouteRenderState = "loading" | "ready" | "missing";

export function isThreadRouteSnapshotAuthoritative(
  status: EnvironmentShellStatus | undefined,
): boolean {
  return status === "live";
}

export function resolveThreadRouteRenderState(input: {
  bootstrapComplete: boolean;
  serverThreadExists: boolean;
  serverThreadDeleted: boolean;
  draftThreadExists: boolean;
}): ThreadRouteRenderState {
  if (input.draftThreadExists || (input.serverThreadExists && !input.serverThreadDeleted)) {
    return "ready";
  }
  if (!input.bootstrapComplete) {
    return "loading";
  }
  return "missing";
}

export function buildThreadRouteParams(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  threadId: ThreadId;
} {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  };
}

export function buildDraftThreadRouteParams(draftId: DraftId): {
  draftId: DraftId;
} {
  return { draftId };
}

export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.environmentId || !params.threadId) {
    return null;
  }

  return scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId);
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
): ThreadRouteTarget | null {
  if (params.environmentId && params.threadId) {
    return {
      kind: "server",
      threadRef: scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId),
    };
  }

  if (!params.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: params.draftId as DraftId,
  };
}

export function threadRouteTargetKey(target: ThreadRouteTarget | null): string | null {
  if (target === null) return null;
  return target.kind === "server"
    ? `server:${scopedThreadKey(target.threadRef)}`
    : `draft:${target.draftId}`;
}

export function threadRouteTargetFromKey(key: string | null): ThreadRouteTarget | null {
  if (key === null) return null;
  if (key.startsWith("draft:")) {
    return { kind: "draft", draftId: key.slice("draft:".length) as DraftId };
  }
  const threadRef = key.startsWith("server:")
    ? parseScopedThreadKey(key.slice("server:".length))
    : null;
  return threadRef === null ? null : { kind: "server", threadRef };
}

/**
 * Resolves the thread represented by either a canonical thread route or a
 * draft route whose promotion to a server thread has been recorded.
 */
export function resolveActiveThreadRouteRef(
  target: ThreadRouteTarget | null,
  draftThread: DraftThreadRouteState | null,
): ScopedThreadRef | null {
  if (target?.kind === "server") {
    return target.threadRef;
  }
  if (target?.kind !== "draft" || !draftThread?.promotedTo) {
    return null;
  }
  return draftThread.promotedTo;
}

export interface KeptThreadView {
  /** Promotion preserves the draft's React key. */
  readonly key: string;
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Draft views are dropped once left. */
  readonly draftId: DraftId | null;
  readonly visit: number;
  /** Lay out a released thread out of sight before hiding it. */
  readonly warming?: boolean;
}

const KEPT_THREAD_VIEW_LIMIT = 4;

function retarget(
  view: KeptThreadView,
  active: Omit<KeptThreadView, "visit">,
  visit: number,
): KeptThreadView {
  return {
    ...view,
    environmentId: active.environmentId,
    threadId: active.threadId,
    threadKey: active.threadKey,
    draftId: active.draftId,
    visit,
  };
}

function leastRecentlyShown(views: ReadonlyArray<KeptThreadView>): KeptThreadView | null {
  return views.reduce<KeptThreadView | null>(
    (oldest, view) => (oldest !== null && oldest.visit <= view.visit ? oldest : view),
    null,
  );
}

export interface KeptThreadViewsUpdate {
  readonly views: ReadonlyArray<KeptThreadView>;
  /** Replaced thread, for idle warming with keepReleasedThreadView. */
  readonly released: KeptThreadView | null;
}

// Reuse the shown view on first opens to avoid mounting on the click path.
// Preserve entry order: moving rendered DOM loses scroll positions.
export function resolveKeptThreadViews(
  current: ReadonlyArray<KeptThreadView>,
  active: Omit<KeptThreadView, "visit"> | null,
  limit = KEPT_THREAD_VIEW_LIMIT,
): KeptThreadViewsUpdate {
  const unchanged = { views: current, released: null };
  const lastVisit = current.reduce((max, view) => Math.max(max, view.visit), 0);
  // Match promoted drafts by thread identity to preserve their view.
  const existing =
    active === null
      ? undefined
      : current.find((view) =>
          active.draftId === null ? view.threadKey === active.threadKey : view.key === active.key,
        );
  const servers = current.filter((view) => view.draftId === null && view !== existing);
  const same = (views: ReadonlyArray<KeptThreadView>) =>
    views.length === current.length && views.every((view, index) => view === current[index]);
  if (active === null) {
    return same(servers) ? unchanged : { views: servers, released: null };
  }
  if (existing !== undefined) {
    const visit = existing.visit === lastVisit ? lastVisit : lastVisit + 1;
    const refreshed =
      existing.draftId === active.draftId &&
      existing.environmentId === active.environmentId &&
      existing.threadId === active.threadId &&
      existing.visit === visit &&
      existing.warming !== true
        ? existing
        : { ...retarget(existing, active, visit), warming: false };
    const views = current.flatMap((view) =>
      view === existing ? [refreshed] : view.draftId === null ? [view] : [],
    );
    return same(views) ? unchanged : { views, released: null };
  }
  const visit = lastVisit + 1;
  const shown = current.find((view) => view.visit === lastVisit && view.warming !== true);
  if (active.draftId === null) {
    if (shown !== undefined && shown.draftId === null) {
      return {
        views: servers.map((view) => (view === shown ? retarget(view, active, visit) : view)),
        released: shown,
      };
    }
    const recycled = leastRecentlyShown(servers.filter((view) => view.warming !== true));
    if (recycled !== null) {
      return {
        views: servers.map((view) => (view === recycled ? retarget(view, active, visit) : view)),
        released: null,
      };
    }
  }
  let views: ReadonlyArray<KeptThreadView> = [
    ...servers,
    { ...active, key: active.draftId ?? `view:${active.threadKey}:${visit}`, visit },
  ];
  while (views.length > limit) {
    const evicted = leastRecentlyShown(views.slice(0, -1));
    if (evicted === null) break;
    views = views.filter((view) => view !== evicted);
  }
  return { views, released: null };
}

/** Warm released threads during idle time so revisits can reveal them. */
export function keepReleasedThreadView(
  current: ReadonlyArray<KeptThreadView>,
  released: KeptThreadView,
  limit = KEPT_THREAD_VIEW_LIMIT,
): ReadonlyArray<KeptThreadView> {
  if (limit < 2 || current.some((view) => view.threadKey === released.threadKey)) return current;
  const lastVisit = current.reduce((max, view) => Math.max(max, view.visit), 0);
  let views = current;
  while (views.length >= limit) {
    const evicted = leastRecentlyShown(views.filter((view) => view.visit !== lastVisit));
    if (evicted === null) return current;
    views = views.filter((view) => view !== evicted);
  }
  return [
    ...views,
    {
      ...released,
      key: `kept:${released.threadKey}:${released.visit}`,
      draftId: null,
      warming: true,
    },
  ];
}

export function finishWarmingThreadView(
  current: ReadonlyArray<KeptThreadView>,
  key: string,
): ReadonlyArray<KeptThreadView> {
  return current.some((view) => view.key === key && view.warming === true)
    ? current.map((view) => (view.key === key ? { ...view, warming: false } : view))
    : current;
}
