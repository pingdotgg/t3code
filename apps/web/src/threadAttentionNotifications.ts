import { scopedThreadKey, scopeThreadRef } from "@forma/client-runtime";
import type {
  ClientSettings,
  DesktopThreadAttentionKind,
  DesktopThreadAttentionNotification,
  EnvironmentId,
  ThreadId,
} from "@forma/contracts";

type ThreadAttentionState = "approval" | "user-input" | "both" | null;

type ThreadAttentionRecord = {
  environmentId: EnvironmentId;
  state: ThreadAttentionState;
  notifiedKinds: Set<DesktopThreadAttentionKind>;
  notifyingKinds: Set<DesktopThreadAttentionKind>;
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
  isDesktopNotificationsAvailable?: () => boolean;
  isWindowBackgrounded?: () => boolean;
  notifyThreadAttention?: (input: DesktopThreadAttentionNotification) => Promise<boolean> | boolean;
}

const threadAttentionRecords = new Map<string, ThreadAttentionRecord>();

function getDefaultDesktopNotificationsAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.desktopBridge?.notifyThreadAttention);
}

function getDefaultWindowBackgrounded(): boolean {
  return (
    typeof document !== "undefined" &&
    (document.visibilityState !== "visible" || !document.hasFocus())
  );
}

function notifyThreadAttentionViaDesktopBridge(
  input: DesktopThreadAttentionNotification,
): Promise<boolean> {
  if (typeof window === "undefined") {
    return Promise.resolve(false);
  }

  return Promise.resolve(window.desktopBridge?.notifyThreadAttention?.(input) ?? false);
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
): readonly DesktopThreadAttentionKind[] {
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
  kind: DesktopThreadAttentionKind,
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
  const isDesktopNotificationsAvailable =
    deps?.isDesktopNotificationsAvailable ?? getDefaultDesktopNotificationsAvailable;
  const isWindowBackgrounded = deps?.isWindowBackgrounded ?? getDefaultWindowBackgrounded;
  const notifyThreadAttention =
    deps?.notifyThreadAttention ?? notifyThreadAttentionViaDesktopBridge;

  if (!isDesktopNotificationsAvailable() || !isWindowBackgrounded()) {
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
