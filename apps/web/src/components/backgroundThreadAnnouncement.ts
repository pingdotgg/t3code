import type { OrchestrationV2RunStatus, RunId } from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  monitorHoldsWakeCompletion,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";
import type { SidebarThreadSummary } from "../types";
import {
  runOutcomeText,
  THREAD_STATUS_TEXT,
} from "@t3tools/client-runtime/state/thread-activity-announcement";

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

/** Suppresses Done announcements for stopped runs, awaited background work, and monitor wakes. */
export function resolveBackgroundThreadRunStatus(thread: {
  readonly latestRun: { readonly status: OrchestrationV2RunStatus } | null;
  readonly pendingBackgroundTasks: SidebarThreadSummary["pendingBackgroundTasks"];
  readonly source: Pick<
    SidebarThreadSummary["source"],
    "latestRunBackgroundWake" | "latestRunStopRequested" | "pendingBackgroundTasks"
  >;
}): OrchestrationV2RunStatus | null {
  const status = thread.latestRun?.status ?? null;
  if (
    status === "completed" &&
    (thread.source.latestRunStopRequested === true ||
      backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks) ||
      monitorHoldsWakeCompletion(thread.source))
  ) {
    return null;
  }
  return status;
}

interface BackgroundThreadMemoryEntry {
  readonly request: BackgroundThreadSnapshot["request"];
  readonly requestId: string | null;
  /** The last run whose ending is known, so each run's ending is announced once. */
  readonly settledRunId: RunId | null;
}

export type BackgroundThreadMemory = ReadonlyMap<string, BackgroundThreadMemoryEntry>;

/**
 * Only live environments supply threads. First sightings establish a silent baseline
 * so opening the app or reconnecting does not read out every thread.
 */
export function nextBackgroundThreadAnnouncement(
  previous: BackgroundThreadMemory,
  threads: ReadonlyArray<BackgroundThreadSnapshot>,
  openThreadKey: string | null,
  resolve: MessageResolver = m,
): { readonly memory: BackgroundThreadMemory; readonly announcement: string | null } {
  const memory = new Map<string, BackgroundThreadMemoryEntry>();
  const announcements: string[] = [];
  for (const thread of threads) {
    const before = previous.get(thread.key);
    const outcome = runOutcomeText(thread.runStatus, resolve);
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
      announcements.push(
        resolve(
          msg("{status}: {title}", {
            status: resolve(THREAD_STATUS_TEXT[thread.request]),
            title: thread.title,
          }),
        ),
      );
    }
    // While another run still works, the latest run's ending (a queued message
    // cancelled before it started) isn't the thread finishing. The shell then
    // only reports the latest run, so the working run's own ending stays quiet.
    const anotherRunWorking = thread.activeRunId !== null && thread.activeRunId !== thread.runId;
    if (outcome !== null && thread.runId !== before.settledRunId && !anotherRunWorking) {
      announcements.push(
        resolve(msg("{status}: {title}", { status: outcome, title: thread.title })),
      );
    }
  }
  return {
    memory,
    announcement: announcements.length === 0 ? null : announcements.join(". "),
  };
}
