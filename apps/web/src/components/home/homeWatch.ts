import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  type HomeSettings,
  type HomeWatchEvent,
  isHomeThreadId,
  type ThreadId,
} from "@t3tools/contracts";

import { resolveSidebarThreadStatus } from "../Sidebar.logic";

export interface WatchedThreadState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly attention: string | null;
  readonly completion: number | null;
  readonly ended: boolean;
  /** Set once a launch watch added after start-up has been compared with an empty state. */
  readonly launchSeen: boolean;
}

export const homeWatchKey = (environmentId: string, threadId: string) =>
  `${environmentId}\u0000${threadId}`;

const UNSEEN = { attention: null, completion: null, ended: false };

/**
 * Compares the threads Home watches with the last pass and returns what Home
 * should hear about. Uses the same transitions as desktop notifications.
 *
 * A thread seen for the first time only sets a baseline, so opening the app
 * never replays old state. The exception is a thread Home launched after the
 * reporter started (its watch is not in `knownWatchKeys`): it can ask or fail
 * before its watch arrives, so the first pass that sees it watched compares
 * it with an empty state.
 *
 * A first look at a thread only counts in a live environment's list. A cached
 * or offline list proves nothing, so threads seen before keep their last state
 * there. In a live list, a watched thread that is missing (archived or
 * deleted) or settled ends its watch. That covers a thread seen before, and a
 * watch that existed at start-up.
 */
export function diffWatchedThreads(input: {
  readonly previous: ReadonlyMap<string, WatchedThreadState>;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly home: HomeSettings;
  readonly knownWatchKeys: ReadonlySet<string>;
  readonly liveEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly labelFor: (environmentId: EnvironmentId) => string | undefined;
}): { readonly next: Map<string, WatchedThreadState>; readonly events: Array<HomeWatchEvent> } {
  const watches = new Map(
    input.home.watches.map((watch) => [homeWatchKey(watch.environmentId, watch.threadId), watch]),
  );
  const present = new Set<string>();
  const next = new Map<string, WatchedThreadState>();
  const events: Array<HomeWatchEvent> = [];
  const eventBase = (state: WatchedThreadState) => {
    const label = input.labelFor(state.environmentId);
    return {
      environmentId: state.environmentId,
      threadId: state.threadId,
      title: state.title.slice(0, 300),
      ...(label === undefined ? {} : { environmentLabel: label.slice(0, 200) }),
    };
  };
  for (const thread of input.shells) {
    const key = homeWatchKey(thread.environmentId, thread.id);
    present.add(key);
    // Home never wakes for itself, an older Home, or subagent plumbing.
    if (isHomeThreadId(thread.id) || thread.lineage.relationshipToParent === "subagent") continue;
    const watch = watches.get(key);
    if (!input.home.watchAll && watch === undefined) continue;
    let status = resolveSidebarThreadStatus(thread);
    if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
    const fresh = watch?.reason === "launched" && !input.knownWatchKeys.has(key);
    const seen = input.previous.get(key);
    // A first look counts only in a live list; a cached one may be stale.
    if (seen === undefined && !input.liveEnvironmentIds.has(thread.environmentId)) continue;
    const prior = fresh && seen?.launchSeen !== true ? UNSEEN : seen;
    const attentionKind =
      status === "approval"
        ? "approval"
        : status === "input"
          ? "question"
          : status === "failed" || status === "limited"
            ? "failed"
            : null;
    const attention = attentionKind === null ? null : `${thread.latestRun?.runId ?? ""}:${status}`;
    const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
    const completion =
      status === "ready" && thread.latestRun?.status === "completed" && Number.isFinite(completedAt)
        ? completedAt
        : (prior?.completion ?? null);
    const ended = thread.archivedAt !== null || thread.settledOverride === "settled";
    const state = {
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: thread.title,
      attention,
      completion,
      ended,
      launchSeen: fresh,
    };
    next.set(key, state);
    if (prior === undefined) {
      // A start-up watch whose thread was settled while the app was closed.
      if (ended && watch !== undefined && input.knownWatchKeys.has(key)) {
        events.push({ ...eventBase(state), kind: "ended" });
      }
      continue;
    }
    if (ended) {
      if (!prior.ended && watch !== undefined) events.push({ ...eventBase(state), kind: "ended" });
      continue;
    }
    if (attentionKind !== null && attention !== prior.attention) {
      events.push({ ...eventBase(state), kind: attentionKind });
    } else if (
      completion !== null &&
      (prior.completion === null || completion > prior.completion)
    ) {
      events.push({ ...eventBase(state), kind: "completed" });
    }
  }
  // Threads that are watched or tracked but missing from the shell list.
  const missing = new Set([...watches.keys(), ...input.previous.keys()]);
  for (const key of missing) {
    if (present.has(key)) continue;
    const watch = watches.get(key);
    const seen = input.previous.get(key);
    const environmentId = watch?.environmentId ?? seen?.environmentId;
    if (environmentId === undefined || (watch === undefined && !input.home.watchAll)) continue;
    if (!input.liveEnvironmentIds.has(environmentId)) {
      if (seen !== undefined) next.set(key, seen);
      continue;
    }
    // A watch added after start-up may arrive before its thread does.
    if (watch === undefined || (seen === undefined && !input.knownWatchKeys.has(key))) continue;
    const state = seen ?? {
      environmentId,
      threadId: watch.threadId,
      title: "",
      ...UNSEEN,
      launchSeen: false,
    };
    // Keep the ended state until the watch is gone, so it is reported once.
    next.set(key, { ...state, ended: true });
    if (!state.ended) events.push({ ...eventBase(state), kind: "ended" });
  }
  return { next, events };
}
