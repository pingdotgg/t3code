import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { makeAggregateState } from "./agentActivityAggregate.ts";
import {
  attentionTransitionRows,
  terminalTransitionRows,
  shouldAlertForActivity,
} from "./agentActivityAlerts.ts";

const state: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "Model",
  headline: "Working",
  phase: "running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const aggregate = (states: RelayAgentActivityState[]) =>
  makeAggregateState({ activeStates: states, terminalState: null, nowMs: 0 })!;

describe("shared agent activity policy", () => {
  it("prioritizes actionable results, counts capped rows, and preserves read results", () => {
    const make = (
      id: string,
      phase: RelayAgentActivityState["phase"],
      unread: boolean,
      updatedAt = state.updatedAt,
    ) => ({ ...state, threadId: ThreadId.make(id), phase, unread, updatedAt, retained: true });
    const states = [
      make("working", "running", false),
      make("read", "completed", false),
      make("done-old", "completed", true, "1969-12-31T23:59:00.000Z"),
      make("done-new", "completed", true),
      make("failed", "failed", true),
      make("input", "waiting_for_input", false),
      make("woke", "woke", false),
    ];
    expect(aggregate(states)).toMatchObject({
      activeCount: 3,
      workingCount: 1,
      attentionCount: 2,
      unreadCount: 2,
      pendingCount: 6,
      totalCount: 7,
      activities: [
        { threadId: "input" },
        { threadId: "woke", status: "Woke" },
        { threadId: "failed" },
        { threadId: "done-new" },
        { threadId: "done-old" },
      ],
    });
    expect(
      aggregate(states.filter((s) => s.threadId !== "done-old" && s.threadId !== "woke")),
    ).toMatchObject({
      totalCount: 5,
      activities: [
        { threadId: "input" },
        { threadId: "failed" },
        { threadId: "done-new" },
        { threadId: "working" },
        { threadId: "read", unread: false },
      ],
    });
    expect(aggregate([make("read", "completed", false)])).toMatchObject({
      totalCount: 1,
      activeCount: 0,
      unreadCount: 0,
      pendingCount: 0,
    });
  });

  it.each(["completed", "failed"] as const)(
    "keeps an unread modern %s pending alongside legacy results",
    (phase) => {
      const modern = {
        ...state,
        threadId: ThreadId.make("modern"),
        phase,
        unread: true,
        retained: true,
      };
      const legacy = { ...state, phase: "completed" as const };
      const mixed = aggregate([modern, legacy]);
      expect(mixed.pendingCount).toBe(2);
      expect(mixed.activeCount).toBe(0);
      expect(aggregate([legacy]).pendingCount).toBeUndefined();
    },
  );

  it("does not notify for already read results or marking a result unread again", () => {
    expect(shouldAlertForActivity({ ...state, phase: "woke", preferences, nowMs: 0 })).toBe(false);
    const woke = { ...state, phase: "woke" as const, retained: true };
    expect(
      makeAggregateState({
        activeStates: [woke],
        terminalState: null,
        nowMs: 2 * 24 * 60 * 60_000,
      }),
    ).toMatchObject({ workingCount: 0, attentionCount: 1, pendingCount: 1 });
    const done = { ...state, phase: "completed" as const, unread: false };
    expect(shouldAlertForActivity({ ...done, preferences, nowMs: 0 })).toBe(false);
    expect(
      terminalTransitionRows({
        previousAggregate: aggregate([state]),
        nextAggregate: aggregate([done]),
        preferences,
        nowMs: 0,
      }),
    ).toEqual([]);
    expect(
      terminalTransitionRows({
        previousAggregate: aggregate([done]),
        nextAggregate: aggregate([{ ...done, unread: true }]),
        preferences,
        nowMs: 0,
      }),
    ).toEqual([]);
  });

  it.each(["waiting_for_approval", "waiting_for_input"] as const)(
    "keeps an older %s ahead of five running rows",
    (phase) => {
      const running = Array.from({ length: 5 }, (_, i) => ({
        ...state,
        threadId: ThreadId.make(`running-${i}`),
      }));
      const waiting = { ...state, phase, updatedAt: "1969-12-31T23:59:00.000Z" };
      const next = aggregate([...running, waiting]);
      expect(next.activities[0]?.threadId).toBe(state.threadId);
      expect(next.activeCount).toBe(6);
      expect(next.activities).toHaveLength(5);
      expect(
        attentionTransitionRows({
          previousAggregate: aggregate(running),
          nextAggregate: next,
          preferences,
        }),
      ).toMatchObject([{ threadId: state.threadId }]);
    },
  );

  it("allows fresh unobserved completions for events, but not reconciliation or repeats", () => {
    const previousAggregate = aggregate([
      { ...state, threadId: ThreadId.make("old"), phase: "completed" },
    ]);
    const nextAggregate = aggregate([{ ...state, phase: "completed" }]);
    const input = { previousAggregate, nextAggregate, preferences, nowMs: 0 };
    expect(terminalTransitionRows(input)).toEqual([]);
    expect(terminalTransitionRows({ ...input, includeUnobserved: true })).toHaveLength(1);
    expect(
      terminalTransitionRows({
        ...input,
        includeUnobserved: true,
        previousAggregate: nextAggregate,
      }),
    ).toEqual([]);
    expect(terminalTransitionRows({ ...input, includeUnobserved: true, nowMs: 180_000 })).toEqual(
      [],
    );
  });

  it("distinguishes equal thread IDs across environments", () => {
    const waiting = { ...state, phase: "waiting_for_input" as const };
    const other = { ...waiting, environmentId: EnvironmentId.make("other") };
    expect(
      attentionTransitionRows({
        previousAggregate: aggregate([waiting]),
        nextAggregate: aggregate([waiting, other]),
        preferences,
      }),
    ).toMatchObject([{ environmentId: other.environmentId }]);
  });

  it("checks current permission, event preferences, and freshness together", () => {
    const input = { ...state, phase: "completed" as const, preferences, nowMs: 0 };
    expect(shouldAlertForActivity(input)).toBe(true);
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, notificationsEnabled: false },
      }),
    ).toBe(false);
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, notifyOnCompletion: false },
      }),
    ).toBe(false);
    expect(shouldAlertForActivity({ ...input, nowMs: 180_000 })).toBe(false);
  });
});
