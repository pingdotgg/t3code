/**
 * OS-level notifications for turn completions.
 *
 * Tracks which threads are currently "running" and fires a browser
 * Notification when a thread transitions out of the running state
 * (i.e. the agent finished, was interrupted, errored, or was stopped).
 *
 * Notifications are only shown when the tab is not focused so the user
 * gets an ambient signal without being disrupted while actively watching.
 */
import type { OrchestrationEvent, OrchestrationSessionStatus, ThreadId } from "@t3tools/contracts";
import type { Thread, Project } from "./types";

// ── Running-thread tracker ──────────────────────────────────────────

const runningThreadIds = new Set<ThreadId>();

export function resetRunningThreadTracker(): void {
  runningThreadIds.clear();
}

/**
 * Replace the tracker with threads that are running in the given snapshot.
 * Call after each snapshot sync (bootstrap / recovery) so the set matches
 * server state and stale IDs from before a disconnect cannot produce false
 * completion transitions.
 */
export function seedRunningThreads(threads: readonly Thread[]): void {
  runningThreadIds.clear();
  for (const thread of threads) {
    if (thread.session?.orchestrationStatus === "running") {
      runningThreadIds.add(thread.id);
    }
  }
}

// ── Permission helpers ──────────────────────────────────────────────

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) {
    return Promise.resolve("denied" as NotificationPermission);
  }
  if (Notification.permission !== "default") {
    return Promise.resolve(Notification.permission);
  }
  return Notification.requestPermission();
}

// ── Notification body derivation ────────────────────────────────────

interface TurnCompletionInfo {
  threadId: ThreadId;
  threadTitle: string;
  projectName: string | null;
  status: OrchestrationSessionStatus;
}

const STATUS_LABELS: Partial<Record<OrchestrationSessionStatus, string>> = {
  idle: "completed",
  ready: "completed",
  interrupted: "interrupted",
  stopped: "stopped",
  error: "failed",
};

/**
 * Scans an event batch for `thread.session-set` transitions that signal
 * a thread leaving the "running" state. Returns one entry per such
 * transition, enriched with thread/project metadata from the store.
 *
 * Detection uses two sources:
 *  1. The in-memory `runningThreadIds` set (populated from earlier event
 *     batches and snapshot seeding).
 *  2. The store's current `orchestrationStatus` for the thread (covers
 *     cases where the running state was set before we started tracking,
 *     e.g. snapshot bootstrap or same-batch transitions).
 */
export function extractTurnCompletions(
  events: readonly OrchestrationEvent[],
  getThread: (id: ThreadId) => Thread | undefined,
  getProject: (id: string) => Project | undefined,
): TurnCompletionInfo[] {
  const completions: TurnCompletionInfo[] = [];

  for (const event of events) {
    if (event.type !== "thread.session-set") {
      continue;
    }

    const { threadId } = event.payload;
    const status = event.payload.session.status;

    if (status === "running") {
      runningThreadIds.add(threadId);
      continue;
    }

    // "starting" is a transient pre-run state — never a completion.
    if (status === "starting") {
      continue;
    }

    // Check both the in-memory tracker AND the store's current state so
    // we catch transitions that started before our subscription (e.g.
    // snapshot-bootstrapped sessions or page refreshes).
    const wasRunning =
      runningThreadIds.has(threadId) ||
      getThread(threadId)?.session?.orchestrationStatus === "running";

    if (!wasRunning) {
      continue;
    }
    runningThreadIds.delete(threadId);

    const thread = getThread(threadId);
    const project = thread ? getProject(thread.projectId) : undefined;

    completions.push({
      threadId,
      threadTitle: thread?.title ?? "Thread",
      projectName: project?.name ?? null,
      status,
    });
  }

  return completions;
}

// ── Notification dispatch ───────────────────────────────────────────

function buildNotificationContent(info: TurnCompletionInfo): { title: string; body: string } {
  const statusLabel = STATUS_LABELS[info.status] ?? info.status;
  return {
    title: `Turn ${statusLabel}`,
    body: info.projectName ? `${info.threadTitle} — ${info.projectName}` : info.threadTitle,
  };
}

/**
 * Whether the user is actively looking at the page.
 *
 * Uses `document.hasFocus()` (detects if the browser window has OS-level
 * focus) combined with `document.hidden` (detects if the tab is visible).
 * This correctly identifies the case where the tab is visible but the
 * user switched to a different application window.
 */
function isPageActivelyFocused(): boolean {
  if (typeof document === "undefined") return false;
  return document.hasFocus() && !document.hidden;
}

/**
 * Fires an OS-level notification when the user is not actively focused
 * on the page, and returns the content so the caller can fall back to
 * an in-app toast when the page is focused or the OS channel is
 * unavailable.
 */
export function showTurnCompletionNotification(info: TurnCompletionInfo): {
  title: string;
  body: string;
  osNotificationSent: boolean;
} {
  const content = buildNotificationContent(info);

  if (
    isPageActivelyFocused() ||
    !notificationsSupported() ||
    Notification.permission !== "granted"
  ) {
    return { ...content, osNotificationSent: false };
  }

  try {
    // eslint-disable-next-line no-new -- Notification is intentionally fire-and-forget.
    new Notification(content.title, {
      body: content.body,
      tag: `t3-turn-${info.threadId}`,
      icon: "/favicon.svg",
    });
    return { ...content, osNotificationSent: true };
  } catch {
    // Notification constructor can throw in restricted contexts (e.g. some
    // sandboxed iframes). Fall back to in-app toast via caller.
    return { ...content, osNotificationSent: false };
  }
}
