import { describe, expect, it } from "vitest";
import {
  canSettle,
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  hasQueuedTurnStart,
  threadRaisedHandWhileSnoozed,
} from "./threadSettled.ts";

const now = "2026-07-30T00:00:00.000Z";
const baseThread = {
  id: "thread-1",
  projectId: "project-1",
  title: "Thread",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  hasPendingQueuedTurn: false,
};

describe("thread sidebar lifecycle", () => {
  it("does not settle active or queued work", () => {
    expect(canSettle({ ...baseThread, hasPendingApprovals: true }, { now })).toBe(false);
    expect(canSettle({ ...baseThread, hasPendingQueuedTurn: true }, { now })).toBe(false);
    expect(canSnooze({ ...baseThread, hasPendingQueuedTurn: true }, { now })).toBe(false);
    expect(
      hasQueuedTurnStart(
        { ...baseThread, latestUserMessageAt: "2026-07-30T00:01:00.000Z" },
        { now },
      ),
    ).toBe(true);
  });

  it("allows an idle running runtime but not a failed session", () => {
    expect(
      canSettle(
        {
          ...baseThread,
          session: { status: "running", updatedAt: now },
        },
        { now },
      ),
    ).toBe(true);
    expect(
      canSettle(
        {
          ...baseThread,
          session: { status: "error", updatedAt: now },
        },
        { now },
      ),
    ).toBe(false);
  });

  it("only applies explicit settlement in V1", () => {
    expect(effectiveSettled(baseThread, { now })).toBe(false);
    expect(effectiveSettled({ ...baseThread, settledOverride: "settled" }, { now })).toBe(true);
    expect(
      effectiveSettled(
        {
          ...baseThread,
          settledOverride: "settled",
          hasPendingApprovals: true,
        },
        { now },
      ),
    ).toBe(false);
  });

  it("allows snoozing a running agent but not work awaiting input", () => {
    expect(canSnooze(baseThread, { now })).toBe(true);
    expect(canSnooze({ ...baseThread, hasPendingUserInput: true }, { now })).toBe(false);
  });

  it("raises a snoozed thread when a completion arrives after the snooze", () => {
    const snoozed = {
      ...baseThread,
      snoozedAt: now,
      snoozedUntil: "2026-07-31T00:00:00.000Z",
      latestTurn: {
        turnId: "turn-1",
        state: "completed" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: "2026-07-30T00:01:00.000Z",
        assistantMessageId: null,
      },
    };
    expect(threadRaisedHandWhileSnoozed(snoozed)).toBe(true);
    expect(effectiveSnoozed(snoozed, { now })).toBe(false);
  });
});
