import type { DesktopNotificationKind, ScopedThreadRef } from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { projectThreadAwareness, type AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { agentNotificationKind } from "@t3tools/shared/agentNotifications";

import { notificationBody, notificationTitle } from "./notificationCopy";

export interface ThreadNotificationSettings {
  readonly enabled: boolean;
  readonly taskCompleted: boolean;
  readonly taskFailed: boolean;
  readonly approvalNeeded: boolean;
}

/**
 * threadKey -> the phase we last observed. `null` is a real value (the thread
 * exists but has no resolvable phase); collapsing it into "absent" would let
 * `completed -> null -> completed` fire a second time.
 */
export type ThreadPhaseSnapshot = ReadonlyMap<string, AgentAwarenessPhase | null>;

export const EMPTY_THREAD_PHASE_SNAPSHOT: ThreadPhaseSnapshot = new Map();

export interface PendingThreadNotification {
  readonly kind: DesktopNotificationKind;
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly body: string;
}

export interface ReconcileThreadNotificationsInput {
  readonly previous: ThreadPhaseSnapshot;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** scoped project key -> title. A miss only costs the project name in the body. */
  readonly projectTitles: ReadonlyMap<string, string>;
  readonly settings: ThreadNotificationSettings;
  readonly windowFocused: boolean;
  readonly activeThreadRef: ScopedThreadRef | null;
  /**
   * The agent's latest assistant text for a thread, when it is already in
   * memory. Optional and allowed to return null: resolving it must never
   * force a thread subscription just to build a notification body.
   */
  readonly readResponseText?: (ref: ScopedThreadRef) => string | null;
}

export interface ReconcileThreadNotificationsResult {
  readonly notifications: ReadonlyArray<PendingThreadNotification>;
  /**
   * Whether to play the in-app alert chime for this batch.
   *
   * Once per batch, not once per notification: three threads finishing
   * together is one event to the user, and three overlapping chimes is a
   * malfunction. Only set while the window is unfocused — the sound exists to
   * reach someone who is looking elsewhere.
   */
  readonly playAlertSound: boolean;
  readonly next: ThreadPhaseSnapshot;
}

export function threadNotificationKey(ref: ScopedThreadRef): string {
  return `${ref.environmentId}:${ref.threadId}`;
}

export function projectTitleKey(ref: {
  readonly environmentId: string;
  readonly projectId: string;
}): string {
  return `${ref.environmentId}:${ref.projectId}`;
}

export function buildProjectTitleMap(
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  for (const project of projects) {
    titles.set(
      projectTitleKey({ environmentId: project.environmentId, projectId: project.id }),
      project.title,
    );
  }
  return titles;
}

export function notifiableKind(
  previousPhase: AgentAwarenessPhase | null,
  nextPhase: AgentAwarenessPhase | null,
): DesktopNotificationKind | null {
  return agentNotificationKind(previousPhase, nextPhase);
}

function isNotificationKindEnabled(
  kind: DesktopNotificationKind,
  settings: ThreadNotificationSettings,
): boolean {
  switch (kind) {
    case "task-completed":
      return settings.taskCompleted;
    case "task-failed":
      return settings.taskFailed;
    case "approval-needed":
      return settings.approvalNeeded;
  }
}

function sameThread(left: ScopedThreadRef, right: ScopedThreadRef): boolean {
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

/**
 * Holds a thread at "running" while native background work is still alive.
 *
 * `projectThreadAwareness` reads a session sitting at `ready`/`idle` with
 * nothing pending as finished, which is right for a thread that has genuinely
 * stopped. But a provider also parks the session at `ready` *between* turns
 * while subagents, workflows, or watch loops keep going, so a long task
 * momentarily looks complete and would fire a "Completed" notification while
 * it is still working. The sidebar already resolves this the same way
 * (`resolveSidebarThreadStatus` prefers `backgroundLiveness` over `ready`);
 * this keeps the notification view consistent with what the user sees there.
 */
export function resolveNotifiablePhase(
  thread: Pick<EnvironmentThreadShell, "backgroundLiveness">,
  phase: AgentAwarenessPhase | null,
): AgentAwarenessPhase | null {
  if (phase !== "completed") {
    return phase;
  }
  const liveness = thread.backgroundLiveness ?? null;
  return liveness === "working" || liveness === "monitoring" ? "running" : phase;
}

/**
 * Reconciles the previously observed thread phases against the current shells
 * and returns the notifications to raise plus the phase map to carry forward.
 *
 * Two invariants keep this quiet in the cases that matter:
 *
 * 1. A thread absent from `previous` is recorded and never fires. That single
 *    rule covers first mount, an environment connecting late, a cached snapshot
 *    hydrating, and a brand-new thread, with no bootstrap flag or timer.
 * 2. `next` always advances, even when a notification is filtered out by the
 *    settings or the focus check. Suppressing the banner must not leave the
 *    transition pending, or it would fire later when the user navigates away or
 *    flips a toggle on.
 */
export function reconcileThreadNotifications(
  input: ReconcileThreadNotificationsInput,
): ReconcileThreadNotificationsResult {
  const next = new Map<string, AgentAwarenessPhase | null>();
  const notifications: PendingThreadNotification[] = [];

  for (const thread of input.threads) {
    // Archived threads are already dropped from the server snapshot; this keeps
    // the invariant local so a projection change can't start raising banners
    // for threads the user has filed away.
    if (thread.archivedAt !== null) {
      continue;
    }

    const threadRef: ScopedThreadRef = {
      environmentId: thread.environmentId,
      threadId: thread.id,
    };
    const key = threadNotificationKey(threadRef);
    const projectTitle =
      input.projectTitles.get(
        projectTitleKey({ environmentId: thread.environmentId, projectId: thread.projectId }),
      ) ?? "";
    const awareness = projectThreadAwareness({
      environmentId: thread.environmentId,
      project: { title: projectTitle },
      thread,
    });
    const phase = resolveNotifiablePhase(thread, awareness?.phase ?? null);

    const seen = input.previous.has(key);
    const previousPhase = seen ? (input.previous.get(key) ?? null) : null;
    next.set(key, phase);

    if (!seen || previousPhase === phase) {
      continue;
    }

    const kind = notifiableKind(previousPhase, phase);
    if (kind === null || awareness === null) {
      continue;
    }

    if (!input.settings.enabled || !isNotificationKindEnabled(kind, input.settings)) {
      continue;
    }

    // The user is already watching this exact thread, so the banner would tell
    // them something they can see. Any other case (another thread, settings,
    // another app entirely) still notifies.
    const watchingThisThread =
      input.windowFocused &&
      input.activeThreadRef !== null &&
      sameThread(input.activeThreadRef, threadRef);
    if (watchingThisThread) {
      continue;
    }

    // A failure's error text is more useful than its last assistant message.
    const responseText =
      kind === "task-failed"
        ? (awareness.detail ?? input.readResponseText?.(threadRef) ?? null)
        : (input.readResponseText?.(threadRef) ?? null);

    notifications.push({
      kind,
      threadRef,
      title: notificationTitle(kind, projectTitle),
      body: notificationBody({
        responseText,
        threadTitle: awareness.threadTitle,
        fallbackHeadline: awareness.headline,
      }),
    });
  }

  // The chime is the one signal Do Not Disturb cannot swallow, so it is tied
  // to the window being unfocused rather than to the banner being shown.
  return { notifications, playAlertSound: notifications.length > 0 && !input.windowFocused, next };
}
