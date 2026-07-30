/**
 * Thread-attention notifications (Forma).
 *
 * Tracks per-thread pending-approval / pending-user-input state and raises a
 * notification the first time a thread enters an attention state while the
 * window is backgrounded. Delivery prefers the desktop bridge when the host
 * exposes a `notifyThreadAttention` hook (guarded by existence checks — it is
 * not part of the stock desktop IPC surface) and falls back to the browser
 * Notification API.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ClientSettings, EnvironmentId, ThreadId } from "@t3tools/contracts";

export type ThreadAttentionKind = "approval" | "user-input";

export interface ThreadAttentionNotificationInput {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  threadTitle: string;
  kind: ThreadAttentionKind;
}

type ThreadAttentionState = "approval" | "user-input" | "both" | null;

type ThreadAttentionRecord = {
  environmentId: EnvironmentId;
  state: ThreadAttentionState;
  notifiedKinds: Set<ThreadAttentionKind>;
  notifyingKinds: Set<ThreadAttentionKind>;
};

type ThreadAttentionSettings = Pick<
  ClientSettings,
  "desktopNotifyOnApprovalRequests" | "desktopNotifyOnUserInputRequests"
>;

export interface ThreadAttentionShellUpsert {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  threadTitle: string;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}

export interface ThreadAttentionNotificationDeps {
  isNotificationsAvailable?: () => boolean;
  isWindowBackgrounded?: () => boolean;
  notifyThreadAttention?: (input: ThreadAttentionNotificationInput) => Promise<boolean> | boolean;
}

const threadAttentionRecords = new Map<string, ThreadAttentionRecord>();

type DesktopThreadAttentionBridge = {
  notifyThreadAttention?: (input: ThreadAttentionNotificationInput) => Promise<boolean> | boolean;
};

function readDesktopThreadAttentionBridge(): DesktopThreadAttentionBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as { desktopBridge?: DesktopThreadAttentionBridge }).desktopBridge;
  return bridge && typeof bridge.notifyThreadAttention === "function" ? bridge : null;
}

function isBrowserNotificationsGranted(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

function getDefaultNotificationsAvailable(): boolean {
  return readDesktopThreadAttentionBridge() !== null || isBrowserNotificationsGranted();
}

function getDefaultWindowBackgrounded(): boolean {
  return (
    typeof document !== "undefined" &&
    (document.visibilityState !== "visible" || !document.hasFocus())
  );
}

export function threadAttentionNotificationTitle(kind: ThreadAttentionKind): string {
  return kind === "approval" ? "Approval requested" : "Waiting for your input";
}

function notifyViaBrowserNotification(input: ThreadAttentionNotificationInput): boolean {
  if (!isBrowserNotificationsGranted()) {
    return false;
  }
  try {
    // eslint-disable-next-line no-new
    new Notification(threadAttentionNotificationTitle(input.kind), {
      body: input.threadTitle,
      tag: `forma-thread-attention:${input.environmentId}:${input.threadId}:${input.kind}`,
    });
    return true;
  } catch {
    return false;
  }
}

function defaultNotifyThreadAttention(input: ThreadAttentionNotificationInput): Promise<boolean> {
  const bridge = readDesktopThreadAttentionBridge();
  if (bridge?.notifyThreadAttention) {
    return Promise.resolve(bridge.notifyThreadAttention(input)).catch(() =>
      notifyViaBrowserNotification(input),
    );
  }
  return Promise.resolve(notifyViaBrowserNotification(input));
}

function getThreadAttentionRecordKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function deriveThreadAttentionState(input: {
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}): ThreadAttentionState {
  if (input.hasPendingApprovals && input.hasPendingUserInput) {
    return "both";
  }
  if (input.hasPendingApprovals) {
    return "approval";
  }
  if (input.hasPendingUserInput) {
    return "user-input";
  }
  return null;
}

function getActiveThreadAttentionKinds(
  state: ThreadAttentionState,
): readonly ThreadAttentionKind[] {
  switch (state) {
    case "approval":
      return ["approval"];
    case "user-input":
      return ["user-input"];
    case "both":
      return ["approval", "user-input"];
    default:
      return [];
  }
}

function isThreadAttentionKindEnabled(
  kind: ThreadAttentionKind,
  settings: ThreadAttentionSettings,
): boolean {
  return kind === "approval"
    ? settings.desktopNotifyOnApprovalRequests
    : settings.desktopNotifyOnUserInputRequests;
}

function notifyForThreadAttentionKinds(
  key: string,
  record: ThreadAttentionRecord,
  input: ThreadAttentionShellUpsert,
  settings: ThreadAttentionSettings,
  deps?: ThreadAttentionNotificationDeps,
): void {
  const isNotificationsAvailable =
    deps?.isNotificationsAvailable ?? getDefaultNotificationsAvailable;
  const isWindowBackgrounded = deps?.isWindowBackgrounded ?? getDefaultWindowBackgrounded;
  const notifyThreadAttention = deps?.notifyThreadAttention ?? defaultNotifyThreadAttention;

  if (!isNotificationsAvailable() || !isWindowBackgrounded()) {
    return;
  }

  for (const kind of getActiveThreadAttentionKinds(record.state)) {
    if (
      !isThreadAttentionKindEnabled(kind, settings) ||
      record.notifiedKinds.has(kind) ||
      record.notifyingKinds.has(kind)
    ) {
      continue;
    }

    record.notifyingKinds.add(kind);
    let notificationPromise: Promise<boolean>;

    try {
      notificationPromise = Promise.resolve(
        notifyThreadAttention({
          environmentId: input.environmentId,
          threadId: input.threadId,
          threadTitle: input.threadTitle,
          kind,
        }),
      );
    } catch {
      record.notifyingKinds.delete(kind);
      continue;
    }

    void notificationPromise
      .then((shown) => {
        const currentRecord = threadAttentionRecords.get(key);
        if (currentRecord !== record) {
          return;
        }

        currentRecord.notifyingKinds.delete(kind);
        if (shown) {
          currentRecord.notifiedKinds.add(kind);
        }
      })
      .catch(() => {
        const currentRecord = threadAttentionRecords.get(key);
        if (currentRecord !== record) {
          return;
        }

        currentRecord.notifyingKinds.delete(kind);
      });
  }
}

export function processThreadAttentionShellUpsert(
  input: ThreadAttentionShellUpsert,
  settings: ThreadAttentionSettings,
  deps?: ThreadAttentionNotificationDeps,
): void {
  const key = getThreadAttentionRecordKey(input.environmentId, input.threadId);
  const nextState = deriveThreadAttentionState(input);
  if (nextState === null) {
    threadAttentionRecords.delete(key);
    return;
  }

  const record =
    threadAttentionRecords.get(key) ??
    (() => {
      const nextRecord: ThreadAttentionRecord = {
        environmentId: input.environmentId,
        state: nextState,
        notifiedKinds: new Set(),
        notifyingKinds: new Set(),
      };
      threadAttentionRecords.set(key, nextRecord);
      return nextRecord;
    })();
  record.environmentId = input.environmentId;
  record.state = nextState;

  notifyForThreadAttentionKinds(key, record, input, settings, deps);
}

export function reconcileThreadAttentionShellSnapshot(
  environmentId: EnvironmentId,
  threads: readonly ThreadAttentionShellUpsert[],
  settings: ThreadAttentionSettings,
  deps?: ThreadAttentionNotificationDeps,
): void {
  const retainedKeys = new Set<string>();

  for (const thread of threads) {
    retainedKeys.add(getThreadAttentionRecordKey(environmentId, thread.threadId));
    processThreadAttentionShellUpsert(thread, settings, deps);
  }

  for (const [key, record] of threadAttentionRecords) {
    if (record.environmentId === environmentId && !retainedKeys.has(key)) {
      threadAttentionRecords.delete(key);
    }
  }
}

export function clearThreadAttentionTrackingForThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): void {
  threadAttentionRecords.delete(getThreadAttentionRecordKey(environmentId, threadId));
}

export function clearThreadAttentionTrackingForEnvironment(environmentId: EnvironmentId): void {
  for (const [key, record] of threadAttentionRecords) {
    if (record.environmentId === environmentId) {
      threadAttentionRecords.delete(key);
    }
  }
}

export function __resetThreadAttentionNotificationsForTests(): void {
  threadAttentionRecords.clear();
}
