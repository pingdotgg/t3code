import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { makeAggregateState } from "./agentActivityAggregate.ts";
import {
  attentionTransitionRows,
  nextEnvironmentRevealedAt,
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
    expect(
      attentionTransitionRows({
        previousAggregate: aggregate([waiting]),
        nextAggregate: aggregate([waiting, other]),
        preferences: { ...preferences, mutedEnvironmentIds: [other.environmentId] },
      }),
    ).toEqual([]);
    const completed = { ...state, phase: "completed" as const };
    expect(
      terminalTransitionRows({
        previousAggregate: aggregate([state]),
        nextAggregate: aggregate([completed]),
        preferences: { ...preferences, mutedEnvironmentIds: [state.environmentId] },
        nowMs: 0,
      }),
    ).toEqual([]);
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
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, mutedEnvironmentIds: [state.environmentId] },
      }),
    ).toBe(false);
  });

  it("keeps activity from while an environment was off quiet after it is turned back on", () => {
    const revealedAt = Date.parse("1970-01-01T00:01:00.000Z");
    const revealed = {
      ...preferences,
      environmentRevealedAt: { [state.environmentId]: revealedAt },
    };
    const before = { ...state, phase: "waiting_for_approval" as const };
    const after = { ...before, updatedAt: "1970-01-01T00:01:00.001Z" };
    // The card's baseline still lacks the row, as it does before the registration replay lands.
    const transition = (row: RelayAgentActivityState) =>
      attentionTransitionRows({
        previousAggregate: aggregate([{ ...state, threadId: ThreadId.make("other") }]),
        nextAggregate: makeAggregateState({ activeStates: [row], terminalState: null, nowMs: 0 })!,
        preferences: revealed,
      });
    expect(transition(before)).toEqual([]);
    expect(transition(after)).toMatchObject([{ environmentId: state.environmentId }]);
    expect(shouldAlertForActivity({ ...before, preferences: revealed, nowMs: revealedAt })).toBe(
      false,
    );
    expect(shouldAlertForActivity({ ...after, preferences: revealed, nowMs: revealedAt })).toBe(
      true,
    );
  });

  it("records when each environment leaves the muted list", () => {
    expect(
      nextEnvironmentRevealedAt({
        previousMuted: ["a", "b"],
        previousRevealedAt: { c: 1, b: 2 },
        nextMuted: ["b"],
        nowMs: 5,
      }),
    ).toEqual({ a: 5, c: 1 });
    expect(
      nextEnvironmentRevealedAt({
        previousMuted: [],
        previousRevealedAt: null,
        nextMuted: [],
        nowMs: 5,
      }),
    ).toBeNull();
  });
});
