import type { DesktopUpdateState, OrchestrationSession } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  areDesktopUpdateEnvironmentsIdle,
  createDesktopUpdateScheduler,
  hasDesktopUpdateBlockingWork,
} from "./desktopUpdateScheduler";

const update: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "1.1.0",
  downloadedVersion: "1.1.0",
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};
const idleThread = {
  session: null,
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};
function session(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread"),
    status,
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-09-19T00:00:00Z",
  };
}
function harness() {
  const scheduler = createDesktopUpdateScheduler();
  scheduler.open(update);
  scheduler.schedule();
  return {
    scheduler,
    input: {
      whenIdle: true,
      isIdle: vi.fn(() => true),
      getUpdateState: vi.fn(async () => update),
      installUpdate: vi.fn(async () => ({ accepted: true, completed: true, state: update })),
      onError: vi.fn(),
    },
  };
}

describe("update activity guard", () => {
  it("treats a ready empty environment catalog as idle", () => {
    expect(
      areDesktopUpdateEnvironmentsIdle({
        catalogReady: true,
        environmentCount: 0,
        snapshotsReady: false,
        hasBlockingWork: false,
      }),
    ).toBe(true);
  });
  it("waits for catalog readiness, non-empty snapshots, and blocking work", () => {
    const input = {
      catalogReady: true,
      environmentCount: 1,
      snapshotsReady: true,
      hasBlockingWork: false,
    };
    expect(areDesktopUpdateEnvironmentsIdle({ ...input, catalogReady: false })).toBe(false);
    expect(areDesktopUpdateEnvironmentsIdle({ ...input, snapshotsReady: false })).toBe(false);
    expect(areDesktopUpdateEnvironmentsIdle({ ...input, hasBlockingWork: true })).toBe(false);
    expect(areDesktopUpdateEnvironmentsIdle(input)).toBe(true);
  });
  it("allows settled and unused threads", () => {
    expect(hasDesktopUpdateBlockingWork(idleThread)).toBe(false);
    for (const status of ["idle", "ready", "stopped", "interrupted", "error"] as const) {
      expect(hasDesktopUpdateBlockingWork({ ...idleThread, session: session(status) })).toBe(false);
    }
  });
  it("waits for starting and running agents, approvals, user input, and background work", () => {
    for (const status of ["starting", "running"] as const) {
      expect(hasDesktopUpdateBlockingWork({ ...idleThread, session: session(status) })).toBe(true);
    }
    expect(hasDesktopUpdateBlockingWork({ ...idleThread, hasPendingApprovals: true })).toBe(true);
    expect(hasDesktopUpdateBlockingWork({ ...idleThread, hasPendingUserInput: true })).toBe(true);
    for (const backgroundLiveness of ["working", "monitoring"] as const) {
      expect(hasDesktopUpdateBlockingWork({ ...idleThread, backgroundLiveness })).toBe(true);
    }
  });
});

describe("desktop update scheduling", () => {
  it("waits for work or disconnected environments, then installs once", async () => {
    const { scheduler, input } = harness();
    input.isIdle.mockReturnValue(false);
    await scheduler.install(input);
    expect(input.getUpdateState).not.toHaveBeenCalled();
    expect(scheduler.store.getState().scheduledVersion).toBe("1.1.0");
    input.isIdle.mockReturnValue(true);
    await Promise.all([scheduler.install(input), scheduler.install(input)]);
    await scheduler.install(input);
    expect(input.installUpdate).toHaveBeenCalledTimes(1);
    expect(scheduler.store.getState().scheduledVersion).toBeNull();
  });
  it("cancels while the updater state read is in flight", async () => {
    const { scheduler, input } = harness();
    let resolveRead: ((state: DesktopUpdateState) => void) | undefined;
    const pending = new Promise<DesktopUpdateState>((resolve) => {
      resolveRead = resolve;
    });
    input.getUpdateState.mockReturnValue(pending);
    const installing = scheduler.install(input);
    scheduler.cancel();
    resolveRead?.(update);
    await installing;
    expect(input.installUpdate).not.toHaveBeenCalled();
  });
  it("rechecks activity after reading the update state", async () => {
    const { scheduler, input } = harness();
    input.isIdle.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await scheduler.install(input);
    expect(input.installUpdate).not.toHaveBeenCalled();
    expect(scheduler.store.getState().scheduledVersion).toBe("1.1.0");
    await scheduler.install(input);
    expect(input.installUpdate).toHaveBeenCalledTimes(1);
  });
  it("never silently substitutes a different version", async () => {
    const { scheduler, input } = harness();
    input.getUpdateState.mockResolvedValue({ ...update, downloadedVersion: "1.2.0" });
    await scheduler.install(input);
    expect(input.installUpdate).not.toHaveBeenCalled();
    expect(input.onError).toHaveBeenCalledOnce();
    expect(scheduler.store.getState().scheduledVersion).toBeNull();
  });
  it("reports refusal and does not retry automatically", async () => {
    const { scheduler, input } = harness();
    input.installUpdate.mockResolvedValue({ accepted: false, completed: false, state: update });
    await scheduler.install(input);
    await scheduler.install(input);
    expect(input.installUpdate).toHaveBeenCalledTimes(1);
    expect(input.onError).toHaveBeenCalledOnce();
  });
  it("reports a failed IPC call and clears the schedule", async () => {
    const { scheduler, input } = harness();
    input.installUpdate.mockRejectedValue(new Error("Install failed"));
    await scheduler.install(input);
    expect(input.onError).toHaveBeenCalledWith("Install failed");
    expect(scheduler.store.getState()).toEqual({
      dialogVersion: null,
      scheduledVersion: null,
      installing: false,
    });
  });
  it("keeps the explicit update-now option while agents are working", async () => {
    const { scheduler, input } = harness();
    scheduler.open(update);
    input.isIdle.mockReturnValue(false);
    await scheduler.install({ ...input, whenIdle: false });
    expect(input.installUpdate).toHaveBeenCalledOnce();
    expect(scheduler.store.getState().scheduledVersion).toBeNull();
  });
});
