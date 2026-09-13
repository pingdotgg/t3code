import type { ClientSettings } from "@t3tools/contracts/settings";
import type { OrchestrationThreadShell, ThreadGoal, TurnId } from "@t3tools/contracts";
import type { SidebarThreadStatus } from "./components/Sidebar.logic";

import completionUrl from "./assets/notification-completion.mp3";
import inputUrl from "./assets/notification-input.mp3";

type NotificationMode = ClientSettings["notificationMode"];

export interface ThreadNotificationSnapshot {
  input: string | null;
  completion: number | null;
  goal: Pick<ThreadGoal, "createdAt" | "status"> | null;
  suppressedTurnId: TurnId | null;
  baselineGoalUpdatedAt: string | null;
}

const goalNotificationTitles: Partial<Record<ThreadGoal["status"], string>> = {
  complete: "Goal completed",
  blocked: "Goal needs attention",
  budgetLimited: "Goal budget reached",
  usageLimited: "Goal usage limit reached",
};

export function resolveThreadNotification(
  thread: Pick<OrchestrationThreadShell, "goal" | "latestTurn" | "session" | "title">,
  status: SidebarThreadStatus,
  prior: ThreadNotificationSnapshot | undefined,
): {
  snapshot: ThreadNotificationSnapshot;
  notification: { kind: "completion" | "input"; title: string; body: string } | null;
} {
  const goal = thread.goal ?? null;
  const input =
    status === "input" || status === "approval" || status === "failed"
      ? `${thread.latestTurn?.turnId ?? ""}:${status}`
      : null;
  const completedAt = Date.parse(thread.latestTurn?.completedAt ?? "");
  const completion =
    status === "ready" && thread.latestTurn?.state === "completed" && Number.isFinite(completedAt)
      ? completedAt
      : (prior?.completion ?? null);
  const goalTitle =
    goal &&
    prior &&
    (goal.createdAt !== prior.goal?.createdAt || goal.status !== prior.goal?.status)
      ? goalNotificationTitles[goal.status]
      : undefined;
  // The native turn disappears from the session before its checkpoint reaches
  // latestTurn. Keep its identity through that gap, including after clear/pause.
  const suppressedTurnId =
    goal?.status === "active" || goalTitle
      ? (thread.session?.activeTurnId ??
        prior?.suppressedTurnId ??
        thread.latestTurn?.turnId ??
        null)
      : (prior?.suppressedTurnId ?? null);
  // A retained terminal goal at reconnect does not own a newer manual turn.
  // Keep its cutoff through clear until the delayed checkpoint identifies when
  // the finishing turn began.
  const baselineGoalUpdatedAt = prior
    ? prior.baselineGoalUpdatedAt
    : goal?.status !== "active"
      ? (goal?.updatedAt ?? null)
      : null;
  const baselineGoalCompletion =
    baselineGoalUpdatedAt !== null &&
    Date.parse(thread.latestTurn?.requestedAt ?? "") <= Date.parse(baselineGoalUpdatedAt);
  const snapshot = { input, completion, goal, suppressedTurnId, baselineGoalUpdatedAt };
  if (!prior) return { snapshot, notification: null };
  if (input && input !== prior.input) {
    return {
      snapshot,
      notification: {
        kind: "input",
        title:
          status === "approval"
            ? "Approval needed"
            : status === "failed"
              ? "Thread failed"
              : "Input needed",
        body: thread.title,
      },
    };
  }
  if (goalTitle && goal) {
    return {
      snapshot,
      notification: {
        kind: goal.status === "complete" ? "completion" : "input",
        title: goalTitle,
        body: `${thread.title}\n${goal.lastReason || goal.objective}`,
      },
    };
  }
  if (
    completion !== null &&
    (prior.completion === null || completion > prior.completion) &&
    goal?.status !== "active" &&
    !baselineGoalCompletion &&
    thread.latestTurn?.turnId !== suppressedTurnId
  ) {
    return {
      snapshot,
      notification: { kind: "completion", title: "Thread completed", body: thread.title },
    };
  }
  return { snapshot, notification: null };
}

export const NOTIFICATION_MODE_LABELS = {
  off: "Off",
  notifications: "Notifications only",
  sound: "Sound only",
  "notifications-and-sound": "Notifications with sound",
} satisfies Record<NotificationMode, string>;

export function hasNotificationSound(mode: NotificationMode) {
  return mode === "sound" || mode === "notifications-and-sound";
}

export function hasDesktopNotifications(mode: NotificationMode) {
  return mode === "notifications" || mode === "notifications-and-sound";
}

let originalFavicon: HTMLLinkElement | undefined;
let badgeFavicon: HTMLLinkElement | undefined;

export function setNotificationBadge(count: number) {
  const bridge = window.desktopBridge;
  let image: string | null = null;
  if (count > 0 && (!bridge || bridge.getClientPlatform?.() === "win32")) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#e5484d";
      context.beginPath();
      context.arc(32, 32, 28, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "white";
      context.font = `600 ${count > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(count > 9 ? "9+" : String(count), 32, 34);
      image = canvas.toDataURL("image/png");
    }
  }
  if (!bridge) {
    if (image) {
      if (!badgeFavicon) {
        originalFavicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? undefined;
        badgeFavicon = document.createElement("link");
        badgeFavicon.rel = "icon";
        badgeFavicon.type = "image/png";
        badgeFavicon.sizes.value = "64x64";
        originalFavicon?.remove();
        document.head.append(badgeFavicon);
      }
      badgeFavicon.href = image;
    } else if (badgeFavicon) {
      badgeFavicon.remove();
      badgeFavicon = undefined;
      if (originalFavicon) document.head.append(originalFavicon);
      originalFavicon = undefined;
    }
  }
  void bridge?.setNotificationBadge?.({ count, image }).catch(() => undefined);
}

let audioContext: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();

/** Called from a gesture so browsers allow later background playback. */
export function unlockNotificationAudio() {
  audioContext ??= new AudioContext();
  void audioContext.resume().catch(() => undefined);
}

export async function playNotificationSound(
  kind: "completion" | "input",
  shouldPlay: () => boolean,
) {
  if (!audioContext || audioContext.state !== "running") return;
  const context = audioContext;
  const url = kind === "completion" ? completionUrl : inputUrl;
  try {
    let buffer = buffers.get(url);
    if (!buffer) {
      buffer = fetch(url)
        .then((response) => response.arrayBuffer())
        .then((data) => context.decodeAudioData(data));
      buffers.set(url, buffer);
    }
    const decoded = await buffer;
    if (!shouldPlay() || context.state !== "running") return;
    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(context.destination);
    source.start();
  } catch {
    buffers.delete(url);
  }
}
