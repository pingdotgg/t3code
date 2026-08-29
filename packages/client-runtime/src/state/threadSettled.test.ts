import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadShell } from "@t3tools/contracts";

import { canSnooze, effectiveSnoozed, hasQueuedTurnStart, threadWokeAt } from "./threadSettled.ts";

const makeShell = (overrides: Partial<OrchestrationThreadShell> = {}) =>
  ({
    latestUserMessageAt: null,
    latestTurn: null,
    session: null,
    snoozedAt: null,
    snoozedUntil: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  }) as OrchestrationThreadShell;

describe("client snooze helpers", () => {
  it("blocks snooze while a recent message waits for turn adoption", () => {
    const thread = makeShell({ latestUserMessageAt: "2026-08-28T11:59:00.000Z" });
    const options = { now: "2026-08-28T12:00:00.000Z" };
    expect(hasQueuedTurnStart(thread, options)).toBe(true);
    expect(canSnooze(thread, options)).toBe(false);
  });

  it("expires queued state after two minutes", () => {
    const thread = makeShell({ latestUserMessageAt: "2026-08-28T11:57:59.000Z" });
    expect(hasQueuedTurnStart(thread, { now: "2026-08-28T12:00:00.000Z" })).toBe(false);
  });

  it("clears queued state when a turn adopts the message or the session fails", () => {
    const messageAt = "2026-08-28T11:59:00.000Z";
    const adopted = makeShell({
      latestUserMessageAt: messageAt,
      latestTurn: {
        requestedAt: messageAt,
        startedAt: null,
        completedAt: null,
      } as NonNullable<OrchestrationThreadShell["latestTurn"]>,
    });
    const failed = makeShell({
      latestUserMessageAt: messageAt,
      session: { status: "error" } as NonNullable<OrchestrationThreadShell["session"]>,
    });
    const options = { now: "2026-08-28T12:00:00.000Z" };
    expect(hasQueuedTurnStart(adopted, options)).toBe(false);
    expect(hasQueuedTurnStart(failed, options)).toBe(false);
  });

  it("bounds future client clock skew", () => {
    const farAhead = makeShell({ latestUserMessageAt: "2026-08-28T12:03:00.000Z" });
    const slightlyAhead = makeShell({ latestUserMessageAt: "2026-08-28T12:01:00.000Z" });
    const options = { now: "2026-08-28T12:00:00.000Z" };
    expect(hasQueuedTurnStart(farAhead, options)).toBe(false);
    expect(hasQueuedTurnStart(slightlyAhead, options)).toBe(true);
  });

  it("classifies a future snooze until its timer wakes", () => {
    const thread = makeShell({
      snoozedAt: "2026-08-28T11:00:00.000Z",
      snoozedUntil: "2026-08-28T13:00:00.000Z",
    });
    expect(effectiveSnoozed(thread, { now: "2026-08-28T12:00:00.000Z" })).toBe(true);
    expect(threadWokeAt(thread, { now: "2026-08-28T13:00:00.000Z" })).toBe(
      "2026-08-28T13:00:00.000Z",
    );
  });

  it("wakes on a completion newer than the snooze", () => {
    const thread = makeShell({
      snoozedAt: "2026-08-28T11:00:00.000Z",
      snoozedUntil: "2026-08-29T00:00:00.000Z",
      latestTurn: {
        state: "completed",
        completedAt: "2026-08-28T11:30:00.000Z",
      } as NonNullable<OrchestrationThreadShell["latestTurn"]>,
    });
    expect(effectiveSnoozed(thread, { now: "2026-08-28T12:00:00.000Z" })).toBe(false);
    expect(threadWokeAt(thread, { now: "2026-08-28T12:00:00.000Z" })).toBe(
      "2026-08-28T11:30:00.000Z",
    );
  });
});
