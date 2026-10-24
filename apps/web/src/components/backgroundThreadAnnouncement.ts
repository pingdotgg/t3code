import type { OrchestrationV2RunStatus, RunId } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";
import { runOutcomeText, THREAD_STATUS_TEXT } from "./chat/threadActivityAnnouncement";

export interface BackgroundThreadSnapshot {
  readonly key: string;
  readonly title: string;
  readonly request: "approval" | "input" | null;
  /** Null for a subagent's request, which the parent's shell only knows by kind. */
  readonly requestId: string | null;
  readonly runId: RunId | null;
  readonly runStatus: OrchestrationV2RunStatus | null;
  /** The run doing work now, which can be older than a queued run cancelled while it ran. */
  readonly activeRunId: RunId | null;
  /** A snoozed thread stays hidden until its timer, so it stays quiet too. */
  readonly snoozed: boolean;
}

/** The request and its id come from the same source, so a subagent's request never takes the parent's id. */
export function resolveBackgroundThreadRequest(
  thread: Pick<
    SidebarThreadSummary,
    "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest"
  > & {
    readonly source: Pick<SidebarThreadSummary["source"], "pendingRuntimeRequest">;
  },
): Pick<BackgroundThreadSnapshot, "request" | "requestId"> {
  const ownRequestId = thread.source.pendingRuntimeRequest?.id ?? null;
  if (thread.hasPendingApprovals) return { request: "approval", requestId: ownRequestId };
  if (thread.pendingSubagentRequest === "approval") return { request: "approval", requestId: null };
  if (thread.hasPendingUserInput) return { request: "input", requestId: ownRequestId };
  if (thread.pendingSubagentRequest === "user_input") return { request: "input", requestId: null };
  return { request: null, requestId: null };
}

interface BackgroundThreadMemoryEntry {
  readonly request: BackgroundThreadSnapshot["request"];
  readonly requestId: string | null;
  /** The last run whose ending is known, so each run's ending is announced once. */
  readonly settledRunId: RunId | null;
}

export type BackgroundThreadMemory = ReadonlyMap<string, BackgroundThreadMemoryEntry>;

/**
 * Decides what a screen reader hears when a thread other than the open one
 * asks for something or ends a run. `threads` holds only threads whose
 * environment is live, so a thread is silent the first time it's seen:
 * opening the app or reconnecting takes a baseline instead of reading out
 * every thread.
 */
export function nextBackgroundThreadAnnouncement(
  previous: BackgroundThreadMemory,
  threads: ReadonlyArray<BackgroundThreadSnapshot>,
  openThreadKey: string | null,
): { readonly memory: BackgroundThreadMemory; readonly announcement: string | null } {
  const memory = new Map<string, BackgroundThreadMemoryEntry>();
  const announcements: string[] = [];
  for (const thread of threads) {
    const before = previous.get(thread.key);
    const outcome = runOutcomeText(thread.runStatus);
    const settled = outcome !== null || thread.runStatus === "rolled_back";
    memory.set(thread.key, {
      request: thread.request,
      requestId: thread.requestId,
      settledRunId: settled ? thread.runId : (before?.settledRunId ?? null),
    });
    if (before === undefined || thread.key === openThreadKey || thread.snoozed) continue;
    if (
      thread.request !== null &&
      (thread.request !== before.request || thread.requestId !== before.requestId)
    ) {
      announcements.push(`${THREAD_STATUS_TEXT[thread.request]}: ${thread.title}`);
    }
    // While another run still works, the latest run's ending (a queued message
    // cancelled before it started) isn't the thread finishing. The shell then
    // only reports the latest run, so the working run's own ending stays quiet.
    const anotherRunWorking = thread.activeRunId !== null && thread.activeRunId !== thread.runId;
    if (outcome !== null && thread.runId !== before.settledRunId && !anotherRunWorking) {
      announcements.push(`${outcome}: ${thread.title}`);
    }
  }
  return {
    memory,
    announcement: announcements.length === 0 ? null : announcements.join(". "),
  };
}
