import { afterEach, describe, expect, it, vi } from "vitest";
import { type DesktopThreadAttentionNotification, EnvironmentId, ThreadId } from "@forma/contracts";

import {
  __resetThreadAttentionNotificationsForTests,
  processThreadAttentionShellUpsert,
  reconcileThreadAttentionShellSnapshot,
  type ThreadAttentionNotificationDeps,
  type ThreadAttentionShellUpsert,
} from "./threadAttentionNotifications";

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const TEST_THREAD_ID = ThreadId.make("thread-1");
type NotifyThreadAttentionMock = ReturnType<
  typeof vi.fn<(input: DesktopThreadAttentionNotification) => Promise<boolean>>
>;

function makeSettings(input?: { approval?: boolean; userInput?: boolean }): {
  desktopNotifyOnApprovalRequests: boolean;
  desktopNotifyOnUserInputRequests: boolean;
} {
  return {
    desktopNotifyOnApprovalRequests: input?.approval ?? true,
    desktopNotifyOnUserInputRequests: input?.userInput ?? true,
  };
}

function makeThread(input?: Partial<ThreadAttentionShellUpsert>): ThreadAttentionShellUpsert {
  return {
    environmentId: TEST_ENVIRONMENT_ID,
    threadId: TEST_THREAD_ID,
    threadTitle: "Review config",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...input,
  };
}

function createDeps(
  overrides?: Omit<Partial<ThreadAttentionNotificationDeps>, "notifyThreadAttention"> & {
    notifyThreadAttention?: NotifyThreadAttentionMock;
  },
): ThreadAttentionNotificationDeps & {
  notifyThreadAttention: NotifyThreadAttentionMock;
} {
  const notifyThreadAttention = vi
    .fn<(input: DesktopThreadAttentionNotification) => Promise<boolean>>()
    .mockResolvedValue(true);

  return {
    isDesktopNotificationsAvailable: () => true,
    isWindowBackgrounded: () => true,
    notifyThreadAttention,
    ...overrides,
  };
}

afterEach(() => {
  __resetThreadAttentionNotificationsForTests();
  vi.restoreAllMocks();
});

describe("threadAttentionNotifications", () => {
  it("suppresses notifications while the window is focused", () => {
    const deps = createDeps({ isWindowBackgrounded: () => false });

    processThreadAttentionShellUpsert(
      makeThread({ hasPendingApprovals: true }),
      makeSettings(),
      deps,
    );

    expect(deps.notifyThreadAttention).not.toHaveBeenCalled();
  });

  it("suppresses approval notifications when the approval toggle is disabled", () => {
    const deps = createDeps();

    processThreadAttentionShellUpsert(
      makeThread({ hasPendingApprovals: true }),
      makeSettings({ approval: false }),
      deps,
    );

    expect(deps.notifyThreadAttention).not.toHaveBeenCalled();
  });

  it("suppresses user-input notifications when the question toggle is disabled", () => {
    const deps = createDeps();

    processThreadAttentionShellUpsert(
      makeThread({ hasPendingUserInput: true }),
      makeSettings({ userInput: false }),
      deps,
    );

    expect(deps.notifyThreadAttention).not.toHaveBeenCalled();
  });

  it("notifies once when a thread first enters approval-required state", () => {
    const deps = createDeps();
    const thread = makeThread({ hasPendingApprovals: true });

    processThreadAttentionShellUpsert(thread, makeSettings(), deps);
    processThreadAttentionShellUpsert(thread, makeSettings(), deps);

    expect(deps.notifyThreadAttention).toHaveBeenCalledTimes(1);
    expect(deps.notifyThreadAttention).toHaveBeenCalledWith({
      environmentId: TEST_ENVIRONMENT_ID,
      threadId: TEST_THREAD_ID,
      threadTitle: "Review config",
      kind: "approval",
    });
  });

  it("notifies once when a thread first enters user-input-required state", () => {
    const deps = createDeps();
    const thread = makeThread({ hasPendingUserInput: true });

    processThreadAttentionShellUpsert(thread, makeSettings(), deps);
    processThreadAttentionShellUpsert(thread, makeSettings(), deps);

    expect(deps.notifyThreadAttention).toHaveBeenCalledTimes(1);
    expect(deps.notifyThreadAttention).toHaveBeenCalledWith({
      environmentId: TEST_ENVIRONMENT_ID,
      threadId: TEST_THREAD_ID,
      threadTitle: "Review config",
      kind: "user-input",
    });
  });

  it("emits one notification per actionable kind when a thread enters both pending states", () => {
    const deps = createDeps();

    processThreadAttentionShellUpsert(
      makeThread({ hasPendingApprovals: true, hasPendingUserInput: true }),
      makeSettings(),
      deps,
    );

    expect(deps.notifyThreadAttention).toHaveBeenCalledTimes(2);
    expect(deps.notifyThreadAttention.mock.calls[0]?.[0]).toMatchObject({ kind: "approval" });
    expect(deps.notifyThreadAttention.mock.calls[1]?.[0]).toMatchObject({ kind: "user-input" });
  });

  it("emits only the newly actionable kind when a thread transitions from approval to both", () => {
    const deps = createDeps();

    processThreadAttentionShellUpsert(
      makeThread({ hasPendingApprovals: true }),
      makeSettings(),
      deps,
    );
    processThreadAttentionShellUpsert(
      makeThread({ hasPendingApprovals: true, hasPendingUserInput: true }),
      makeSettings(),
      deps,
    );

    expect(deps.notifyThreadAttention).toHaveBeenCalledTimes(2);
    expect(deps.notifyThreadAttention.mock.calls[0]?.[0]).toMatchObject({ kind: "approval" });
    expect(deps.notifyThreadAttention.mock.calls[1]?.[0]).toMatchObject({ kind: "user-input" });
  });

  it("clears notification state once the thread fully leaves pending status", () => {
    const deps = createDeps();

    processThreadAttentionShellUpsert(
      makeThread({ hasPendingApprovals: true }),
      makeSettings(),
      deps,
    );
    processThreadAttentionShellUpsert(makeThread(), makeSettings(), deps);
    processThreadAttentionShellUpsert(
      makeThread({ hasPendingApprovals: true }),
      makeSettings(),
      deps,
    );

    expect(deps.notifyThreadAttention).toHaveBeenCalledTimes(2);
  });

  it("does not spam repeated snapshot reconciliations for the same pending state", () => {
    const deps = createDeps();
    const threads = [makeThread({ hasPendingApprovals: true })];

    reconcileThreadAttentionShellSnapshot(TEST_ENVIRONMENT_ID, threads, makeSettings(), deps);
    reconcileThreadAttentionShellSnapshot(TEST_ENVIRONMENT_ID, threads, makeSettings(), deps);

    expect(deps.notifyThreadAttention).toHaveBeenCalledTimes(1);
  });
});
