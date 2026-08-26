import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  collectAgentTurnCompletions,
  type NotifiableThreadShell,
} from "./desktopAgentTurnNotifications";

const NOW = "2026-08-26T12:00:00.000Z";

function shell(overrides: Partial<NotifiableThreadShell> = {}): NotifiableThreadShell {
  return {
    environmentId: "env-1" as EnvironmentId,
    id: "thread-1" as ThreadId,
    title: "Fix failing CI",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    session: null,
    latestTurn: null,
    updatedAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function runningShell(overrides: Partial<NotifiableThreadShell> = {}): NotifiableThreadShell {
  return shell({
    session: {
      threadId: "thread-1" as ThreadId,
      status: "running",
      providerName: "Codex",
      runtimeMode: "full-access",
      activeTurnId: "turn-1" as TurnId,
      lastError: null,
      updatedAt: NOW,
    },
    ...overrides,
  });
}

function startingShell(overrides: Partial<NotifiableThreadShell> = {}): NotifiableThreadShell {
  return shell({
    session: {
      threadId: "thread-1" as ThreadId,
      status: "starting",
      providerName: "Codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    },
    ...overrides,
  });
}

function completedShell(overrides: Partial<NotifiableThreadShell> = {}): NotifiableThreadShell {
  return shell({
    latestTurn: {
      turnId: "turn-1" as TurnId,
      state: "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: null,
    },
    ...overrides,
  });
}

function failedShell(overrides: Partial<NotifiableThreadShell> = {}): NotifiableThreadShell {
  return shell({
    session: {
      threadId: "thread-1" as ThreadId,
      status: "error",
      providerName: "Codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "Provider process exited.",
      updatedAt: NOW,
    },
    ...overrides,
  });
}

const KEY = "env-1:thread-1";

describe("collectAgentTurnCompletions", () => {
  it("notifies once with the thread title on running to completed", () => {
    const first = collectAgentTurnCompletions(new Map(), [runningShell()]);
    expect(first.completions).toEqual([]);
    expect(first.nextPhases.get(KEY)).toBe("running");

    const second = collectAgentTurnCompletions(first.nextPhases, [completedShell()]);
    expect(second.completions).toEqual([{ threadKey: KEY, threadTitle: "Fix failing CI" }]);
    expect(second.nextPhases.get(KEY)).toBe("completed");
  });

  it("never notifies for a thread first observed as completed", () => {
    const result = collectAgentTurnCompletions(new Map(), [completedShell()]);
    expect(result.completions).toEqual([]);
    expect(result.nextPhases.get(KEY)).toBe("completed");
  });

  it("does not re-notify on completed to completed", () => {
    const first = collectAgentTurnCompletions(new Map(), [runningShell()]);
    const second = collectAgentTurnCompletions(first.nextPhases, [completedShell()]);
    expect(second.completions.length).toBe(1);

    const third = collectAgentTurnCompletions(second.nextPhases, [completedShell()]);
    expect(third.completions).toEqual([]);
  });

  it("carries the active phase across a transient null and notifies once", () => {
    const first = collectAgentTurnCompletions(new Map(), [runningShell()]);
    const nulled = collectAgentTurnCompletions(first.nextPhases, [shell()]);
    expect(nulled.completions).toEqual([]);
    expect(nulled.nextPhases.get(KEY)).toBe("running");

    const completed = collectAgentTurnCompletions(nulled.nextPhases, [completedShell()]);
    expect(completed.completions).toEqual([{ threadKey: KEY, threadTitle: "Fix failing CI" }]);
  });

  it("creates no entry and never notifies for a null-only thread", () => {
    const result = collectAgentTurnCompletions(new Map(), [shell()]);
    expect(result.completions).toEqual([]);
    expect(result.nextPhases.size).toBe(0);
  });

  it("drops removed threads and treats a reappearance as a fresh first observation", () => {
    const first = collectAgentTurnCompletions(new Map(), [runningShell()]);
    const removed = collectAgentTurnCompletions(first.nextPhases, []);
    expect(removed.nextPhases.size).toBe(0);

    const reappeared = collectAgentTurnCompletions(removed.nextPhases, [completedShell()]);
    expect(reappeared.completions).toEqual([]);
  });

  it("does not notify on failed to completed", () => {
    const first = collectAgentTurnCompletions(new Map(), [failedShell()]);
    expect(first.nextPhases.get(KEY)).toBe("failed");

    const second = collectAgentTurnCompletions(first.nextPhases, [completedShell()]);
    expect(second.completions).toEqual([]);
  });

  it("does not notify on the session-boot transient (starting to completed)", () => {
    const starting = collectAgentTurnCompletions(new Map(), [startingShell()]);
    expect(starting.nextPhases.get(KEY)).toBe("starting");

    const booted = collectAgentTurnCompletions(starting.nextPhases, [completedShell()]);
    expect(booted.completions).toEqual([]);

    const running = collectAgentTurnCompletions(booted.nextPhases, [runningShell()]);
    const finished = collectAgentTurnCompletions(running.nextPhases, [completedShell()]);
    expect(finished.completions).toEqual([{ threadKey: KEY, threadTitle: "Fix failing CI" }]);
  });

  it("notifies on waiting_for_approval to completed", () => {
    const first = collectAgentTurnCompletions(new Map(), [
      runningShell({ hasPendingApprovals: true }),
    ]);
    expect(first.nextPhases.get(KEY)).toBe("waiting_for_approval");

    const second = collectAgentTurnCompletions(first.nextPhases, [completedShell()]);
    expect(second.completions).toEqual([{ threadKey: KEY, threadTitle: "Fix failing CI" }]);
  });

  it("tracks the same threadId independently per environment", () => {
    const envA = "env-a" as EnvironmentId;
    const envB = "env-b" as EnvironmentId;
    const first = collectAgentTurnCompletions(new Map(), [
      runningShell({ environmentId: envA }),
      runningShell({ environmentId: envB }),
    ]);

    const second = collectAgentTurnCompletions(first.nextPhases, [
      completedShell({ environmentId: envA, title: "Ship the fix" }),
      runningShell({ environmentId: envB }),
    ]);
    expect(second.completions).toEqual([
      { threadKey: "env-a:thread-1", threadTitle: "Ship the fix" },
    ]);
    expect(second.nextPhases.get("env-b:thread-1")).toBe("running");
  });
});
