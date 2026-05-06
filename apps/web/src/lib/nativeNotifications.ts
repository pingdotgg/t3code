import { OrchestrationSessionStatus, OrchestrationThreadActivity } from "@t3tools/contracts";
import { NotificationLevel } from "@t3tools/contracts/settings";

const IMPORTANT_ACTIVITY_KINDS = new Set(["approval.requested", "user-input.requested"]);
const VERBOSE_ACTIVITY_KINDS = new Set([
  ...IMPORTANT_ACTIVITY_KINDS,
  "task.started",
  "task.progress",
]);

export type NotifiableThread = {
  id: string;
  title: string;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  session:
    | {
        status: OrchestrationSessionStatus;
        activeTurnId?: string | null | undefined;
        lastError?: string | null | undefined;
      }
    | {
        orchestrationStatus: OrchestrationSessionStatus;
        activeTurnId?: string | null | undefined;
        lastError?: string | null | undefined;
      }
    | null;
};

export function isAppBackgrounded(): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "visible") return true;
  if (typeof document.hasFocus === "function") {
    return !document.hasFocus();
  }
  return false;
}

export function canShowNativeNotification(): boolean {
  if (typeof Notification === "undefined") return false;
  if (
    typeof window !== "undefined" &&
    (window.desktopBridge !== undefined || window.nativeApi !== undefined)
  ) {
    return true;
  }
  return Notification.permission === "granted";
}

export function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showNativeNotification(input: {
  title: string;
  body?: string;
  tag?: string;
}): boolean {
  if (!canShowNativeNotification()) return false;
  try {
    const options: NotificationOptions = {};
    if (input.body !== undefined) {
      options.body = input.body;
    }
    if (input.tag !== undefined) {
      options.tag = input.tag;
    }
    const notification = new Notification(input.title, options);
    void notification;
    return true;
  } catch {
    return false;
  }
}

export function resolveTurnCompletionNotification(input: {
  shouldNotify: boolean;
  level: NotificationLevel;
  thread: NotifiableThread;
  previous:
    | {
        status: OrchestrationSessionStatus;
        activeTurnId: string | null;
      }
    | undefined;
  lastNotifiedTurnId: string | undefined;
}): { title: string; body: string; tag: string; turnId: string } | null {
  const { shouldNotify, level, thread, previous, lastNotifiedTurnId } = input;
  const session = thread.session;
  const sessionStatus =
    session && "orchestrationStatus" in session ? session.orchestrationStatus : session?.status;
  const activeTurnId = session?.activeTurnId ?? null;

  if (
    !shouldNotify ||
    !session ||
    !previous ||
    previous.status !== "running" ||
    !previous.activeTurnId ||
    activeTurnId !== null ||
    (sessionStatus !== "ready" && sessionStatus !== "error")
  ) {
    return null;
  }

  if (level === NotificationLevel.Off) {
    return null;
  }

  if (sessionStatus === "ready" && level === NotificationLevel.Important) {
    return null;
  }

  if (lastNotifiedTurnId === previous.activeTurnId) {
    return null;
  }

  const title = sessionStatus === "error" ? "Task failed" : "Task completed";
  const lastError = "lastError" in session ? session.lastError : null;
  const detail = sessionStatus === "error" && lastError ? lastError : thread.title;
  const body = detail.length > 180 ? `${detail.slice(0, 177)}...` : detail;
  const tag = `t3code:${thread.id}:${previous.activeTurnId}:${sessionStatus}`;
  return { title, body, tag, turnId: previous.activeTurnId };
}

export function resolveAttentionNotification(input: {
  shouldNotify: boolean;
  level: NotificationLevel;
  thread: NotifiableThread;
  lastNotifiedActivityId: string | undefined;
}): { title: string; body: string; tag: string; activityId: string } | null {
  const { shouldNotify, level, thread, lastNotifiedActivityId } = input;
  if (!shouldNotify || level === NotificationLevel.Off) {
    return null;
  }

  const activityKinds =
    level === NotificationLevel.Verbose ? VERBOSE_ACTIVITY_KINDS : IMPORTANT_ACTIVITY_KINDS;
  const activity = findLatestActivity(thread.activities, activityKinds);
  if (!activity) return null;

  const activityId = String(activity.id);
  if (lastNotifiedActivityId === activityId) {
    return null;
  }

  const title = titleForActivity(activity);
  const body = activity.summary;
  const tag = `t3code:${thread.id}:${activityId}:${activity.kind}`;
  return { title, body, tag, activityId };
}

function findLatestActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  kinds: ReadonlySet<string>,
): OrchestrationThreadActivity | null {
  for (let i = activities.length - 1; i >= 0; i -= 1) {
    const activity = activities[i];
    if (!activity) {
      continue;
    }
    if (kinds.has(activity.kind)) {
      return activity;
    }
  }
  return null;
}

function titleForActivity(activity: OrchestrationThreadActivity): string {
  switch (activity.kind) {
    case "approval.requested":
      return "Approval required";
    case "user-input.requested":
      return "Input required";
    case "task.started":
      return "Task started";
    case "task.progress":
      return "Task update";
    case "task.completed":
      return "Task completed";
    default:
      return "Task update";
  }
}
