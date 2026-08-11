import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import {
  buildProjectTitleMap,
  EMPTY_THREAD_PHASE_SNAPSHOT,
  notifiableKind,
  reconcileThreadNotifications,
  threadNotificationKey,
  type ThreadNotificationSettings,
  type ThreadPhaseSnapshot,
} from "./desktopNotifications.logic";

const ENVIRONMENT_ID = "env-1" as EnvironmentId;
const PROJECT_ID = "project-1" as ProjectId;
const THREAD_ID = "thread-1" as ThreadId;

const ALL_ENABLED: ThreadNotificationSettings = {
  enabled: true,
  taskCompleted: true,
  taskFailed: true,
  approvalNeeded: true,
};

type ThreadPhaseFixture = "running" | "completed" | "failed" | "approval" | "input" | "unknown";

/**
 * Builds the smallest shell that drives `projectThreadAwareness` to the wanted
 * phase, so the tests exercise the real phase resolution rather than a stub.
 */
function makeThread(
  phase: ThreadPhaseFixture,
  overrides: {
    readonly threadId?: ThreadId;
    readonly archivedAt?: string | null;
    readonly backgroundLiveness?: "working" | "monitoring" | null;
  } = {},
): EnvironmentThreadShell {
  const base = {
    id: overrides.threadId ?? THREAD_ID,
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Fix flaky auth test",
    modelSelection: { provider: "codex", model: "gpt-5" },
    updatedAt: "2026-08-11T10:00:00.000Z",
    archivedAt: overrides.archivedAt ?? null,
    backgroundLiveness: overrides.backgroundLiveness ?? null,
    hasPendingApprovals: phase === "approval",
    hasPendingUserInput: phase === "input",
    latestTurn: null as unknown,
    session: null as unknown,
  };

  switch (phase) {
    case "running":
      return {
        ...base,
        session: { status: "running", providerName: "Codex", lastError: null },
        latestTurn: { state: "running", completedAt: null },
      } as unknown as EnvironmentThreadShell;
    case "completed":
      return {
        ...base,
        session: { status: "ready", providerName: "Codex", lastError: null },
        latestTurn: { state: "completed", completedAt: "2026-08-11T10:00:00.000Z" },
      } as unknown as EnvironmentThreadShell;
    case "failed":
      return {
        ...base,
        session: { status: "error", providerName: "Codex", lastError: "Provider crashed" },
      } as unknown as EnvironmentThreadShell;
    case "approval":
    case "input":
      return {
        ...base,
        session: { status: "running", providerName: "Codex", lastError: null },
        latestTurn: { state: "running", completedAt: null },
      } as unknown as EnvironmentThreadShell;
    case "unknown":
      return base as unknown as EnvironmentThreadShell;
  }
}

const PROJECT_TITLES = buildProjectTitleMap([
  { environmentId: ENVIRONMENT_ID, id: PROJECT_ID, title: "t3code" },
] as unknown as ReadonlyArray<never>);

function reconcile(
  previous: ThreadPhaseSnapshot,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  overrides: Partial<{
    settings: ThreadNotificationSettings;
    windowFocused: boolean;
    activeThreadRef: { environmentId: EnvironmentId; threadId: ThreadId } | null;
    readResponseText: () => string | null;
  }> = {},
) {
  return reconcileThreadNotifications({
    previous,
    threads,
    projectTitles: PROJECT_TITLES,
    settings: overrides.settings ?? ALL_ENABLED,
    windowFocused: overrides.windowFocused ?? false,
    activeThreadRef: overrides.activeThreadRef ?? null,
    ...(overrides.readResponseText ? { readResponseText: overrides.readResponseText } : {}),
  });
}

const KEY = threadNotificationKey({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID });

describe("notifiableKind", () => {
  it("announces terminal phases reached from an active phase", () => {
    expect(notifiableKind("running", "completed")).toBe("task-completed");
    expect(notifiableKind("running", "failed")).toBe("task-failed");
    expect(notifiableKind("running", "waiting_for_approval")).toBe("approval-needed");
    expect(notifiableKind("starting", "completed")).toBe("task-completed");
  });

  it("stays quiet when the thread was not previously active", () => {
    expect(notifiableKind("completed", "waiting_for_approval")).toBeNull();
    expect(notifiableKind("stale", "completed")).toBeNull();
    expect(notifiableKind(null, "completed")).toBeNull();
    expect(notifiableKind("running", null)).toBeNull();
  });

  it("does not treat an approval-to-approval or non-terminal move as news", () => {
    expect(notifiableKind("waiting_for_approval", "waiting_for_approval")).toBeNull();
    expect(notifiableKind("running", "running")).toBeNull();
    expect(notifiableKind("starting", "running")).toBeNull();
  });
});

describe("reconcileThreadNotifications", () => {
  it("seeds silently on first observation", () => {
    const result = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]);

    expect(result.notifications).toEqual([]);
    expect(result.next.get(KEY)).toBe("running");
  });

  it("seeds a thread that is already completed without notifying", () => {
    const result = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("completed")]);

    expect(result.notifications).toEqual([]);
    expect(result.next.get(KEY)).toBe("completed");
  });

  it("fires once when a running thread completes", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    const result = reconcile(seeded, [makeThread("completed")]);

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.kind).toBe("task-completed");
    expect(result.notifications[0]?.title).toBe("Completed");
    // The project name is deliberately absent from the banner.
    expect(result.notifications[0]?.body).not.toContain("t3code");
    expect(result.notifications[0]?.threadRef).toEqual({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
    });
  });

  it("uses the agent's response as the body, flattened to plain text", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    const result = reconcile(seeded, [makeThread("completed")], {
      readResponseText: () =>
        "## Done\n\nFixed the **flaky** `auth` test in [the suite](http://x).",
    });

    expect(result.notifications[0]?.body).toBe("Done Fixed the flaky auth test in the suite.");
  });

  it("falls back to the thread title when no response text is loaded", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    const result = reconcile(seeded, [makeThread("completed")], {
      readResponseText: () => null,
    });

    expect(result.notifications[0]?.body).toBe("Fix flaky auth test");
  });

  it("titles each kind by what happened", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;

    expect(reconcile(seeded, [makeThread("failed")]).notifications[0]?.title).toBe("Failed");
    expect(reconcile(seeded, [makeThread("approval")]).notifications[0]?.title).toBe(
      "Approval Required",
    );
  });

  it("does not announce completion while background work is still live", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    const working = reconcile(seeded, [makeThread("completed", { backgroundLiveness: "working" })]);

    expect(working.notifications).toEqual([]);
    // Held at running, so the real completion still reads as a transition.
    expect(working.next.get(KEY)).toBe("running");

    const monitoring = reconcile(working.next, [
      makeThread("completed", { backgroundLiveness: "monitoring" }),
    ]);
    expect(monitoring.notifications).toEqual([]);

    const settled = reconcile(monitoring.next, [makeThread("completed")]);
    expect(settled.notifications).toHaveLength(1);
    expect(settled.notifications[0]?.kind).toBe("task-completed");
  });

  it("does not re-fire while the thread sits in completed", () => {
    let phases = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    let fired = 0;

    for (let pass = 0; pass < 3; pass += 1) {
      const result = reconcile(phases, [makeThread("completed")]);
      fired += result.notifications.length;
      phases = result.next;
    }

    expect(fired).toBe(1);
  });

  it("fires again when the thread is re-run", () => {
    let phases = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    phases = reconcile(phases, [makeThread("completed")]).next;
    phases = reconcile(phases, [makeThread("running")]).next;

    const result = reconcile(phases, [makeThread("completed")]);
    expect(result.notifications).toHaveLength(1);
  });

  it("reports a failure with the provider error as the body", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    const result = reconcile(seeded, [makeThread("failed")]);

    expect(result.notifications[0]?.kind).toBe("task-failed");
    expect(result.notifications[0]?.title).toBe("Failed");
    expect(result.notifications[0]?.body).toBe("Provider crashed");
  });

  it("reports an approval prompt", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    const result = reconcile(seeded, [makeThread("approval")]);

    expect(result.notifications[0]?.kind).toBe("approval-needed");
  });

  it("does not re-fire when a phase disappears and comes back", () => {
    let phases = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    phases = reconcile(phases, [makeThread("completed")]).next;
    phases = reconcile(phases, [makeThread("unknown")]).next;
    expect(phases.get(KEY)).toBeNull();

    const result = reconcile(phases, [makeThread("completed")]);
    expect(result.notifications).toEqual([]);
  });

  it("suppresses the banner while the user watches that thread, but still advances", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    const result = reconcile(seeded, [makeThread("completed")], {
      windowFocused: true,
      activeThreadRef: { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID },
    });

    expect(result.notifications).toEqual([]);
    expect(result.next.get(KEY)).toBe("completed");

    // Navigating away later must not replay the suppressed transition.
    const afterNavigation = reconcile(result.next, [makeThread("completed")]);
    expect(afterNavigation.notifications).toEqual([]);
  });

  it("still notifies when focused on a different thread", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    const result = reconcile(seeded, [makeThread("completed")], {
      windowFocused: true,
      activeThreadRef: { environmentId: ENVIRONMENT_ID, threadId: "thread-2" as ThreadId },
    });

    expect(result.notifications).toHaveLength(1);
  });

  it("still notifies when that thread is open but the window is not focused", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    const result = reconcile(seeded, [makeThread("completed")], {
      windowFocused: false,
      activeThreadRef: { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID },
    });

    expect(result.notifications).toHaveLength(1);
  });

  it("filters by kind without backfilling once a toggle is turned on", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    const filtered = reconcile(seeded, [makeThread("completed")], {
      settings: { ...ALL_ENABLED, taskCompleted: false },
    });

    expect(filtered.notifications).toEqual([]);
    expect(filtered.next.get(KEY)).toBe("completed");

    const afterEnabling = reconcile(filtered.next, [makeThread("completed")]);
    expect(afterEnabling.notifications).toEqual([]);
  });

  it("filters everything when the master toggle is off but still advances", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    const result = reconcile(seeded, [makeThread("completed")], {
      settings: { ...ALL_ENABLED, enabled: false },
    });

    expect(result.notifications).toEqual([]);
    expect(result.next.get(KEY)).toBe("completed");
  });

  it("ignores archived threads entirely", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    const result = reconcile(seeded, [
      makeThread("completed", { archivedAt: "2026-08-11T09:00:00.000Z" }),
    ]);

    expect(result.notifications).toEqual([]);
    expect(result.next.has(KEY)).toBe(false);
  });

  it("prunes dropped threads and re-seeds them silently on return", () => {
    const seeded = reconcile(EMPTY_THREAD_PHASE_SNAPSHOT, [makeThread("running")]).next;
    const afterDrop = reconcile(seeded, []);
    expect(afterDrop.next.has(KEY)).toBe(false);

    const afterReturn = reconcile(afterDrop.next, [makeThread("completed")]);
    expect(afterReturn.notifications).toEqual([]);
    expect(afterReturn.next.get(KEY)).toBe("completed");
  });
});
