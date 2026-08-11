import type { DesktopNotificationKind, ScopedThreadRef } from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { projectThreadAwareness, type AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";

/**
 * Phases a thread must be leaving for its next phase to be worth announcing.
 * Requiring an active predecessor is what makes a thread that is merely
 * *observed* as finished (a cached snapshot, a resync, a reconnect) stay quiet:
 * nothing happened, we just learned about it.
 */
const ACTIVE_PHASES: ReadonlySet<AgentAwarenessPhase> = new Set([
  "starting",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
]);

/** Phases that can precede an approval prompt and still count as progress. */
const PRE_APPROVAL_PHASES: ReadonlySet<AgentAwarenessPhase> = new Set([
  "starting",
  "running",
  "waiting_for_input",
]);

/** macOS truncates long bodies anyway, and this rides a hot IPC path. */
const MAX_BODY_LENGTH = 180;

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
}

export interface ReconcileThreadNotificationsResult {
  readonly notifications: ReadonlyArray<PendingThreadNotification>;
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
  if (previousPhase === null || nextPhase === null) {
    return null;
  }
  if (nextPhase === "completed" && ACTIVE_PHASES.has(previousPhase)) {
    return "task-completed";
  }
  if (nextPhase === "failed" && ACTIVE_PHASES.has(previousPhase)) {
    return "task-failed";
  }
  if (nextPhase === "waiting_for_approval" && PRE_APPROVAL_PHASES.has(previousPhase)) {
    return "approval-needed";
  }
  return null;
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

function truncateBody(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_BODY_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_BODY_LENGTH - 3).trimEnd()}...`;
}

function sameThread(left: ScopedThreadRef, right: ScopedThreadRef): boolean {
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
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
    const phase = awareness?.phase ?? null;

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

    const detail = kind === "task-failed" ? awareness.detail : undefined;
    const bodyParts = [detail ?? awareness.headline];
    if (projectTitle.length > 0) {
      bodyParts.push(projectTitle);
    }

    notifications.push({
      kind,
      threadRef,
      title: awareness.threadTitle,
      body: truncateBody(bodyParts.join(" · ")),
    });
  }

  return { notifications, next };
}
