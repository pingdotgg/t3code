import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  alertForTransition,
  DIRECT_APNS_TERMINAL_FRESHNESS_MS,
  makePhaseTracker,
  notificationForState,
  type DirectApnsPreferences,
} from "./directApnsPolicy.ts";

const NOW_MS = Date.parse("2026-09-04T12:00:00.000Z");
const ALL_ON: DirectApnsPreferences = {
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

const state = (overrides: Partial<AgentAwarenessState> = {}): AgentAwarenessState => ({
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  projectTitle: "Project",
  threadTitle: "Fix the bug",
  phase: "running",
  headline: "Working",
  modelTitle: "Model",
  updatedAt: "2026-09-04T11:59:30.000Z",
  deepLink: "/threads/env-1/thread-1",
  ...overrides,
});

describe("phase tracker", () => {
  it("never alerts on the first observation of a thread", () => {
    const tracker = makePhaseTracker();
    const waiting = state({ phase: "waiting_for_approval" });
    expect(tracker.observe(waiting.threadId, waiting)).toEqual({ previous: undefined });
  });

  it("reports the previous phase and remembers the new one", () => {
    const tracker = makePhaseTracker();
    tracker.observe(ThreadId.make("thread-1"), state({ phase: "running" }));
    expect(tracker.observe(ThreadId.make("thread-1"), state({ phase: "completed" }))).toEqual({
      previous: "running",
    });
    expect(tracker.observe(ThreadId.make("thread-1"), state({ phase: "completed" }))).toEqual({
      previous: "completed",
    });
  });

  it("keeps the last phase while a thread projects to no activity", () => {
    const tracker = makePhaseTracker();
    const id = ThreadId.make("thread-1");
    tracker.observe(id, state({ phase: "running" }));
    expect(tracker.observe(id, null)).toEqual({ previous: "running" });
    expect(tracker.observe(id, state({ phase: "waiting_for_input" }))).toEqual({
      previous: "running",
    });
  });

  it("seeds a baseline without overriding an observed phase, and forgets deleted threads", () => {
    const tracker = makePhaseTracker();
    const id = ThreadId.make("thread-1");
    tracker.observe(id, state({ phase: "running" }));
    tracker.seed(id, state({ phase: "completed" }));
    expect(tracker.observe(id, state({ phase: "completed" }))).toEqual({ previous: "running" });
    tracker.forget(id);
    expect(tracker.observe(id, state({ phase: "completed" }))).toEqual({ previous: undefined });
    const other = ThreadId.make("thread-2");
    tracker.seed(other, state({ phase: "waiting_for_approval" }));
    expect(tracker.observe(other, state({ phase: "waiting_for_approval" }))).toEqual({
      previous: "waiting_for_approval",
    });
  });
});

describe("alertForTransition", () => {
  it.each(["waiting_for_approval", "waiting_for_input"] as const)(
    "alerts when a running thread starts %s",
    (phase) => {
      expect(
        alertForTransition({
          previous: "running",
          state: state({ phase }),
          preferences: ALL_ON,
          nowMs: NOW_MS,
        }),
      ).toBe(true);
    },
  );

  it("does not alert when moving between attention phases or staying put", () => {
    for (const [previous, phase] of [
      ["waiting_for_approval", "waiting_for_input"],
      ["waiting_for_input", "waiting_for_input"],
    ] as const) {
      expect(
        alertForTransition({
          previous,
          state: state({ phase }),
          preferences: ALL_ON,
          nowMs: NOW_MS,
        }),
      ).toBe(false);
    }
  });

  it.each(["completed", "failed"] as const)("alerts when a running thread %s", (phase) => {
    expect(
      alertForTransition({
        previous: "running",
        state: state({ phase }),
        preferences: ALL_ON,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("does not re-alert a thread that was already terminal", () => {
    expect(
      alertForTransition({
        previous: "completed",
        state: state({ phase: "failed" }),
        preferences: ALL_ON,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("does not alert on a first observation", () => {
    expect(
      alertForTransition({
        previous: undefined,
        state: state({ phase: "completed" }),
        preferences: ALL_ON,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("drops terminal alerts older than the freshness window but not attention alerts", () => {
    const stale = DateTime.formatIso(
      DateTime.makeUnsafe(NOW_MS - DIRECT_APNS_TERMINAL_FRESHNESS_MS - 1_000),
    );
    expect(
      alertForTransition({
        previous: "running",
        state: state({ phase: "completed", updatedAt: stale }),
        preferences: ALL_ON,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
    expect(
      alertForTransition({
        previous: "running",
        state: state({ phase: "waiting_for_input", updatedAt: stale }),
        preferences: ALL_ON,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("honours the device's notification preferences", () => {
    const decide = (phase: AgentAwarenessState["phase"], preferences: DirectApnsPreferences) =>
      alertForTransition({
        previous: "running",
        state: state({ phase }),
        preferences,
        nowMs: NOW_MS,
      });
    expect(decide("waiting_for_approval", { ...ALL_ON, notifyOnApproval: false })).toBe(false);
    expect(decide("waiting_for_input", { ...ALL_ON, notifyOnInput: false })).toBe(false);
    expect(decide("completed", { ...ALL_ON, notifyOnCompletion: false })).toBe(false);
    expect(decide("failed", { ...ALL_ON, notifyOnFailure: false })).toBe(false);
    expect(decide("completed", { ...ALL_ON, notificationsEnabled: false })).toBe(false);
  });

  it("ignores phases that are not alert-worthy", () => {
    for (const phase of ["starting", "running", "stale"] as const) {
      expect(
        alertForTransition({
          previous: "completed",
          state: state({ phase }),
          preferences: ALL_ON,
          nowMs: NOW_MS,
        }),
      ).toBe(false);
    }
  });
});

describe("notificationForState", () => {
  it("carries the fields the mobile app routes on", () => {
    expect(notificationForState(state({ phase: "waiting_for_approval" }))).toEqual({
      title: "Fix the bug",
      body: "Approval: Project",
      environmentId: "env-1",
      threadId: "thread-1",
      deepLink: "/threads/env-1/thread-1",
      phase: "waiting_for_approval",
      updatedAt: "2026-09-04T11:59:30.000Z",
    });
  });

  it("truncates long text and rejects off-app deep links", () => {
    const notification = notificationForState(
      state({ threadTitle: "t".repeat(400), projectTitle: "p".repeat(400), deepLink: "//evil" }),
    );
    expect(notification.title.length).toBe(120);
    expect(notification.title.endsWith("...")).toBe(true);
    expect(notification.body.length).toBe(120);
    expect(notification.deepLink).toBe("/");
  });
});
